/**
 * Integration test for the model-router plugin.
 *
 * Tests the plugin against OpenClaw's real plugin infrastructure:
 * - Hook registration and execution via createHookRunner
 * - Command handler logic (via exported handleRouteCommand)
 * - Prompt injection via before_prompt_build
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { join } from "node:path";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";

// OpenClaw real infrastructure
import { createHookRunner } from "./hooks.js";
import {
  addTestHook,
  TEST_PLUGIN_AGENT_CTX,
} from "./hooks.test-helpers.js";
import { createEmptyPluginRegistry } from "./registry-empty.js";
import type { PluginRegistry } from "./registry.js";

// Plugin modules under test
import {
  loadRulesSync,
  addRule,
  removeRule,
} from "../../../model-router/src/rules-store.js";
import { buildRoutingPrompt } from "../../../model-router/src/prompt-inject.js";
import { handleRouteCommand } from "../../../model-router/index.js";

// Shared helper: creates the hook handler matching production behavior
function makeRouterHook(rulesPath: string) {
  return (_event: unknown, _ctx: unknown) => {
    const data = loadRulesSync(rulesPath);
    if (data.rules.length === 0) return undefined;
    return {
      appendSystemContext: buildRoutingPrompt(data.rules),
    };
  };
}

function addRouterHook(registry: PluginRegistry, rulesPath: string) {
  addTestHook({
    registry,
    pluginId: "model-router",
    hookName: "before_prompt_build",
    handler: makeRouterHook(rulesPath),
    priority: 0,
  });
}

describe("model-router integration with OpenClaw", () => {
  let tempDir: string;
  let rulesPath: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "model-router-integration-"));
    rulesPath = join(tempDir, "rules.json");
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  describe("before_prompt_build hook integration", () => {
    it("injects routing rules into appendSystemContext", async () => {
      addRule(rulesPath, "simple tasks use ollama/llama3.3:8b");
      addRule(rulesPath, "code review use anthropic/claude-opus-4-5");

      const registry = createEmptyPluginRegistry();
      addRouterHook(registry, rulesPath);
      const runner = createHookRunner(registry, { catchErrors: false });

      const result = await runner.runBeforePromptBuild(
        { prompt: "help me translate", messages: [] },
        TEST_PLUGIN_AGENT_CTX,
      );

      expect(result).toBeDefined();
      expect(result?.appendSystemContext).toContain("## Model Routing Rules");
      expect(result?.appendSystemContext).toContain("1. simple tasks use ollama/llama3.3:8b");
      expect(result?.appendSystemContext).toContain("2. code review use anthropic/claude-opus-4-5");
      expect(result?.appendSystemContext).toContain('sessions_spawn');
      expect(result?.appendSystemContext).toContain('runtime="subagent"');
    });

    it("returns undefined when no rules exist (zero overhead)", async () => {
      const registry = createEmptyPluginRegistry();
      addRouterHook(registry, rulesPath);
      const runner = createHookRunner(registry, { catchErrors: false });

      const result = await runner.runBeforePromptBuild(
        { prompt: "hello", messages: [] },
        TEST_PLUGIN_AGENT_CTX,
      );

      expect(result).toBeUndefined();
    });

    it("coexists with other plugins via appendSystemContext merging", async () => {
      addRule(rulesPath, "translation use google/gemini-2.5-flash");

      const registry = createEmptyPluginRegistry();
      addTestHook({
        registry,
        pluginId: "other-plugin",
        hookName: "before_prompt_build",
        handler: () => ({ appendSystemContext: "Other plugin context here." }),
        priority: 10,
      });
      addRouterHook(registry, rulesPath);

      const runner = createHookRunner(registry, { catchErrors: false });
      const result = await runner.runBeforePromptBuild(
        { prompt: "test", messages: [] },
        TEST_PLUGIN_AGENT_CTX,
      );

      expect(result?.appendSystemContext).toContain("Other plugin context here.");
      expect(result?.appendSystemContext).toContain("## Model Routing Rules");
    });

    it("survives hook errors gracefully with catchErrors", async () => {
      const registry = createEmptyPluginRegistry();
      addTestHook({
        registry,
        pluginId: "broken-plugin",
        hookName: "before_prompt_build",
        handler: () => { throw new Error("broken plugin crashed"); },
        priority: 10,
      });
      addRule(rulesPath, "test rule");
      addRouterHook(registry, rulesPath);

      const runner = createHookRunner(registry, { catchErrors: true });
      const result = await runner.runBeforePromptBuild(
        { prompt: "test", messages: [] },
        TEST_PLUGIN_AGENT_CTX,
      );

      expect(result?.appendSystemContext).toContain("## Model Routing Rules");
    });
  });

  describe("command handler integration", () => {
    function makeCache() {
      const data = loadRulesSync(rulesPath);
      return { data, prompt: buildRoutingPrompt(data.rules) };
    }

    it("full CRUD lifecycle works end-to-end", () => {
      let cache = makeCache();

      let result = handleRouteCommand("add simple Q&A use ollama/llama3.3:8b", rulesPath, cache);
      expect(result.text).toContain("Added rule #1");

      cache = makeCache();
      result = handleRouteCommand("add coding use anthropic/claude-opus-4-5", rulesPath, cache);
      expect(result.text).toContain("Added rule #2");

      cache = makeCache();
      result = handleRouteCommand("list", rulesPath, cache);
      expect(result.text).toContain("1. simple Q&A use ollama/llama3.3:8b");
      expect(result.text).toContain("2. coding use anthropic/claude-opus-4-5");

      cache = makeCache();
      result = handleRouteCommand("remove 1", rulesPath, cache);
      expect(result.text).toContain("Removed rule #1");

      cache = makeCache();
      result = handleRouteCommand("list", rulesPath, cache);
      expect(result.text).not.toContain("simple Q&A");
      expect(result.text).toContain("2. coding use anthropic/claude-opus-4-5");

      cache = makeCache();
      result = handleRouteCommand("clear", rulesPath, cache);
      expect(result.text).toContain("Cleared");

      cache = makeCache();
      result = handleRouteCommand("list", rulesPath, cache);
      expect(result.text).toContain("No routing rules configured");
    });

    it("command result is a valid ReplyPayload (has text field)", () => {
      const result = handleRouteCommand("add test rule", rulesPath, makeCache());
      expect(typeof result.text).toBe("string");
      expect(result.text.length).toBeGreaterThan(0);
    });

    it("handles edge cases", () => {
      const cache = makeCache();
      expect(handleRouteCommand("add", rulesPath, cache).text).toContain("Usage");
      expect(handleRouteCommand("add   ", rulesPath, cache).text).toContain("Usage");
      expect(handleRouteCommand("remove abc", rulesPath, cache).text).toContain("Usage");
      expect(handleRouteCommand("remove", rulesPath, cache).text).toContain("Usage");
      expect(handleRouteCommand("remove 999", rulesPath, cache).text).toContain("not found");
      expect(handleRouteCommand("unknown", rulesPath, cache).text).toContain("Usage");
      expect(handleRouteCommand("", rulesPath, cache).text).toContain("Usage");
    });
  });

  describe("end-to-end: command -> storage -> hook -> prompt", () => {
    it("rules added via command appear in hook output", async () => {
      addRule(rulesPath, "translation use google/gemini-2.5-flash");
      addRule(rulesPath, "complex reasoning use anthropic/claude-opus-4-6");

      const registry = createEmptyPluginRegistry();
      addRouterHook(registry, rulesPath);
      const runner = createHookRunner(registry, { catchErrors: false });

      const result = await runner.runBeforePromptBuild(
        { prompt: "translate this article to Japanese", messages: [] },
        TEST_PLUGIN_AGENT_CTX,
      );

      const ctx = result?.appendSystemContext ?? "";
      expect(ctx).toContain("translation use google/gemini-2.5-flash");
      expect(ctx).toContain("complex reasoning use anthropic/claude-opus-4-6");
      expect(ctx).toContain("sessions_spawn");

      removeRule(rulesPath, 1);

      const result2 = await runner.runBeforePromptBuild(
        { prompt: "explain quantum physics", messages: [] },
        TEST_PLUGIN_AGENT_CTX,
      );
      const ctx2 = result2?.appendSystemContext ?? "";
      expect(ctx2).not.toContain("translation");
      expect(ctx2).toContain("complex reasoning use anthropic/claude-opus-4-6");
    });
  });
});
