# Model Router Plugin Design Spec

> Date: 2026-03-20
> Status: Implemented
> Based on: OpenClaw v2026.3.14

---

## 1. Problem

Enterprise users running their own OpenClaw instances want to route different tasks to different LLM models. For example: simple Q&A to a local Ollama model, coding tasks to Claude Opus, translation to Gemini. Switching the main agent's model mid-session wastes tokens (full context re-injection), so the solution must use subagent delegation instead.

Users need to define routing rules themselves in natural language. Ops only provides the environment (installs the plugin, configures provider credentials). Prompt-based rule injection is blocked by OpenClaw's security layer, so rules must be managed through a mechanism that bypasses prompt injection checks.

## 2. Solution

A lightweight OpenClaw plugin with three components:

1. **Slash command** (`/route`) -- CRUD for natural language routing rules, bypasses LLM via `api.registerCommand()`
2. **Prompt injection** -- `before_prompt_build` hook appends rules to system prompt via `appendSystemContext`
3. **Subagent delegation** -- Main agent reads injected rules, decides when to call `sessions_spawn(model="...", task="...")` to delegate tasks to appropriate models

The main agent's own model never changes. When a task matches a rule requiring a different model, the main agent spawns a subagent with that model. When no rule matches or the task fits the current model, the main agent handles it directly.

## 3. Architecture

```
[User] --"/route add ..."--> [Slash Command Handler] --> [Rules Store (JSON file)]
                                                              |
[User] --"帮我翻译"--> [before_prompt_build hook] --reads rules--> [appendSystemContext]
                              |
                       [Main Agent sees rules in system prompt]
                              |
                       [Main Agent calls sessions_spawn(model=..., task=...)]
                              |
                       [Subagent runs with specified model, returns result]
```

### Runtime Flow

1. **Startup**: `register(api)` synchronously registers slash command + `before_prompt_build` hook
2. **Rule management**: `/route add/list/remove/clear` directly reads/writes a local JSON file. No LLM involved, no tokens consumed.
3. **Each agent run**: `before_prompt_build` hook reads the rules file, builds an instruction block, appends it to the system prompt via `appendSystemContext`
4. **Task routing**: Main agent evaluates the task against the injected rules. If a rule matches and specifies a different model, it calls `sessions_spawn(model="provider/modelId", task="...")`. The `model` parameter is a native feature of `sessions_spawn` (verified in `sessions-spawn-tool.ts`).
5. **No rules**: When the user has no rules configured, the hook injects nothing. Zero overhead.

## 4. Slash Command Interface

```
/route add <natural language rule>     Add a rule
/route list                            List all rules
/route remove <number>                 Remove rule by number
/route clear                           Clear all rules
```

### Interaction Examples

```
User: /route add simple Q&A use ollama/llama3.3:8b
Bot:  Added rule #1: simple Q&A use ollama/llama3.3:8b

User: /route add coding tasks use anthropic/claude-opus-4-5
Bot:  Added rule #2: coding tasks use anthropic/claude-opus-4-5

User: /route list
Bot:  Current routing rules:
      1. simple Q&A use ollama/llama3.3:8b
      2. coding tasks use anthropic/claude-opus-4-5

User: /route remove 1
Bot:  Removed rule #1

User: /route clear
Bot:  Cleared all routing rules
```

### Implementation

- Registered via `api.registerCommand()` which completely bypasses LLM processing
- Not subject to prompt injection checks
- Subcommand parsing: split on first space to get subcommand (`add`/`list`/`remove`/`clear`), remainder is the argument

## 5. Rules Storage

**Location**: `~/.openclaw/plugins/model-router/rules.json` (computed as `os.homedir()/.openclaw/plugins/model-router/rules.json`, shared across all agents in a single instance)

**Format**:
```json
{
  "rules": [
    { "id": 1, "text": "simple Q&A use ollama/llama3.3:8b" },
    { "id": 2, "text": "coding tasks use anthropic/claude-opus-4-5" }
  ],
  "nextId": 3
}
```

**Design decisions**:
- Per-user instance (each employee has their own OpenClaw instance with its own workspace)
- Survives gateway restarts (persisted to filesystem)
- Auto-incrementing IDs for stable `/route remove` references
- File missing or corrupt -> initialize as empty rules list

## 6. System Prompt Injection

### Hook Registration

```typescript
api.on("before_prompt_build", (_event, _ctx) => {
  const data = loadRulesSync(rulesFilePath);  // rulesFilePath captured via closure in register()
  if (data.rules.length === 0) return undefined;
  return {
    appendSystemContext: buildRoutingPrompt(data.rules),
  };
}, { priority: 0 });
```

### Injected Text Template (when rules exist)

```
## Model Routing Rules

The user has configured the following model routing rules. For each incoming task:

1. Evaluate which rule best matches the task
2. If a matching rule specifies a different model than your current model, delegate the task by calling sessions_spawn with the specified model
3. If no rule matches or the task fits your current model, handle it directly

Rules:
1. simple Q&A use ollama/llama3.3:8b
2. coding tasks use anthropic/claude-opus-4-5

When delegating, use: sessions_spawn(model="<model from rule>", runtime="subagent", task="<clear task description>")
Do NOT use runtime="acp" -- model selection only works with the subagent runtime.
```

### Design Decisions

- **`appendSystemContext`** not `systemPrompt` -- appends to existing prompt, coexists with other plugins
- **English instructions** -- more stable at the system prompt level; user rules remain in their original language
- **Fixed template** -- only the rules list is dynamic
- **Explicit `runtime="subagent"`** -- the `model` parameter in `sessions_spawn` is only forwarded for `runtime="subagent"`, silently ignored for `runtime="acp"`. Template explicitly specifies this.
- **Sync file I/O** -- `loadRulesSync` uses `fs.readFileSync` in the hook handler. This is a hot-path per-request call, but acceptable at this scale (one small JSON file, single user instance).
- **`workspaceDir` fallback** -- `ctx.workspaceDir` is optional in the hook context type. Falls back to `process.cwd()` when undefined (e.g., cron/heartbeat triggers).
- **Token cost**: ~50-80 fixed tokens + ~10-20 per rule. Zero cost when no rules exist.

## 7. Plugin File Structure

```
model-router/
  package.json              - Package metadata, peerDependencies: openclaw
  openclaw.plugin.json      - Plugin manifest (just { "id": "model-router" })
  index.ts                  - definePluginEntry, register command + hook (~60 lines)
  src/
    rules-store.ts          - CRUD operations + JSON file I/O (~50 lines)
    prompt-inject.ts        - Build injection text template (~30 lines)
```

**Total**: ~140 lines of TypeScript

**Dependencies**: Zero external. Only Node.js built-in `fs` and `path`, plus `openclaw/plugin-sdk/plugin-entry`.

## 8. Error Handling

| Scenario | Behavior |
|----------|----------|
| `/route add` with no content | Reply with usage hint |
| `/route remove` invalid number | Reply "rule not found" |
| Rules file missing (first use) | Initialize empty rules list |
| Rules file corrupt | Initialize empty rules list, log warning |
| Rules file write failure | Reply with error message, main agent unaffected |
| `ctx.workspaceDir` undefined | Falls back to `process.cwd()` |
| `allowPromptInjection` not set | Hook silently dropped -- documented in ops installation steps |
| `before_prompt_build` hook throws | Caught by OpenClaw's double safety net (hook runner + call site), main agent runs without routing rules |
| Target provider not configured | `sessions_spawn` reports error normally, main agent informs user |
| Subagent timeout/failure | OpenClaw's built-in subagent error handling takes over |
| Main agent misjudges and spawns unnecessarily | Extra token cost but correct result |

**Design principle**: The plugin never retries or does complex error recovery. Rule read failure = silent degradation to no routing. Subagent failure = defer to OpenClaw native mechanisms.

## 9. Ops Installation

**Step 1**: Copy plugin directory
```bash
cp -r model-router/ ~/.openclaw/extensions/model-router/
```

**Step 2**: Add to allow list and enable prompt injection (config.yaml)
```yaml
plugins:
  allow:
    - model-router
  entries:
    model-router:
      hooks:
        allowPromptInjection: true
```

`allowPromptInjection: true` is required because the plugin uses `before_prompt_build` to append routing instructions to the system prompt. Without this flag, the hook is silently dropped by OpenClaw's security layer.

**Step 3**: Restart gateway

No other `plugins.entries.model-router.config` needed.

Provider credentials (Anthropic, OpenAI, Ollama, etc.) are configured as part of normal OpenClaw deployment, independent of this plugin.

## 10. Constraints & Limitations

| Constraint | Impact | Mitigation |
|------------|--------|------------|
| `sessions_spawn` model resolution bypasses hooks | Plugin cannot intercept subagent model selection programmatically | Not needed -- main agent sets model via `sessions_spawn(model=...)` parameter directly |
| Main agent interprets rules via LLM | Routing decisions may occasionally be inconsistent | Acceptable trade-off for natural language flexibility |
| Rules consume system prompt tokens | ~50-80 fixed + ~10-20/rule | Negligible; zero cost when no rules |
| Subagent has no session history | Delegated tasks start fresh | Main agent should include sufficient context in the `task` parameter |
| One-shot model selection | Cannot change subagent model mid-run | Subagent runs are typically short, single-task |

## 11. Future Extensions (Not In Scope)

- Rule templates / presets (e.g., `/route preset coding` loads a standard set)
- Rule import/export between instances
- Usage statistics (which rules triggered, token costs)
- Model availability checking before delegation
- CLI subcommand for ops to view all users' rules
