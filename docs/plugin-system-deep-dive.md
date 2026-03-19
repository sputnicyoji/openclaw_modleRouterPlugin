# OpenClaw Plugin System Deep Dive

> Date: 2026-03-19
> Version: OpenClaw v2026.3.14
> Focus: Plugin loading lifecycle, hook system internals, configuration management

---

## Table of Contents

1. [Plugin Loading Lifecycle](#1-plugin-loading-lifecycle)
2. [Plugin Discovery & Path Resolution](#2-plugin-discovery--path-resolution)
3. [Plugin Enable/Disable State Machine](#3-plugin-enabledisable-state-machine)
4. [Configuration-Driven Plugin Management](#4-configuration-driven-plugin-management)
5. [Hook System Internals](#5-hook-system-internals)
6. [Hook Merge Semantics Reference](#6-hook-merge-semantics-reference)
7. [Priority Ordering & Execution](#7-priority-ordering--execution)
8. [Error Handling & Resilience](#8-error-handling--resilience)
9. [Plugin SDK Boundaries & Module Loading](#9-plugin-sdk-boundaries--module-loading)
10. [Third-Party Plugin Installation Flow](#10-third-party-plugin-installation-flow)
11. [Security Mechanisms](#11-security-mechanisms)

---

## 1. Plugin Loading Lifecycle

**Key files:**
- `src/plugins/loader.ts` (1259 lines)
- `src/plugins/registry.ts` (1009 lines)
- `src/plugins/discovery.ts`

### Loading Phases

```
Phase 1: Discovery
  resolvePluginSourceRoots()
    -> scan global (~/.openclaw/extensions/)
    -> scan workspace (.openclaw/extensions/)
    -> scan bundled (built-in)
    -> scan loadPaths (plugins.load.paths[])
  discoverOpenClawPlugins()
    -> filesystem scan with caching (1000ms window)
    -> boundary & ownership checks
    -> read openclaw.plugin.json manifests

Phase 2: Sorting & Dedup
  loadPluginManifestRegistry()
    -> sort by origin priority: config > workspace > global > bundled
    -> deduplicate by plugin ID (higher priority wins)

Phase 3: State Resolution
  resolvePluginEnableState()
    -> check master switch (plugins.enabled)
    -> check allow/deny lists
    -> check per-plugin enabled flag
    -> apply defaults for bundled vs third-party

Phase 4: Loading
  For each enabled plugin:
    -> load via Jiti (TypeScript dynamic import)
    -> apply SDK alias remapping
    -> validate configSchema against plugins.entries[id].config
    -> call register(api) SYNCHRONOUSLY
    -> track in registry

Phase 5: Activation
  activatePluginRegistry()
    -> set global registry
    -> initialize hook runner
    -> call optional activate(api) ASYNCHRONOUSLY
```

### Registration Modes

| Mode | When | Capabilities |
|------|------|-------------|
| `"full"` | Normal startup | Config + runtime (hooks, tools, providers) |
| `"setup-only"` | Onboarding/setup | Config-time only (auth, catalog) |
| `"setup-runtime"` | Bundled mode | Config-time + runtime, limited scope |

### Snapshot vs Activating Loads

- **Activating (production):** Commands registered globally, hooks attached, full lifecycle
- **Non-activating (snapshot):** `cache: false`, no command registry contamination, used for validation/onboarding

---

## 2. Plugin Discovery & Path Resolution

**Key file:** `src/plugins/roots.ts`

### Search Roots (Priority Order)

| Priority | Root | Path | Description |
|----------|------|------|-------------|
| 1 (highest) | Config extensions | `plugins.load.paths[]` | User-specified custom paths |
| 2 | Workspace | `.openclaw/extensions/` | Project-local plugins |
| 3 | Global | `~/.openclaw/extensions/` | User-installed plugins |
| 4 (lowest) | Bundled | Built-in plugin directory | Stock plugins |

### Caching Strategy

Registry cached with composite key:
- workspace/global/bundled root paths
- normalized plugins config (allow/deny/entries/load)
- environment variables
- on-disk file hashes (for invalidation)
- LRU cache: 128 entries max

---

## 3. Plugin Enable/Disable State Machine

**Key file:** `src/plugins/config-state.ts`

### Resolution Order (First Match Wins)

```
1. plugins.enabled === false           -> DISABLED (master kill switch)
2. plugin in plugins.deny[]            -> DISABLED
3. entries[id].enabled === false       -> DISABLED
4. Memory slot match (slots.memory)    -> ENABLED (special case)
5. Not in plugins.allow[] (if exists)  -> DISABLED
6. Workspace origin + !entry.enabled   -> DISABLED (default for workspace)
7. Bundled + in DEFAULT_ENABLED set    -> ENABLED
8. Fallthrough                         -> ENABLED
```

### Bundled Plugins Enabled by Default

~40 plugins: `anthropic`, `openai`, `ollama`, `openrouter`, `google`, `mistral`, `amazon-bedrock`, `telegram`, `discord`, `slack`, etc.

---

## 4. Configuration-Driven Plugin Management

**Key file:** `src/config/types.plugins.ts`

### PluginsConfig Type

```typescript
type PluginsConfig = {
  enabled?: boolean;                    // Master plugin kill switch
  allow?: string[];                     // Allowlist of trusted plugin IDs
  deny?: string[];                      // Denylist of plugin IDs
  load?: {
    paths?: string[];                   // Additional plugin search directories
  };
  slots?: {
    memory?: string;                    // Which memory plugin to use
    contextEngine?: string;             // Which context engine plugin to use
  };
  entries?: Record<string, PluginEntryConfig>;  // Per-plugin config
  installs?: Record<string, PluginInstallRecord>;  // Installation records
};
```

### Per-Plugin Entry Config

```typescript
type PluginEntryConfig = {
  enabled?: boolean;                    // Enable/disable this plugin
  hooks?: {
    allowPromptInjection?: boolean;     // Control prompt mutation capability
  };
  subagent?: {
    allowModelOverride?: boolean;       // Allow plugin model routing
    allowedModels?: string[];           // Whitelist of allowed models
  };
  config?: Record<string, unknown>;     // Plugin-specific custom config
};
```

### Example: Full Plugin Configuration (YAML)

```yaml
plugins:
  enabled: true
  allow:
    - anthropic
    - openai
    - model-router
  deny:
    - deprecated-plugin
  load:
    paths:
      - /opt/openclaw/custom-plugins/
  slots:
    memory: memory-core
  entries:
    model-router:
      enabled: true
      hooks:
        allowPromptInjection: false
      config:
        default_provider: "ollama"
        rules:
          - channel: "discord"
            model: "anthropic/claude-sonnet-4-6"
          - channel: "telegram"
            model: "ollama/llama3.3:8b"
    anthropic:
      enabled: true
    openai:
      enabled: true
  installs:
    model-router:
      source: "path"
      sourcePath: "~/.openclaw/extensions/model-router"
      installPath: "~/.openclaw/extensions/model-router"
```

### Plugin Config Validation

Each plugin declares `configSchema` in `openclaw.plugin.json`:
- Config from `plugins.entries[id].config` validated against schema
- Uses `validateJsonSchemaValue()` with caching
- Invalid config -> plugin marked as error, not loaded
- Missing config -> uses `{}` (empty object)

---

## 5. Hook System Internals

**Key file:** `src/plugins/hooks.ts` (900+ lines)

### Hook Execution Patterns

| Pattern | Behavior | Hooks |
|---------|----------|-------|
| **Void** | Parallel (`Promise.all`), no return | `llm_input`, `llm_output`, `agent_end`, `message_received`, `message_sent`, `session_start/end`, `subagent_spawned`, `subagent_ended`, `gateway_start/stop`, `before_compaction`, `after_compaction`, `before_reset` |
| **Modifying** | Sequential by priority, results merged | `before_model_resolve`, `before_prompt_build`, `before_agent_start`, `message_sending`, `before_tool_call`, `subagent_spawning`, `subagent_delivery_target` |
| **Claiming** | Sequential, first `{handled:true}` wins | `inbound_claim` |
| **Sync** | Synchronous (hot path) | `tool_result_persist`, `before_message_write` |

### Hook Registration

```typescript
api.on<K extends PluginHookName>(
  hookName: K,
  handler: PluginHookHandlerMap[K],
  opts?: { priority?: number }
) => void
```

### hasHooks Optimization

```typescript
function hasHooks(hookName: PluginHookName): boolean {
  return registry.typedHooks.some((h) => h.hookName === hookName);
}
```

Call sites check `hasHooks()` before invoking expensive hook runners, avoiding unnecessary work when no handlers are registered.

---

## 6. Hook Merge Semantics Reference

### `before_model_resolve` -- First-Defined-Wins

```typescript
(acc, next) => ({
  modelOverride: acc?.modelOverride ?? next.modelOverride,
  providerOverride: acc?.providerOverride ?? next.providerOverride,
});
```

Higher-priority hook's override persists; lower-priority cannot replace it.

### `before_prompt_build` -- Mixed Strategy

```typescript
(acc, next) => ({
  systemPrompt: next.systemPrompt ?? acc?.systemPrompt,       // Last-defined-wins
  prependContext: concat(acc?.prependContext, next.prependContext),   // Accumulated
  prependSystemContext: concat(acc?.prependSystemContext, next.prependSystemContext),
  appendSystemContext: concat(acc?.appendSystemContext, next.appendSystemContext),
});
```

- `systemPrompt`: Last hook to define it wins (opposite of model_resolve)
- Context fields: Concatenated with `\n\n` separator

### `before_agent_start` (Legacy)

```typescript
(acc, next) => ({
  ...mergeBeforePromptBuild(acc, next),
  ...mergeBeforeModelResolve(acc, next),
});
```

Combines both strategies. Legacy fallback for plugins not migrated to split hooks.

### `subagent_spawning` -- Error-Sticky

```typescript
(acc, next) => {
  if (acc?.status === "error") return acc;   // Sticky errors
  if (next.status === "error") return next;
  return {
    status: "ok",
    threadBindingReady: Boolean(acc?.threadBindingReady || next.threadBindingReady),
  };
};
```

### `subagent_delivery_target` -- First Origin Wins

```typescript
(acc, next) => {
  if (acc?.origin) return acc;   // First origin is sticky
  return next;
};
```

### `message_sending` -- Last-Defined-Wins

```typescript
(acc, next) => ({
  content: next.content ?? acc?.content,
  cancel: next.cancel ?? acc?.cancel,
});
```

### `before_tool_call` -- Last-Defined-Wins

```typescript
(acc, next) => ({
  params: next.params ?? acc?.params,
  block: next.block ?? acc?.block,
  blockReason: next.blockReason ?? acc?.blockReason,
});
```

### Summary Table

| Hook | Override Strategy | Key Implication |
|------|------------------|-----------------|
| `before_model_resolve` | First-defined-wins | High-priority plugin's model choice persists |
| `before_prompt_build.systemPrompt` | Last-defined-wins | Lower-priority plugin can override system prompt |
| `before_prompt_build.context` | Accumulated | All plugins' context concatenated |
| `subagent_spawning` | Error-sticky | Any error blocks the spawn |
| `subagent_delivery_target` | First origin wins | First plugin to set delivery target persists |
| `message_sending` | Last-defined-wins | Lower-priority plugin can override message |
| `before_tool_call` | Last-defined-wins | Lower-priority plugin can override tool params |

---

## 7. Priority Ordering & Execution

### Sorting Implementation

```typescript
function getHooksForName<K extends PluginHookName>(
  registry: PluginRegistry,
  hookName: K,
): PluginHookRegistration<K>[] {
  return (registry.typedHooks as PluginHookRegistration<K>[])
    .filter((h) => h.hookName === hookName)
    .toSorted((a, b) => (b.priority ?? 0) - (a.priority ?? 0));  // Descending
}
```

### Rules

- **Higher `priority` number = executed first** (descending sort)
- Default priority: `0` (if undefined)
- Within same priority: registration order (deterministic but not guaranteed across restarts)
- For modifying hooks: execution order directly affects merge result

### Example

```typescript
// Priority 10 executes FIRST
api.on("before_model_resolve", () => ({
  modelOverride: "llama3.3:8b",
  providerOverride: "ollama"
}), { priority: 10 });

// Priority 1 executes SECOND -- its modelOverride is DISCARDED
// because acc?.modelOverride is already set from priority-10 handler
api.on("before_model_resolve", () => ({
  modelOverride: "gpt-4o"
}), { priority: 1 });

// Result: { modelOverride: "llama3.3:8b", providerOverride: "ollama" }
```

---

## 8. Error Handling & Resilience

### handleHookError Behavior

```typescript
const handleHookError = (params) => {
  const msg = `[hooks] ${params.hookName} handler from ${params.pluginId} failed: ${String(params.error)}`;
  if (catchErrors) {
    logger?.error(msg);   // Log and continue
    return;
  }
  throw new Error(msg, { cause: params.error });  // Halt execution
};
```

### Default: `catchErrors: true`

```typescript
const catchErrors = options.catchErrors ?? true;
```

### Effect on Modifying Hooks

```typescript
for (const hook of hooks) {
  try {
    const handlerResult = await hook.handler(event, ctx);
    if (handlerResult != null) {
      result = mergeResults ? mergeResults(result, handlerResult) : handlerResult;
    }
  } catch (err) {
    handleHookError({ hookName, pluginId: hook.pluginId, error: err });
    // catchErrors=true: continues to next hook with result unchanged
    // catchErrors=false: throws, halting all subsequent hooks
  }
}
```

### Call Site Error Recovery (run.ts)

```typescript
if (hookRunner?.hasHooks("before_model_resolve")) {
  try {
    modelResolveOverride = await hookRunner.runBeforeModelResolve(
      { prompt: params.prompt },
      hookCtx,
    );
  } catch (hookErr) {
    log.warn(`before_model_resolve hook failed: ${String(hookErr)}`);
    // Continue with modelResolveOverride = undefined (use defaults)
  }
}
```

Double safety net: individual handler errors caught by hook runner, entire hook runner failure caught by call site.

### Verified Test Pattern

```typescript
// Broken plugin (priority 10) crashes, but working plugin (priority 1) still executes
addBeforeModelResolveHook(registry, "broken-plugin",
  () => { throw new Error("plugin crashed"); }, 10);
addBeforeModelResolveHook(registry, "router-plugin",
  () => ({ modelOverride: "llama3.3:8b", providerOverride: "ollama" }), 1);

const result = await runner.runBeforeModelResolve({ prompt: "test" }, ctx);
// result.modelOverride === "llama3.3:8b" -- broken plugin didn't block execution
```

---

## 9. Plugin SDK Boundaries & Module Loading

### Boundary Rules

- Extensions MUST import from `openclaw/plugin-sdk/*` subpaths only
- NEVER import from `openclaw/src/` or another extension's `src/`
- Plugin dependencies go in the extension's own `package.json`
- `openclaw` itself should be in `devDependencies` or `peerDependencies`
- Enforced by custom lint script: `scripts/check-extension-plugin-sdk-boundary.mjs`

### SDK Subpath Exports (~80)

```
openclaw/plugin-sdk/plugin-entry     - definePluginEntry, defineChannelPluginEntry
openclaw/plugin-sdk/core             - Core types and helpers
openclaw/plugin-sdk/runtime          - Runtime API
openclaw/plugin-sdk/runtime-env      - Runtime environment
openclaw/plugin-sdk/provider-setup   - Provider setup helpers
openclaw/plugin-sdk/provider-auth    - Provider auth helpers
openclaw/plugin-sdk/provider-catalog - Provider catalog helpers
openclaw/plugin-sdk/provider-stream  - Stream wrapping
openclaw/plugin-sdk/provider-usage   - Usage/billing
openclaw/plugin-sdk/provider-models  - Model helpers
openclaw/plugin-sdk/channel-setup    - Channel setup helpers
openclaw/plugin-sdk/channel-runtime  - Channel runtime
openclaw/plugin-sdk/routing          - Session/route helpers
openclaw/plugin-sdk/hook-runtime     - Hook helpers
openclaw/plugin-sdk/gateway-runtime  - Gateway helpers
openclaw/plugin-sdk/agent-runtime    - Agent helpers
```

### Jiti Module Loading

- Plugins loaded via Jiti (JIT TypeScript import)
- SDK alias remapping: `openclaw/plugin-sdk/*` -> actual source/dist paths
- Handles both `.ts` (source) and `.js` (dist) trees
- Allows TypeScript plugins without pre-compilation step

---

## 10. Third-Party Plugin Installation Flow

### Plugin Package Structure

```
my-router-plugin/
  package.json                 # Plugin metadata + dependencies
  openclaw.plugin.json         # Plugin manifest (id, providers, configSchema)
  index.ts                     # Main entry (definePluginEntry)
  src/
    routing-rules.ts           # Routing logic
    config-schema.ts           # Zod/JSON schema for plugin config
```

### Installation Steps

**Step 1: Create plugin package**

```typescript
// index.ts
import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";

export default definePluginEntry({
  id: "model-router",
  name: "Model Router",
  description: "Dynamic model routing based on context",
  register(api) {
    const config = api.pluginConfig;
    api.on("before_model_resolve", (event, ctx) => {
      // routing logic using config.rules
    }, { priority: 100 });
  },
});
```

```json
// openclaw.plugin.json
{
  "id": "model-router",
  "configSchema": {
    "type": "object",
    "properties": {
      "rules": {
        "type": "array",
        "items": {
          "type": "object",
          "properties": {
            "channel": { "type": "string" },
            "model": { "type": "string" }
          }
        }
      }
    }
  }
}
```

**Step 2: Place in plugin directory**

```bash
# Global installation
cp -r my-router-plugin/ ~/.openclaw/extensions/model-router/

# Or workspace installation
cp -r my-router-plugin/ .openclaw/extensions/model-router/
```

**Step 3: Configure (config.yaml)**

```yaml
plugins:
  allow:
    - model-router
  entries:
    model-router:
      enabled: true
      config:
        rules:
          - channel: "discord"
            model: "anthropic/claude-sonnet-4-6"
```

**Step 4: Restart gateway**

Plugin auto-discovered -> manifest loaded -> config validated -> `register(api)` called -> hooks active.

### Installation Records

```typescript
type PluginInstallRecord = {
  source: "npm" | "archive" | "path" | "marketplace";
  spec?: string;           // e.g., "@company/model-router@1.0.0"
  sourcePath?: string;     // Local source directory
  installPath?: string;    // Where installed on disk
  version?: string;
  integrity?: string;
  installedAt?: string;
};
```

---

## 11. Security Mechanisms

| Mechanism | Description |
|-----------|-------------|
| **Allowlist** | `plugins.allow[]` -- only listed plugins can load |
| **Denylist** | `plugins.deny[]` -- explicitly block plugins |
| **Boundary checks** | Plugins cannot escape root directory via symlinks |
| **Ownership validation** | Unix: file ownership must match UID |
| **World-writable rejection** | Refuses plugins in world-writable paths |
| **Prompt injection control** | `entries[id].hooks.allowPromptInjection` blocks prompt mutation |
| **Config validation** | Plugin config validated against declared schema before loading |
| **Sync registration** | `register(api)` must be synchronous; async returns are warned and ignored |
| **Diagnostic tracking** | Duplicate/conflicting registrations generate diagnostics, not silent overwrites |
