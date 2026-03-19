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
    expect(result).toContain("Model Routing");
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

  it("instructs to use subagent for delegation", () => {
    const rules: Rule[] = [{ id: 1, text: "test rule" }];
    const result = buildRoutingPrompt(rules);
    expect(result).toContain("subagent");
    expect(result).toContain("MUST");
    expect(result).toContain("Do NOT answer");
  });
});
