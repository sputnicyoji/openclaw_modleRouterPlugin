import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { join } from "node:path";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { handleRouteCommand } from "../../../model-router/index.js";

/**
 * Tests the cache refresh mechanism: handleRouteCommand mutates
 * the shared cache object so the before_prompt_build hook
 * always reads up-to-date data without disk I/O.
 */
describe("handleRouteCommand cache refresh", () => {
  let tempDir: string;
  let rulesPath: string;
  let cache: { data: { rules: { id: number; text: string }[] }; prompt: string };

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "model-router-cache-test-"));
    rulesPath = join(tempDir, "rules.json");
    cache = { data: { rules: [] }, prompt: "" };
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("add command refreshes cache.data and cache.prompt", () => {
    expect(cache.data.rules).toHaveLength(0);
    expect(cache.prompt).toBe("");

    handleRouteCommand("add simple tasks use ollama/llama3.3:8b", rulesPath, cache);

    expect(cache.data.rules).toHaveLength(1);
    expect(cache.data.rules[0].text).toBe("simple tasks use ollama/llama3.3:8b");
    expect(cache.prompt).toContain("## Model Routing Rules");
    expect(cache.prompt).toContain("simple tasks use ollama/llama3.3:8b");
  });

  it("remove command refreshes cache", () => {
    handleRouteCommand("add rule one", rulesPath, cache);
    handleRouteCommand("add rule two", rulesPath, cache);
    expect(cache.data.rules).toHaveLength(2);

    handleRouteCommand("remove 1", rulesPath, cache);
    expect(cache.data.rules).toHaveLength(1);
    expect(cache.prompt).not.toContain("rule one");
    expect(cache.prompt).toContain("rule two");
  });

  it("clear command empties cache", () => {
    handleRouteCommand("add rule one", rulesPath, cache);
    expect(cache.data.rules).toHaveLength(1);

    handleRouteCommand("clear", rulesPath, cache);
    expect(cache.data.rules).toHaveLength(0);
    expect(cache.prompt).toBe("");
  });

  it("failed remove does not refresh cache", () => {
    handleRouteCommand("add rule one", rulesPath, cache);
    const promptBefore = cache.prompt;

    handleRouteCommand("remove 999", rulesPath, cache);
    expect(cache.prompt).toBe(promptBefore);
    expect(cache.data.rules).toHaveLength(1);
  });

  it("list command reads from cache not disk", () => {
    handleRouteCommand("add rule one", rulesPath, cache);

    // Cache is already up to date from add
    const result = handleRouteCommand("list", rulesPath, cache);
    expect(result.text).toContain("1. rule one");
  });

  it("cache.prompt stays in sync with cache.data through multiple ops", () => {
    handleRouteCommand("add coding use anthropic/claude-opus-4-5", rulesPath, cache);
    handleRouteCommand("add translation use google/gemini-2.5-flash", rulesPath, cache);

    // Simulate what before_prompt_build hook does: read cache.prompt
    expect(cache.prompt).toContain("coding use anthropic/claude-opus-4-5");
    expect(cache.prompt).toContain("translation use google/gemini-2.5-flash");

    handleRouteCommand("remove 1", rulesPath, cache);

    // prompt should be rebuilt without rule 1
    expect(cache.prompt).not.toContain("coding");
    expect(cache.prompt).toContain("translation use google/gemini-2.5-flash");
  });
});
