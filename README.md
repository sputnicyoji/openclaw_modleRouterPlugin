# OpenClaw Model Router Plugin

[中文文档](README.zh-CN.md)

A lightweight OpenClaw plugin that lets users define natural language model routing rules. When a task matches a rule, the main agent delegates it to a subagent running the specified model -- no model switching, no wasted tokens.

## How It Works

```
User: /route add simple Q&A use ollama/llama3.3:8b
User: /route add coding tasks use anthropic/claude-opus-4-5

User: Help me translate this article
  -> Main agent sees routing rules in system prompt
  -> Matches "translation" -> spawns subagent with specified model
  -> Subagent completes task, result returned to user
```

The main agent's model never changes. Tasks requiring a different model are delegated via OpenClaw's native `sessions_spawn(model=...)` tool.

## Installation

**Step 1:** Copy the plugin directory

```bash
cp -r model-router/ ~/.openclaw/extensions/model-router/
```

**Step 2:** Configure (config.yaml)

```yaml
plugins:
  allow:
    - model-router
  entries:
    model-router:
      hooks:
        allowPromptInjection: true
```

`allowPromptInjection: true` is required because the plugin appends routing instructions to the system prompt via the `before_prompt_build` hook.

**Step 3:** Restart the gateway

## Usage

```
/route add <rule>        Add a routing rule (natural language)
/route list              List all rules
/route remove <number>   Remove a rule by number
/route clear             Clear all rules
```

### Examples

```
/route add simple Q&A use ollama/llama3.3:8b
/route add code review use anthropic/claude-opus-4-5
/route add translation use google/gemini-2.5-flash
/route add complex reasoning use anthropic/claude-opus-4-6
```

Rules are stored locally at `~/.openclaw/plugins/model-router/rules.json` and persist across gateway restarts.

## Architecture

| Component | Mechanism | Purpose |
|-----------|-----------|---------|
| `/route` command | `api.registerCommand()` | CRUD rules, bypasses LLM |
| Prompt injection | `before_prompt_build` hook | Appends rules to system prompt |
| Task delegation | `sessions_spawn(model=...)` | Main agent spawns subagent with target model |

The plugin is ~140 lines of TypeScript with zero external dependencies.

## Testing

**Unit tests** (standalone, no OpenClaw dependency):

```bash
cd model-router && npx vitest run
# 11 tests: rules-store CRUD (7) + prompt-inject output (4)
```

**Integration tests** (requires OpenClaw source with `pnpm install`):

```bash
cp tests/integration.test.ts openclaw/src/plugins/model-router-integration.test.ts
cd openclaw && npx vitest run src/plugins/model-router-integration.test.ts
# 8 tests: hook injection, multi-plugin coexistence, error isolation, end-to-end
```

See [tests/README.md](tests/README.md) for details.

## Requirements

- OpenClaw v2026.3.0+
- Target model providers must be configured with valid credentials

## Design Decisions

- **No model switching on main agent** -- avoids token waste from re-injecting full session context into a new model
- **LLM interprets rules** -- natural language rules are injected into the system prompt; the main agent decides when to delegate (more flexible than keyword matching)
- **Slash commands bypass prompt injection checks** -- `api.registerCommand()` runs outside the LLM pipeline, so rules can be managed without triggering OpenClaw's security layer

## Project Structure

```
model-router/
  package.json
  openclaw.plugin.json
  index.ts                 - Plugin entry: registers /route command + prompt hook
  src/
    rules-store.ts         - CRUD operations + JSON file persistence
    prompt-inject.ts       - Builds routing instruction text for system prompt
```

## Documentation

- [Design Spec](docs/superpowers/specs/2026-03-20-model-router-plugin-design.md)
- [Implementation Plan](docs/superpowers/plans/2026-03-20-model-router-plugin.md)
- [OpenClaw Architecture Analysis](docs/openclaw-analysis-report.md)

## License

MIT
