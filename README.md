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

## Supported Platforms

Works on all platforms supported by OpenClaw: **macOS**, **Linux**, and **Windows**.

## Installation

### Prerequisites

- OpenClaw v2026.3.0+ installed and running (via `npm install -g openclaw` or platform installer)
- At least one model provider configured (Anthropic, OpenAI, Ollama, etc.)

### Step 1: Install the plugin

```bash
openclaw plugins install /path/to/model-router
```

Or from this repo:

```bash
git clone https://github.com/sputnicyoji/openclaw_modleRouterPlugin.git
openclaw plugins install openclaw_modleRouterPlugin/model-router
```

### Step 2: Enable prompt injection

```bash
openclaw config set plugins.entries.model-router.hooks.allowPromptInjection true
```

`allowPromptInjection: true` is **required** -- without it, OpenClaw's security layer silently drops the `before_prompt_build` hook and routing rules will never be injected.

### Step 3: Restart the gateway

```bash
openclaw gateway stop
openclaw gateway start
```

### Step 4: Verify

In any connected channel (Telegram, Discord, Web UI, etc.):

```
/route add test rule
```

If you see `Added rule #1: test rule`, the plugin is working. Clean up with `/route remove 1`.

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

### How Routing Happens

1. You define rules via `/route add` (bypasses LLM, no token cost)
2. On every message, rules are injected into the main agent's system prompt as mandatory instructions
3. The main agent checks if any rule matches the incoming task
4. If a rule matches, the agent **must** spawn a subagent via `sessions_spawn(model="...", task="...")` -- it is forbidden from answering the task itself
5. The subagent runs with the specified model, returns the result
6. If no rule matches, the main agent handles the task directly

The main agent's model **never switches** -- delegation happens via subagent, avoiding token waste from context re-injection.

## Architecture

| Component | Mechanism | Purpose |
|-----------|-----------|---------|
| `/route` command | `api.registerCommand()` | CRUD rules, bypasses LLM |
| Prompt injection | `before_prompt_build` hook | Appends rules to system prompt via `appendSystemContext` |
| Task delegation | `sessions_spawn(model=...)` | Main agent spawns subagent with target model |
| In-memory cache | Closure in `register()` | Hot-path hook reads cache, no disk I/O per message |

~140 lines of TypeScript, zero external dependencies.

## Testing

**Unit tests** (standalone, no OpenClaw dependency):

```bash
cd model-router && npx vitest run
# 12 tests: rules-store CRUD (8) + prompt-inject output (4)
```

**Integration tests** (requires OpenClaw source with `pnpm install`):

```bash
# Copy test files into OpenClaw source tree
cp tests/integration.test.ts openclaw/src/plugins/model-router-integration.test.ts
cp tests/loader.test.ts openclaw/src/plugins/model-router-loader.test.ts
cp tests/cache.test.ts openclaw/src/plugins/model-router-cache.test.ts

# Run
cd openclaw && npx vitest run src/plugins/model-router-integration.test.ts src/plugins/model-router-loader.test.ts src/plugins/model-router-cache.test.ts

# Clean up
rm openclaw/src/plugins/model-router-*.test.ts
```

Integration tests verify: real plugin loader (jiti), hook runner, command registration, cache refresh, multi-plugin coexistence, and error isolation.

See [tests/README.md](tests/README.md) for details.

## Troubleshooting

| Symptom | Cause | Fix |
|---------|-------|-----|
| `/route` command not recognized | Plugin not loaded | Check `plugins.allow` includes `"model-router"` and restart gateway |
| Rules added but agent doesn't delegate | `allowPromptInjection` not set | Add `hooks.allowPromptInjection: true` in plugin entry config |
| `sessions_spawn` fails with model error | Target provider not configured | Ensure the provider has valid API key in OpenClaw config |
| Agent delegates but subagent fails | Model ID incorrect | Check model ID format: `provider/model-id` (e.g., `ollama/llama3.3:8b`) |

## Design Decisions

- **No model switching on main agent** -- avoids token waste from re-injecting full session context into a new model
- **LLM interprets rules** -- natural language rules are injected into the system prompt; the main agent decides when to delegate (more flexible than keyword matching)
- **Slash commands bypass prompt injection checks** -- `api.registerCommand()` runs outside the LLM pipeline, so rules can be managed without triggering OpenClaw's security layer
- **In-memory cache** -- rules loaded from disk once at startup, refreshed only on write commands; the per-message hook reads from memory

## Project Structure

```
model-router/                  # The plugin (copy this to install)
  package.json
  openclaw.plugin.json
  index.ts                     - Plugin entry: /route command + prompt hook + cache
  src/
    rules-store.ts             - CRUD operations + JSON file persistence
    prompt-inject.ts           - Builds routing instruction text for system prompt

tests/                         # Integration tests (run inside OpenClaw source tree)
  integration.test.ts          - Hook runner + command handler tests
  loader.test.ts               - Real plugin loader (jiti) verification
  cache.test.ts                - Cache refresh mechanism tests

docs/                          # Research and design documentation
```

## Documentation

- [Design Spec](docs/superpowers/specs/2026-03-20-model-router-plugin-design.md)
- [Implementation Plan](docs/superpowers/plans/2026-03-20-model-router-plugin.md)
- [OpenClaw Architecture Analysis](docs/openclaw-analysis-report.md)

## License

MIT
