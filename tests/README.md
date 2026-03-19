# Tests

## Unit Tests

Located in `model-router/src/`. Run directly:

```bash
cd model-router && npx vitest run
```

11 tests covering rules-store CRUD and prompt-inject output.

## Integration Tests

`integration.test.ts` tests the plugin against OpenClaw's real hook runner infrastructure. It must run from inside the OpenClaw source tree because it imports OpenClaw's test helpers.

### How to Run

```bash
# 1. Ensure OpenClaw source is available with deps installed
cd openclaw && pnpm install

# 2. Copy the test file into OpenClaw's plugin test directory
cp tests/integration.test.ts openclaw/src/plugins/model-router-integration.test.ts

# 3. Run from OpenClaw
cd openclaw && npx vitest run src/plugins/model-router-integration.test.ts

# 4. Clean up
rm openclaw/src/plugins/model-router-integration.test.ts
```

### What It Verifies

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

### Why It Can't Run Standalone

The test imports OpenClaw's internal modules:
- `src/plugins/hooks.js` - `createHookRunner`
- `src/plugins/hooks.test-helpers.js` - `addTestHook`, `TEST_PLUGIN_AGENT_CTX`
- `src/plugins/registry-empty.js` - `createEmptyPluginRegistry`

These are not exposed via the Plugin SDK (`openclaw/plugin-sdk/*`), so the test must run inside the OpenClaw source tree.
