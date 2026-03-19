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
