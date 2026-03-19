# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Purpose

This is a research project for building a **model router plugin** (or equivalent solution) for enterprise on-premise deployed OpenClaw instances. The goal is to enable OpenClaw to dynamically route different models to sub-agents based on task requirements.

### Deployment Environment

- OpenClaw deployed in **enterprise internal data center** (on-premise, not public cloud)
- **Ops/admins have full access**: can modify config files, install plugins, set environment variables, restart services, and modify the deployment itself
- This opens up all integration paths: plugin installation, config editing, even patching core if needed
- On-premise avoids many public cloud limitations (see `docs/openclaw-cloud-deployment-limitations.md`): no WebSocket timeout from CDN, Docker-in-Docker sandbox available, no cold start issues, full network control

### Known Constraints

- End users cannot inject routing rules via prompts (blocked as prompt injection by OpenClaw's security layer)
- Routing logic must be configured by ops through backend mechanisms, not user-facing prompts
- The solution should be as simple to integrate as possible -- ideally a plugin that ops can install and configure without modifying OpenClaw core, but core modification is acceptable if necessary

### Research Materials

- `docs/openclaw-analysis-report.md` -- OpenClaw architecture full analysis (architecture, plugin system, model routing, hooks, provider interface, call chain, code-level implementation details)
- `docs/plugin-system-deep-dive.md` -- Plugin system deep dive (loading lifecycle, hook merge semantics, priority ordering, error handling, SDK boundaries, third-party plugin installation)
- `docs/model-router-design-analysis.md` -- Model router design analysis (architectural friction points, subagent routing limitations, hook context constraints, integration approach comparison, design candidates)
- `docs/openclaw-cloud-deployment-limitations.md` -- Cloud deployment limitations analysis (many constraints don't apply to on-premise deployment)

## Repository Structure

```
openclaw_modleRouterPlugin/
  docs/                    # Project analysis reports and documentation
  model-router/            # Model Router Plugin (the deliverable)
  openclaw/                # OpenClaw source (shallow clone, read-only reference)
```

The `openclaw/` directory is a shallow clone of https://github.com/openclaw/openclaw (v2026.3.14) used as a **read-only reference**. Do not modify files inside `openclaw/`. All plugin development should happen outside this directory.

## OpenClaw Architecture (Quick Reference)

OpenClaw is a multi-channel AI gateway (TypeScript/Node.js 22+/ESM) that bridges 30+ messaging platforms to multiple LLM backends. Everything is built around a plugin system.

### Monorepo Layout (inside `openclaw/`)

| Path | Role |
|------|------|
| `src/` | Core source code |
| `extensions/` | 80+ provider and channel plugins (workspace packages) |
| `packages/` | Internal packages (clawdbot, moltbot) |
| `ui/` | Web control panel (Vite + Lit) |
| `skills/` | 50+ bundled skill definitions (Markdown-based) |
| `src/plugins/` | Plugin system: registry, loader, hooks, runtime |
| `src/plugin-sdk/` | Public plugin SDK surface (re-exports) |
| `src/agents/` | Model selection, fallback, catalog, auth profiles |
| `src/routing/` | Agent routing engine |
| `src/config/` | Config schema (Zod), loading, validation |

### Key Source Files for Model Router Development

**Plugin entry & types:**
- `src/plugin-sdk/plugin-entry.ts` -- `definePluginEntry()` for creating plugins
- `src/plugin-sdk/core.ts` -- `definePluginEntry`, `defineChannelPluginEntry`, `defineSetupPluginEntry`
- `src/plugins/types.ts` -- ALL type definitions: `OpenClawPluginApi`, `ProviderPlugin`, `PluginHookName`, hook event/result types

**Model routing & hooks:**
- `src/plugins/hooks.ts` -- Hook runner with 25 hooks; `runBeforeModelResolve` is the key routing hook
- `src/plugins/hooks.model-override-wiring.test.ts` -- Test examples of `before_model_resolve` patterns
- `src/plugins/provider-runtime.ts` -- Provider hook dispatch (`runProviderDynamicModel`, `normalizeProviderResolvedModelWithPlugin`, `prepareProviderRuntimeAuth`)

**Model resolution chain:**
- `src/agents/pi-embedded-runner/run.ts` -- Embedded runner entry, fires hooks and selects model
- `src/agents/pi-embedded-runner/model.ts` -- `resolveModel`, `resolveModelAsync`
- `src/agents/model-selection.ts` -- `parseModelRef()`, `normalizeModelRef()`, ModelRef = `"provider/modelId"`
- `src/agents/model-fallback.ts` -- `runWithModelFallback()`, fallback chain with auth profile cooldown
- `src/agents/model-catalog.ts` -- `loadModelCatalog()`, catalog building and augmentation
- `src/agents/defaults.ts` -- `DEFAULT_PROVIDER = "anthropic"`, `DEFAULT_MODEL = "claude-opus-4-6"`

**Reference plugin implementations:**
- `extensions/openrouter/index.ts` -- Best reference for a provider plugin (dynamic models, stream wrapping)
- `extensions/anthropic/index.ts` -- Anthropic provider implementation

**Config & auth:**
- `src/config/types.models.ts` -- `ModelProviderConfig`, `ModelDefinitionConfig`, `ModelsConfig`
- `src/channels/model-overrides.ts` -- `resolveChannelModelOverride()` for per-channel model mapping
- `src/agents/auth-profiles.ts` -- Auth profile management and cooldown system

## Model Routing Mechanism

### Primary Hook: `before_model_resolve`

The main extension point for model routing. Registered via `api.on("before_model_resolve", handler)`:

```typescript
api.on("before_model_resolve", (event, ctx) => {
  return { providerOverride: "ollama", modelOverride: "llama3.3:8b" };
}, { priority: 100 });
```

- Multiple plugins can register handlers; results merge with **first-defined-override-wins** semantics
- Higher priority handlers execute first
- `event.prompt` contains the current prompt; `ctx` has channelId, agentId, sessionKey

### Model Resolution Order

1. `before_model_resolve` hook (plugin override point)
2. Static catalog lookup (`models.json`)
3. `ProviderPlugin.resolveDynamicModel()` (sync fallback for unknown IDs)
4. Config inline models (`models.providers`)
5. `ProviderPlugin.prepareDynamicModel()` (async prefetch, then retry)

### Fallback Chain

Configured in agent config as `model.primary` + `model.fallbacks[]`. The fallback loop rotates auth profiles and detects cooldown states (rate_limit, billing, auth, overloaded).

### Channel-Level Override

`channels.modelByChannel` in config maps channel identifiers to model strings for per-channel routing.

## Plugin SDK Boundaries

- Extensions MUST import from `openclaw/plugin-sdk/*` subpaths only
- NEVER import from `openclaw/src/` or another extension's `src/`
- Plugin dependencies go in the extension's own `package.json`, not the root
- `openclaw` itself should be in `devDependencies` or `peerDependencies` (runtime resolves via jiti alias)
- Plugin `register(api)` must be synchronous (async returns are warned and ignored)

## Potential Integration Approaches

1. **Hook-based plugin**: `definePluginEntry()` + `api.on("before_model_resolve")` -- simplest, route by prompt content/channel/agent context
2. **Full ProviderPlugin**: Register as a virtual provider that aggregates multiple backends (like a self-hosted OpenRouter)
3. **Config-only**: Use existing `models.providers`, `model.fallbacks[]`, `channels.modelByChannel`, and agent bindings -- no code needed but limited routing logic
4. **Hybrid**: Plugin for routing logic + config for provider credentials and fallback chains

## OpenClaw Build Commands (for reference only)

These commands run inside `openclaw/`:

```bash
pnpm install                              # Install deps
pnpm build                                # Type-check + build
pnpm check                                # Lint + format (oxlint + oxfmt)
pnpm test                                 # Run all tests (vitest)
pnpm test -- <path-or-filter>             # Run specific test
pnpm test:extension <extension-name>      # Test a specific extension
pnpm test:extension --list                # List valid extension ids
pnpm test:contracts                       # Test plugin/channel contracts
pnpm gateway:watch                        # Dev loop with auto-reload
```

## Language

All communication with the user should be in Chinese (zh-CN). Code comments and identifiers remain in English.
