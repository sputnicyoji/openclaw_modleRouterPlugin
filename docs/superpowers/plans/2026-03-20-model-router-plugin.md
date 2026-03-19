# Model Router Plugin Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build an OpenClaw plugin that lets users define natural language model routing rules via `/route` slash command, injected into the main agent's system prompt so it delegates tasks to subagents with appropriate models.

**Architecture:** Three-module plugin: slash command handler (CRUD rules), rules store (JSON file persistence), prompt injector (`before_prompt_build` hook appending rules to system context). Main agent uses native `sessions_spawn(model=...)` to delegate.

**Tech Stack:** TypeScript (ESM), Node.js built-ins (`fs`, `path`, `os`), OpenClaw Plugin SDK (`openclaw/plugin-sdk/plugin-entry`)

**Spec:** `docs/superpowers/specs/2026-03-20-model-router-plugin-design.md`

---

## Chunk 1: Rules Store + Tests

### Task 1: Create plugin package scaffolding

**Files:**
- Create: `model-router/package.json`
- Create: `model-router/openclaw.plugin.json`

- [ ] **Step 1: Create package.json**

```json
{
  "name": "@openclaw-ext/model-router",
  "version": "1.0.0",
  "type": "module",
  "main": "index.ts",
  "peerDependencies": {
    "openclaw": ">=2026.3.0"
  },
  "devDependencies": {
    "vitest": "^4.0.0"
  },
  "scripts": {
    "test": "vitest run"
  }
}
```

- [ ] **Step 2: Create openclaw.plugin.json**

```json
{
  "id": "model-router"
}
```

- [ ] **Step 3: Verify files exist**

Run: `ls model-router/package.json model-router/openclaw.plugin.json`
Expected: Both files listed without error

- [ ] **Step 4: Commit**

```bash
git add model-router/package.json model-router/openclaw.plugin.json
git commit -m "chore: scaffold model-router plugin package"
```

---

### Task 2: Implement rules store with tests

**Files:**
- Create: `model-router/src/rules-store.ts`
- Create: `model-router/src/rules-store.test.ts`

The rules store handles CRUD operations on a JSON file. All functions take an explicit `rulesFilePath` parameter so they can be tested with temp files.

- [ ] **Step 1: Write the failing tests**

```typescript
// model-router/src/rules-store.test.ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { join } from "node:path";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { loadRulesSync, saveRulesSync, addRule, removeRule, clearRules } from "./rules-store.js";

describe("rules-store", () => {
  let tempDir: string;
  let rulesPath: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "model-router-test-"));
    rulesPath = join(tempDir, "rules.json");
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("returns empty array when file does not exist", () => {
    const data = loadRulesSync(rulesPath);
    expect(data.rules).toEqual([]);
    expect(data.nextId).toBe(1);
  });

  it("adds a rule and persists it", () => {
    const result = addRule(rulesPath, "simple tasks use ollama/llama3.3:8b");
    expect(result.id).toBe(1);
    expect(result.text).toBe("simple tasks use ollama/llama3.3:8b");

    const data = loadRulesSync(rulesPath);
    expect(data.rules).toHaveLength(1);
    expect(data.rules[0].text).toBe("simple tasks use ollama/llama3.3:8b");
    expect(data.nextId).toBe(2);
  });

  it("adds multiple rules with incrementing IDs", () => {
    addRule(rulesPath, "rule one");
    addRule(rulesPath, "rule two");
    const data = loadRulesSync(rulesPath);
    expect(data.rules).toHaveLength(2);
    expect(data.rules[0].id).toBe(1);
    expect(data.rules[1].id).toBe(2);
    expect(data.nextId).toBe(3);
  });

  it("removes a rule by ID", () => {
    addRule(rulesPath, "rule one");
    addRule(rulesPath, "rule two");
    const removed = removeRule(rulesPath, 1);
    expect(removed).toBe(true);

    const data = loadRulesSync(rulesPath);
    expect(data.rules).toHaveLength(1);
    expect(data.rules[0].id).toBe(2);
  });

  it("returns false when removing non-existent rule", () => {
    addRule(rulesPath, "rule one");
    const removed = removeRule(rulesPath, 99);
    expect(removed).toBe(false);
  });

  it("clears all rules", () => {
    addRule(rulesPath, "rule one");
    addRule(rulesPath, "rule two");
    clearRules(rulesPath);

    const data = loadRulesSync(rulesPath);
    expect(data.rules).toHaveLength(0);
    expect(data.nextId).toBe(1);
  });

  it("handles corrupt file gracefully", () => {
    writeFileSync(rulesPath, "not json!!!");
    const data = loadRulesSync(rulesPath);
    expect(data.rules).toEqual([]);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd model-router && npx vitest run src/rules-store.test.ts`
Expected: FAIL -- module `./rules-store.js` not found

- [ ] **Step 3: Implement rules-store.ts**

```typescript
// model-router/src/rules-store.ts
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

export type Rule = {
  id: number;
  text: string;
};

export type RulesData = {
  rules: Rule[];
  nextId: number;
};

function emptyData(): RulesData {
  return { rules: [], nextId: 1 };
}

export function loadRulesSync(rulesFilePath: string): RulesData {
  try {
    const raw = readFileSync(rulesFilePath, "utf-8");
    const data = JSON.parse(raw) as RulesData;
    if (!Array.isArray(data.rules)) return emptyData();
    return data;
  } catch {
    return emptyData();
  }
}

function save(rulesFilePath: string, data: RulesData): void {
  mkdirSync(dirname(rulesFilePath), { recursive: true });
  writeFileSync(rulesFilePath, JSON.stringify(data, null, 2), "utf-8");
}

export function saveRulesSync(rulesFilePath: string, data: RulesData): void {
  save(rulesFilePath, data);
}

export function addRule(rulesFilePath: string, text: string): Rule {
  const data = loadRulesSync(rulesFilePath);
  const rule: Rule = { id: data.nextId, text };
  data.rules.push(rule);
  data.nextId++;
  save(rulesFilePath, data);
  return rule;
}

export function removeRule(rulesFilePath: string, id: number): boolean {
  const data = loadRulesSync(rulesFilePath);
  const index = data.rules.findIndex((r) => r.id === id);
  if (index === -1) return false;
  data.rules.splice(index, 1);
  save(rulesFilePath, data);
  return true;
}

export function clearRules(rulesFilePath: string): void {
  save(rulesFilePath, emptyData());
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd model-router && npx vitest run src/rules-store.test.ts`
Expected: All 7 tests PASS

- [ ] **Step 5: Commit**

```bash
git add model-router/src/rules-store.ts model-router/src/rules-store.test.ts
git commit -m "feat: implement rules store with CRUD and file persistence"
```

---

## Chunk 2: Prompt Injector + Tests

### Task 3: Implement prompt injector with tests

**Files:**
- Create: `model-router/src/prompt-inject.ts`
- Create: `model-router/src/prompt-inject.test.ts`

The prompt injector builds the system prompt text block from a list of rules.

- [ ] **Step 1: Write the failing tests**

```typescript
// model-router/src/prompt-inject.test.ts
import { describe, it, expect } from "vitest";
import { buildRoutingPrompt } from "./prompt-inject.js";
import type { Rule } from "./rules-store.js";

describe("buildRoutingPrompt", () => {
  it("returns empty string for empty rules", () => {
    expect(buildRoutingPrompt([])).toBe("");
  });

  it("builds prompt with single rule", () => {
    const rules: Rule[] = [{ id: 1, text: "simple tasks use ollama/llama3.3:8b" }];
    const result = buildRoutingPrompt(rules);
    expect(result).toContain("## Model Routing Rules");
    expect(result).toContain("1. simple tasks use ollama/llama3.3:8b");
    expect(result).toContain("sessions_spawn");
    expect(result).toContain('runtime="subagent"');
  });

  it("builds prompt with multiple rules", () => {
    const rules: Rule[] = [
      { id: 1, text: "simple tasks use ollama/llama3.3:8b" },
      { id: 3, text: "coding use anthropic/claude-opus-4-5" },
    ];
    const result = buildRoutingPrompt(rules);
    expect(result).toContain("1. simple tasks use ollama/llama3.3:8b");
    expect(result).toContain("2. coding use anthropic/claude-opus-4-5");
  });

  it("does not include acp runtime", () => {
    const rules: Rule[] = [{ id: 1, text: "test rule" }];
    const result = buildRoutingPrompt(rules);
    expect(result).toContain("Do NOT use runtime=\"acp\"");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd model-router && npx vitest run src/prompt-inject.test.ts`
Expected: FAIL -- module `./prompt-inject.js` not found

- [ ] **Step 3: Implement prompt-inject.ts**

```typescript
// model-router/src/prompt-inject.ts
import type { Rule } from "./rules-store.js";

export function buildRoutingPrompt(rules: Rule[]): string {
  if (rules.length === 0) return "";

  const rulesList = rules
    .map((r, i) => `${i + 1}. ${r.text}`)
    .join("\n");

  return `## Model Routing Rules

The user has configured the following model routing rules. For each incoming task:

1. Evaluate which rule best matches the task
2. If a matching rule specifies a different model than your current model, delegate the task by calling sessions_spawn with the specified model
3. If no rule matches or the task fits your current model, handle it directly

Rules:
${rulesList}

When delegating, use: sessions_spawn(model="<model from rule>", runtime="subagent", task="<clear task description>")
Do NOT use runtime="acp" -- model selection only works with the subagent runtime.`;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd model-router && npx vitest run src/prompt-inject.test.ts`
Expected: All 4 tests PASS

- [ ] **Step 5: Commit**

```bash
git add model-router/src/prompt-inject.ts model-router/src/prompt-inject.test.ts
git commit -m "feat: implement prompt injector for routing rules"
```

---

## Chunk 3: Plugin Entry (index.ts) + Integration

### Task 4: Implement plugin entry point

**Files:**
- Create: `model-router/index.ts`

This is the main file that wires everything together. It registers the `/route` slash command and the `before_prompt_build` hook. Both handlers close over a shared `rulesFilePath` computed at registration time.

**Key API types (from OpenClaw source):**
- `api.registerCommand({ name, description, acceptsArgs, handler })` -- `handler` receives `PluginCommandContext` with `args?: string`, returns `{ text?: string }`
- `api.on("before_prompt_build", handler, { priority })` -- `handler` receives `(event, ctx)`, returns `{ appendSystemContext?: string } | undefined`
- `PluginCommandContext.args` contains raw text after the command name (e.g., for `/route add foo`, `args` = `"add foo"`)

- [ ] **Step 1: Implement index.ts**

```typescript
// model-router/index.ts
import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { join } from "node:path";
import { homedir } from "node:os";
import { loadRulesSync, addRule, removeRule, clearRules } from "./src/rules-store.js";
import { buildRoutingPrompt } from "./src/prompt-inject.js";

const DEFAULT_RULES_PATH = join(
  homedir(),
  ".openclaw",
  "plugins",
  "model-router",
  "rules.json",
);

export default definePluginEntry({
  id: "model-router",
  name: "Model Router",
  description: "Natural language model routing rules via /route command",

  register(api) {
    const rulesFilePath = DEFAULT_RULES_PATH;

    // Slash command: /route add|list|remove|clear
    api.registerCommand({
      name: "route",
      description: "Manage model routing rules: /route add|list|remove|clear",
      acceptsArgs: true,
      handler(ctx) {
        const args = (ctx.args ?? "").trim();
        const spaceIdx = args.indexOf(" ");
        const sub = spaceIdx === -1 ? args : args.slice(0, spaceIdx);
        const rest = spaceIdx === -1 ? "" : args.slice(spaceIdx + 1).trim();

        switch (sub.toLowerCase()) {
          case "add": {
            if (!rest) {
              return { text: "Usage: /route add <rule>\nExample: /route add simple tasks use ollama/llama3.3:8b" };
            }
            const rule = addRule(rulesFilePath, rest);
            return { text: `Added rule #${rule.id}: ${rule.text}` };
          }
          case "list": {
            const data = loadRulesSync(rulesFilePath);
            if (data.rules.length === 0) {
              return { text: "No routing rules configured. Use /route add <rule> to add one." };
            }
            const lines = data.rules.map((r) => `${r.id}. ${r.text}`);
            return { text: `Current routing rules:\n${lines.join("\n")}` };
          }
          case "remove": {
            const id = parseInt(rest, 10);
            if (isNaN(id)) {
              return { text: "Usage: /route remove <rule number>" };
            }
            const removed = removeRule(rulesFilePath, id);
            return { text: removed ? `Removed rule #${id}` : `Rule #${id} not found` };
          }
          case "clear": {
            clearRules(rulesFilePath);
            return { text: "Cleared all routing rules" };
          }
          default:
            return {
              text: "Usage:\n  /route add <rule>     - Add a routing rule\n  /route list           - List all rules\n  /route remove <number> - Remove a rule\n  /route clear          - Clear all rules",
            };
        }
      },
    });

    // Hook: inject rules into system prompt
    api.on("before_prompt_build", (_event, _ctx) => {
      const data = loadRulesSync(rulesFilePath);
      if (data.rules.length === 0) return undefined;
      return {
        appendSystemContext: buildRoutingPrompt(data.rules),
      };
    }, { priority: 0 });
  },
});
```

Note: TypeScript type checking against `openclaw/plugin-sdk/plugin-entry` is not possible in dev -- it's a peer dependency resolved at runtime via OpenClaw's jiti alias system. This is expected and matches how all OpenClaw extensions work. The plugin will be validated at gateway startup.

- [ ] **Step 2: Commit**

```bash
git add model-router/index.ts
git commit -m "feat: implement plugin entry with /route command and prompt injection hook"
```

---

### Task 5: Run full test suite

- [ ] **Step 1: Run all tests**

Run: `cd model-router && npx vitest run`
Expected: All 11 tests PASS (7 from rules-store + 4 from prompt-inject)

- [ ] **Step 2: Final commit if any fixes needed**

```bash
git add -A model-router/
git commit -m "fix: address test failures"
```

---

## Chunk 4: Documentation Update

### Task 6: Update CLAUDE.md and spec status

**Files:**
- Modify: `CLAUDE.md`
- Modify: `docs/superpowers/specs/2026-03-20-model-router-plugin-design.md`

- [ ] **Step 1: Update spec to reflect implementation**

In `docs/superpowers/specs/2026-03-20-model-router-plugin-design.md`:

1. Change `> Status: Review Passed` to `> Status: Implemented`
2. In Section 5, change `{workspaceDir}/.openclaw/plugins/model-router/rules.json` to `~/.openclaw/plugins/model-router/rules.json`
3. In Section 6 hook code, replace `ctx.workspaceDir ?? process.cwd()` with the closure-based `rulesFilePath` pattern (matching actual `index.ts` implementation)

- [ ] **Step 2: Update CLAUDE.md repository structure**

Add `model-router/` to the repository structure section:

```
openclaw_modleRouterPlugin/
  docs/                    # Project analysis reports and documentation
  model-router/            # Model Router Plugin (the deliverable)
  openclaw/                # OpenClaw source (shallow clone, read-only reference)
```

- [ ] **Step 3: Commit**

```bash
git add CLAUDE.md docs/superpowers/specs/2026-03-20-model-router-plugin-design.md
git commit -m "docs: mark spec as implemented, update repo structure"
```

---

## Summary

| Task | Files | Tests | Lines |
|------|-------|-------|-------|
| 1. Package scaffolding | `package.json`, `openclaw.plugin.json` | 0 | ~15 |
| 2. Rules store | `src/rules-store.ts`, `src/rules-store.test.ts` | 7 | ~50 + ~70 |
| 3. Prompt injector | `src/prompt-inject.ts`, `src/prompt-inject.test.ts` | 4 | ~25 + ~35 |
| 4. Plugin entry | `index.ts` | 0 | ~65 |
| 5. Test suite run | -- | 11 total | -- |
| 6. Docs update | `CLAUDE.md`, spec | 0 | ~5 |

**Total production code:** ~140 lines
**Total test code:** ~105 lines
**Total commits:** 5-6

### Design Note: Rules File Path

The spec originally used `{workspaceDir}/.openclaw/plugins/model-router/rules.json`. However, `PluginCommandContext` (slash command handler) does not expose `workspaceDir`. Since each employee has their own OpenClaw instance, a per-instance global path `~/.openclaw/plugins/model-router/rules.json` achieves the same isolation without needing workspace context. Both the command handler and hook handler close over this path via `register()`.
