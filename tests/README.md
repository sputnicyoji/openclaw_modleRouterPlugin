# Tests

## Unit Tests

Located in `model-router/src/`. Run directly:

```bash
cd model-router && npx vitest run
```

11 tests covering rules-store CRUD and prompt-inject output.

## Integration Tests

Two integration test files that must run inside the OpenClaw source tree (they import OpenClaw internals):

- `integration.test.ts` -- Hook runner + command handler tests (8 tests)
- `loader.test.ts` -- Real plugin loader test via `loadOpenClawPlugins` + jiti (1 test)

### How to Run

```bash
# 1. Ensure OpenClaw source is available with deps installed
cd openclaw && pnpm install

# 2. Copy test files into OpenClaw's plugin test directory
cp tests/integration.test.ts openclaw/src/plugins/model-router-integration.test.ts
cp tests/loader.test.ts openclaw/src/plugins/model-router-loader.test.ts

# 3. Run from OpenClaw
cd openclaw && npx vitest run src/plugins/model-router-integration.test.ts src/plugins/model-router-loader.test.ts

# 4. Clean up
rm openclaw/src/plugins/model-router-integration.test.ts openclaw/src/plugins/model-router-loader.test.ts
```

### What It Verifies

**integration.test.ts (8 tests):**

| Test | Verifies |
|------|----------|
| Hook injection | Rules injected via `appendSystemContext` with correct format |
| Zero overhead | No rules -> hook returns `undefined` -> no token cost |
| Multi-plugin coexistence | `appendSystemContext` merges correctly with other plugins |
| Error isolation | Other plugin crash doesn't block model-router (`catchErrors: true`) |
| Command CRUD lifecycle | add -> list -> remove -> clear full lifecycle |
| ReplyPayload format | Command returns valid `{ text: string }` |
| Edge cases | Empty args, invalid numbers, non-existent rules |
| End-to-end | Command writes rule -> file persists -> hook reads -> prompt output -> rule deleted -> prompt updated |

**loader.test.ts (1 test):**

| Test | Verifies |
|------|----------|
| Plugin loader | `index.ts` loads via `loadOpenClawPlugins` + jiti, `/route` command registered, `before_prompt_build` hook registered with priority 0 |

This is the most critical test -- it proves the plugin actually works with OpenClaw's real module loading system (jiti alias resolution, SDK boundary enforcement, manifest validation).

### Why They Can't Run Standalone

The tests import OpenClaw's internal modules:
- `src/plugins/hooks.js` - `createHookRunner`
- `src/plugins/hooks.test-helpers.js` - `addTestHook`, `TEST_PLUGIN_AGENT_CTX`
- `src/plugins/registry-empty.js` - `createEmptyPluginRegistry`
- `src/plugins/loader.js` - `loadOpenClawPlugins`

These are not exposed via the Plugin SDK (`openclaw/plugin-sdk/*`), so the tests must run inside the OpenClaw source tree.
