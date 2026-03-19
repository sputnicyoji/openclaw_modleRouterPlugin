# Model Router Plugin Design Analysis

> Date: 2026-03-19
> Version: Based on OpenClaw v2026.3.14
> Focus: Architectural friction, integration constraints, design candidates

---

## Table of Contents

1. [Architectural Friction Points](#1-architectural-friction-points)
2. [Hook Context Analysis](#2-hook-context-analysis)
3. [Subagent Routing Deep Dive](#3-subagent-routing-deep-dive)
4. [Model Resolution Chain Detail](#4-model-resolution-chain-detail)
5. [Integration Approach Comparison](#5-integration-approach-comparison)
6. [Design Constraints Summary](#6-design-constraints-summary)
7. [Design Candidates](#7-design-candidates)

---

## 1. Architectural Friction Points

### Friction 1: Subagent Model Routing Gap

**Problem:** `before_model_resolve` hook only fires for the **main agent** execution. Subagents spawned via `sessions_spawn` resolve their model in `subagent-spawn.ts` through a static config chain, **bypassing all plugin hooks**.

**Subagent model resolution chain** (in `subagent-spawn.ts`):
```
1. modelOverride (from sessions_spawn tool parameter)
2. agents.{targetAgentId}.subagents.model (agent-specific config)
3. agents.defaults.subagents.model (default subagent model)
4. agents.defaults.model (main model)
5. anthropic/claude-opus-4-6 (hardcoded default)
```

**Impact:** A model router plugin cannot dynamically route subagent models via hooks alone. Must rely on:
- Config-level `agents.{id}.subagents.model` (static, ops-configured)
- The `modelOverride` parameter in `sessions_spawn` (requires main agent cooperation)
- Or core modification to add hook support in subagent spawn path

### Friction 2: Limited Hook Context

**Problem:** `before_model_resolve` receives only `event.prompt` (raw prompt text) and `ctx` (agent/session/channel metadata). It does NOT receive:

| Missing | Why It Matters |
|---------|---------------|
| Task type / intent | Cannot route by detected task (coding, research, translation) |
| Tool list / active tools | Cannot route based on which tools will be used |
| Conversation history | Cannot route based on ongoing conversation context |
| Message metadata | Cannot route based on message format (image, voice, text) |
| Agent config | Cannot inspect agent's configured capabilities |

**Rationale (security):** Prompt-only access prevents routing decisions based on potentially injected session history. This is a deliberate security design.

### Friction 3: One-Shot Model Selection

**Problem:** Model is selected **once** at agent run start, before any tools execute. There is no mechanism to change the model mid-run based on:
- Tool execution results
- Detected task complexity
- Token count thresholds
- Intermediate reasoning quality

The model stays fixed for the entire agent run (prompt -> response cycle).

### Friction 4: First-Defined-Override-Wins Contention

**Problem:** If multiple plugins register `before_model_resolve` handlers, the highest-priority one wins absolutely. There is no negotiation, voting, or fallback within the hook system.

**Implications:**
- Model router plugin must claim highest priority to guarantee its decisions apply
- Cannot compose routing decisions from multiple independent plugins
- Conflict resolution is purely priority-based, no content-aware merging

### Friction 5: Provider Must Exist

**Problem:** Hook can override `provider` and `modelId`, but the target provider plugin **must be registered and configured** with valid auth. The hook cannot:
- Create a provider on-the-fly
- Supply auth credentials dynamically
- Register a new provider at hook time (registration is synchronous, hooks are async)

Model routing is constrained to **pre-configured providers** in the system.

---

## 2. Hook Context Analysis

### before_model_resolve Event

```typescript
type PluginHookBeforeModelResolveEvent = {
  prompt: string;   // Raw user prompt text -- ONLY input for routing
};
```

### before_model_resolve Context

```typescript
type PluginHookAgentContext = {
  agentId?: string;        // e.g., "main", "researcher", "coder"
  sessionKey?: string;     // e.g., "agent:main:main"
  sessionId?: string;      // Ephemeral, regenerated on /new and /reset
  workspaceDir?: string;   // Agent workspace directory
  messageProvider?: string; // e.g., "telegram", "discord"
  trigger?: string;        // "user", "heartbeat", "cron", "memory"
  channelId?: string;      // e.g., "telegram", "discord", "whatsapp"
};
```

### Context Built in run.ts (lines 328-336)

```typescript
const hookCtx = {
  agentId: workspaceResolution.agentId,
  sessionKey: params.sessionKey,
  sessionId: params.sessionId,
  workspaceDir: resolvedWorkspace,
  messageProvider: params.messageProvider ?? undefined,
  trigger: params.trigger,
  channelId: params.messageChannel ?? params.messageProvider ?? undefined,
};
```

### Available vs Unavailable Routing Signals

| Signal | Available | Source | Routing Use |
|--------|-----------|--------|-------------|
| Prompt text | Yes | `event.prompt` | Keyword/pattern matching, intent detection |
| Channel ID | Yes | `ctx.channelId` | Per-channel model routing |
| Agent ID | Yes | `ctx.agentId` | Per-agent model routing |
| Trigger type | Yes | `ctx.trigger` | Cron/heartbeat vs user-triggered routing |
| Session key | Yes | `ctx.sessionKey` | Session-level routing persistence |
| Workspace dir | Yes | `ctx.workspaceDir` | Per-project model routing |
| Conversation history | No | N/A | Context-aware routing |
| Media type | No | N/A | Image/voice-specific model routing |
| Token budget | No | N/A | Cost-based routing |
| Tool requirements | No | N/A | Tool-specific model routing |

---

## 3. Subagent Routing Deep Dive

### Subagent Lifecycle

```
Main Agent receives prompt
  -> Main Agent decides to spawn subagent
  -> calls sessions_spawn(agentId, model?, task?)
  -> subagent-spawn.ts resolves model (NO hooks fired)
  -> subagent runs with resolved model
  -> subagent_spawned hook fires (void, observation only)
  -> subagent completes
  -> subagent_ended hook fires (void, observation only)
  -> result delivered to main agent
```

### Subagent Hook Context (Very Limited)

```typescript
type PluginHookSubagentContext = {
  runId?: string;
  childSessionKey?: string;
  requesterSessionKey?: string;
};
```

No `agentId`, `channelId`, `prompt`, or model information.

### subagent_spawning Event (Richer, But Read-Only for Model)

```typescript
type PluginHookSubagentSpawningEvent = {
  childSessionKey: string;
  agentId: string;           // Target agent ID
  label?: string;
  mode: "run" | "session";
  requester?: {
    channel?: string;
    accountId?: string;
    to?: string;
    threadId?: string | number;
  };
  threadRequested: boolean;
};

// Result can only control thread binding, NOT model:
type PluginHookSubagentSpawningResult = {
  status: "ok" | "error";
  threadBindingReady?: boolean;
  errorMessage?: string;
};
```

### Agent-Level Subagent Model Configuration

```yaml
agents:
  defaults:
    model: "anthropic/claude-opus-4-6"
    subagents:
      model: "anthropic/claude-sonnet-4-6"  # Default for all subagents
  list:
    - id: "researcher"
      subagents:
        model: "google/gemini-2.5-flash"    # This agent's subagents use Flash
    - id: "coder"
      subagents:
        model: "anthropic/claude-opus-4-6"  # This agent's subagents use Opus
```

### Key Insight: Main Agent as Router

The most practical subagent routing mechanism is through the **main agent itself**:
- Main agent's system prompt can include routing instructions
- Main agent calls `sessions_spawn(agentId="coder", model="anthropic/claude-opus-4-6")`
- The `model` parameter in `sessions_spawn` becomes `modelOverride` in the resolution chain
- This is the **only dynamic routing point** for subagents

---

## 4. Model Resolution Chain Detail

### Full Resolution Flow (run.ts + model.ts)

```
[1] before_model_resolve hook
    -> event: { prompt }
    -> ctx: { agentId, sessionKey, channelId, trigger, ... }
    -> result: { providerOverride?, modelOverride? }
    -> Apply: provider = result.providerOverride ?? configuredProvider
              modelId  = result.modelOverride ?? configuredModelId

[2] Legacy before_agent_start hook (compatibility)
    -> Merge: new hook's values take precedence (first-defined-wins)

[3] resolveModelAsync(provider, modelId, agentDir, config)
    [3a] resolveExplicitModelWithRegistry()
         -> Check models.json catalog (pi-ai registry)
         -> Apply applyConfiguredProviderOverrides() (baseUrl, api, headers)
         -> Call normalizeResolvedModel() via ProviderPlugin

    [3b] If not found: runProviderDynamicModel()
         -> Call ProviderPlugin.resolveDynamicModel() (sync, no I/O)

    [3c] If not found: build from providerConfig inline models
         -> Check models.providers.{provider}.models[]

    [3d] If ProviderPlugin.prepareDynamicModel exists:
         -> Call it (async, network I/O allowed)
         -> Retry steps [3a] + [3b]

[4] Auth preparation
    -> getApiKeyForModel() + prepareProviderRuntimeAuth()

[5] Model Fallback Loop (if resolution fails or runtime error)
    -> Iterate agents.{id}.model.fallbacks[]
    -> For each: auth profile rotation + cooldown detection
    -> Cooldown states: rate_limit, billing, auth, auth_permanent, overloaded

[6] Normal execution with resolved model
```

### Channel-Level Override (Separate Path)

**File:** `src/channels/model-overrides.ts`

Applied BEFORE `before_model_resolve` in the call chain:

```typescript
resolveChannelModelOverride({
  cfg,
  channel: "discord",
  groupId: "server-123",
  groupChannel: "#general",
  groupSubject: undefined,
  parentSessionKey: undefined,
});
```

Resolution hierarchy:
1. Direct channel match
2. groupId match
3. Parent groupId
4. Channel slug
5. Subject slug
6. Wildcard `*` fallback

Config format:
```yaml
channels:
  modelByChannel:
    general:
      "*": "anthropic/claude-sonnet-4-6"
      "urgent": "anthropic/claude-opus-4-6"
    "#announcements":
      "*": "google/gemini-2.5-flash"
```

---

## 5. Integration Approach Comparison

### Approach 1: Hook-Based Plugin (Simplest)

```typescript
definePluginEntry({
  id: "model-router",
  register(api) {
    api.on("before_model_resolve", (event, ctx) => {
      // Route based on available signals
    }, { priority: 100 });
  },
});
```

| Aspect | Assessment |
|--------|-----------|
| **Complexity** | Low -- single hook handler |
| **Main agent routing** | Full control via prompt + context |
| **Subagent routing** | None -- hook doesn't fire for subagents |
| **Config integration** | Via `api.pluginConfig` |
| **Core modification** | None required |
| **Routing signals** | Prompt text, channelId, agentId, trigger |
| **Best for** | Channel-based routing, keyword-based routing |

### Approach 2: Config-Only (No Code)

```yaml
# Agent-level model binding
agents:
  list:
    - id: "fast-responder"
      model:
        primary: "ollama/llama3.3:8b"
    - id: "deep-thinker"
      model:
        primary: "anthropic/claude-opus-4-6"
        fallbacks:
          - "openai/o3"

# Channel-level override
channels:
  modelByChannel:
    discord: "anthropic/claude-sonnet-4-6"
    telegram: "ollama/llama3.3:8b"

# Subagent model per agent
agents:
  defaults:
    subagents:
      model: "anthropic/claude-sonnet-4-6"
```

| Aspect | Assessment |
|--------|-----------|
| **Complexity** | Zero code |
| **Main agent routing** | Static per-agent and per-channel |
| **Subagent routing** | Static per-agent |
| **Dynamic routing** | None -- cannot route by prompt content |
| **Core modification** | None |
| **Best for** | Fixed environments with known model assignments |

### Approach 3: Hook + Config Hybrid

```typescript
definePluginEntry({
  id: "model-router",
  register(api) {
    const rules = api.pluginConfig?.rules ?? [];
    api.on("before_model_resolve", (event, ctx) => {
      for (const rule of rules) {
        if (matchRule(rule, event, ctx)) {
          return { providerOverride: rule.provider, modelOverride: rule.model };
        }
      }
    }, { priority: 100 });
  },
});
```

Combined with YAML config:
```yaml
plugins:
  entries:
    model-router:
      config:
        rules:
          - match: { channel: "discord" }
            provider: "anthropic"
            model: "claude-sonnet-4-6"
          - match: { prompt_contains: "translate" }
            provider: "ollama"
            model: "llama3.3:8b"
          - match: { agent: "researcher" }
            provider: "google"
            model: "gemini-2.5-flash"
```

| Aspect | Assessment |
|--------|-----------|
| **Complexity** | Medium -- plugin code + config rules |
| **Main agent routing** | Dynamic, rule-based |
| **Subagent routing** | Via config `subagents.model` only |
| **Ops friendliness** | High -- rules in YAML, no code changes |
| **Core modification** | None |
| **Best for** | Enterprise deployment with ops-managed routing rules |

### Approach 4: Full Provider Plugin (Virtual Router)

```typescript
definePluginEntry({
  id: "model-router",
  register(api) {
    api.registerProvider({
      id: "router",
      label: "Model Router",
      auth: [{ kind: "none" }],
      resolveDynamicModel: (ctx) => {
        // Route any "router/xxx" model ref to actual backend
        const target = resolveTarget(ctx.modelId);
        return buildRuntimeModel(target);
      },
      wrapStreamFn: (ctx) => {
        // Proxy stream to actual backend
        return createProxyStream(ctx);
      },
    });
  },
});
```

Config: `model: "router/auto"` -- all requests go through the router provider.

| Aspect | Assessment |
|--------|-----------|
| **Complexity** | High -- full provider implementation |
| **Main agent routing** | Full control |
| **Subagent routing** | If subagent configured with `router/auto` model |
| **Stream handling** | Must proxy streams to actual backends |
| **Auth management** | Must manage multi-backend auth internally |
| **Core modification** | None |
| **Best for** | Self-hosted OpenRouter equivalent |

### Approach 5: Core Modification (Hook in Subagent Spawn)

Patch `src/agents/subagent-spawn.ts` to fire `before_model_resolve` during subagent model resolution.

| Aspect | Assessment |
|--------|-----------|
| **Complexity** | Medium (patch) + maintenance burden |
| **Main agent routing** | Via standard hook |
| **Subagent routing** | Full dynamic control via hook |
| **Core modification** | Required -- fork or patch |
| **Maintenance** | Must re-apply on every OpenClaw upgrade |
| **Best for** | Full dynamic routing for both agents and subagents |

### Comparison Matrix

| Capability | Hook-Only | Config-Only | Hybrid | Full Provider | Core Mod |
|------------|-----------|-------------|--------|---------------|----------|
| Main agent dynamic routing | Yes | No | Yes | Yes | Yes |
| Subagent dynamic routing | No | No | No | Partial | Yes |
| Prompt-based routing | Yes | No | Yes | Yes | Yes |
| Channel-based routing | Yes | Yes | Yes | Yes | Yes |
| Agent-based routing | Yes | Yes | Yes | Yes | Yes |
| Ops config without code | No | Yes | Yes | No | No |
| No core modification | Yes | Yes | Yes | Yes | No |
| Complexity | Low | Zero | Medium | High | Medium |

---

## 6. Design Constraints Summary

### Hard Constraints

1. **Plugin SDK boundary**: Must import from `openclaw/plugin-sdk/*` only
2. **Sync registration**: `register(api)` must be synchronous
3. **Pre-configured providers**: Cannot create providers dynamically at hook time
4. **Prompt-only event**: `before_model_resolve` cannot access conversation history
5. **One-shot selection**: Model fixed for entire agent run

### Soft Constraints (Workarounds Exist)

1. **Subagent routing**: Use config `subagents.model` or main agent `sessions_spawn(model=...)`
2. **Task-based routing**: Encode task type in agent ID or detect from prompt keywords
3. **Multi-signal routing**: Combine prompt + channel + agent + trigger for richer decisions
4. **Cost optimization**: Use channel/trigger as proxy for cost tier selection

### Security Constraints

1. **No prompt injection**: End users cannot inject routing rules via prompts
2. **Ops-only config**: Routing rules configured by ops through backend config
3. **Allowlist enforcement**: Third-party plugins must be in `plugins.allow[]`
4. **Prompt injection control**: `hooks.allowPromptInjection` can restrict prompt mutation

---

## 7. Design Candidates

### Candidate 1: Rule-Based Router (Recommended for Initial Implementation)

**Approach:** Hook + Config Hybrid (Approach 3)

**Architecture:**
```
config.yaml (ops-managed routing rules)
  -> model-router plugin loads rules at register()
  -> before_model_resolve evaluates rules against (prompt, ctx)
  -> First matching rule determines provider/model override
  -> Unmatched requests use default model
```

**Rule engine supports:**
- Channel matching: `{ channel: "discord" }`
- Agent matching: `{ agent: "researcher" }`
- Trigger matching: `{ trigger: "cron" }`
- Prompt keyword matching: `{ prompt_contains: ["translate", "code"] }`
- Prompt regex matching: `{ prompt_regex: "^/image\\s" }`
- Composite conditions: `{ all: [condition1, condition2] }`

**Strengths:** Ops-friendly, no code changes for new rules, covers most routing scenarios.
**Weaknesses:** Cannot route subagents dynamically, limited to available hook context.

### Candidate 2: Multi-Agent Config Template

**Approach:** Config-Only (Approach 2) with structured agent definitions

**Architecture:**
```
config.yaml defines multiple specialized agents:
  - "fast" agent -> ollama/llama3.3:8b
  - "smart" agent -> anthropic/claude-opus-4-6
  - "balanced" agent -> anthropic/claude-sonnet-4-6

bindings[] maps channels/groups to appropriate agents
each agent has its own subagent model config
```

**Strengths:** Zero code, leverages existing OpenClaw features.
**Weaknesses:** Static routing only, no prompt-based decisions.

### Candidate 3: Virtual Provider Router

**Approach:** Full Provider Plugin (Approach 4)

**Architecture:**
```
Register "router" provider
  -> agents configured with model: "router/auto" or "router/fast"
  -> resolveDynamicModel() inspects model ID suffix for routing hints
  -> wrapStreamFn() proxies to actual backend provider
  -> Internal routing table maps hints to real providers
```

**Strengths:** Subagent routing (if configured with `router/*`), full stream control.
**Weaknesses:** High complexity, must handle auth/stream proxying for all backends.

### Candidate 4: Core-Patched Hook Router

**Approach:** Core Modification (Approach 5) + Hook Plugin

**Architecture:**
```
Patch subagent-spawn.ts to fire before_model_resolve
  -> model-router plugin's hook now fires for ALL model resolutions
  -> Full dynamic routing for main agent AND subagents
  -> Rule engine same as Candidate 1
```

**Strengths:** Most complete routing control.
**Weaknesses:** Maintenance burden on OpenClaw upgrades, fork management.

### Recommendation

**Start with Candidate 1 (Rule-Based Router)** for initial implementation:
- Covers the most common routing scenarios
- Zero core modification required
- Ops-friendly configuration
- Can evolve to Candidate 3 or 4 if subagent routing becomes critical

**For subagent routing needs**, combine with:
- Config-level `agents.{id}.subagents.model` for static per-agent subagent models
- Main agent system prompt instructions for dynamic `sessions_spawn(model=...)` routing
