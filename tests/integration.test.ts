/**
 * Integration test for the model-router plugin.
 *
 * Tests the plugin against OpenClaw's real plugin infrastructure:
 * - Hook registration and execution via createHookRunner
 * - Command handler logic
 * - Prompt injection via before_prompt_build
 *
 * This file lives inside the OpenClaw source tree so it can import
 * test helpers and real plugin types directly.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { join } from "node:path";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";

// OpenClaw real infrastructure
import { createHookRunner } from "./hooks.js";
import {
  createMockPluginRegistry,
  addTestHook,
  TEST_PLUGIN_AGENT_CTX,
} from "./hooks.test-helpers.js";
import { createEmptyPluginRegistry } from "./registry-empty.js";
import type { PluginRegistry } from "./registry.js";
import type {
  PluginHookBeforePromptBuildResult,
} from "./types.js";

// Plugin modules under test (relative path to model-router)
import {
  loadRulesSync,
  addRule,
  removeRule,
  clearRules,
} from "../../../model-router/src/rules-store.js";
import { buildRoutingPrompt } from "../../../model-router/src/prompt-inject.js";

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
      // Setup: add rules to the store
      addRule(rulesPath, "simple tasks use ollama/llama3.3:8b");
      addRule(rulesPath, "code review use anthropic/claude-opus-4-5");

      // Create a real OpenClaw plugin registry with our hook
      const registry = createEmptyPluginRegistry();
      addTestHook({
        registry,
        pluginId: "model-router",
        hookName: "before_prompt_build",
        handler: (_event: unknown, _ctx: unknown) => {
          const data = loadRulesSync(rulesPath);
          if (data.rules.length === 0) return undefined;
          return {
            appendSystemContext: buildRoutingPrompt(data.rules),
          };
        },
        priority: 0,
      });

      // Create a real OpenClaw hook runner
      const runner = createHookRunner(registry, { catchErrors: false });

      // Execute the hook as OpenClaw would
      const result = await runner.runBeforePromptBuild(
        { prompt: "help me translate", messages: [] },
        TEST_PLUGIN_AGENT_CTX,
      );

      // Verify the result matches what OpenClaw expects
      expect(result).toBeDefined();
      expect(result?.appendSystemContext).toBeDefined();
      expect(result?.appendSystemContext).toContain("## Model Routing Rules");
      expect(result?.appendSystemContext).toContain("1. simple tasks use ollama/llama3.3:8b");
      expect(result?.appendSystemContext).toContain("2. code review use anthropic/claude-opus-4-5");
      expect(result?.appendSystemContext).toContain('sessions_spawn');
      expect(result?.appendSystemContext).toContain('runtime="subagent"');
    });

    it("returns undefined when no rules exist (zero overhead)", async () => {
      const registry = createEmptyPluginRegistry();
      addTestHook({
        registry,
        pluginId: "model-router",
        hookName: "before_prompt_build",
        handler: (_event: unknown, _ctx: unknown) => {
          const data = loadRulesSync(rulesPath);
          if (data.rules.length === 0) return undefined;
          return {
            appendSystemContext: buildRoutingPrompt(data.rules),
          };
        },
        priority: 0,
      });

      const runner = createHookRunner(registry, { catchErrors: false });

      const result = await runner.runBeforePromptBuild(
        { prompt: "hello", messages: [] },
        TEST_PLUGIN_AGENT_CTX,
      );

      // No rules -> no injection -> no token cost
      expect(result).toBeUndefined();
    });

    it("coexists with other plugins via appendSystemContext merging", async () => {
      addRule(rulesPath, "translation use google/gemini-2.5-flash");

      const registry = createEmptyPluginRegistry();

      // Another plugin also uses before_prompt_build
      addTestHook({
        registry,
        pluginId: "other-plugin",
        hookName: "before_prompt_build",
        handler: () => ({
          appendSystemContext: "Other plugin context here.",
        }),
        priority: 10, // higher priority, runs first
      });

      // Our model-router hook
      addTestHook({
        registry,
        pluginId: "model-router",
        hookName: "before_prompt_build",
        handler: (_event: unknown, _ctx: unknown) => {
          const data = loadRulesSync(rulesPath);
          if (data.rules.length === 0) return undefined;
          return {
            appendSystemContext: buildRoutingPrompt(data.rules),
          };
        },
        priority: 0,
      });

      const runner = createHookRunner(registry, { catchErrors: false });
      const result = await runner.runBeforePromptBuild(
        { prompt: "test", messages: [] },
        TEST_PLUGIN_AGENT_CTX,
      );

      // Both plugins' appendSystemContext should be merged (concatenated)
      expect(result?.appendSystemContext).toContain("Other plugin context here.");
      expect(result?.appendSystemContext).toContain("## Model Routing Rules");
    });

    it("survives hook errors gracefully with catchErrors", async () => {
      const registry = createEmptyPluginRegistry();

      // A broken plugin that throws
      addTestHook({
        registry,
        pluginId: "broken-plugin",
        hookName: "before_prompt_build",
        handler: () => {
          throw new Error("broken plugin crashed");
        },
        priority: 10,
      });

      // Our model-router hook should still execute
      addRule(rulesPath, "test rule");
      addTestHook({
        registry,
        pluginId: "model-router",
        hookName: "before_prompt_build",
        handler: (_event: unknown, _ctx: unknown) => {
          const data = loadRulesSync(rulesPath);
          if (data.rules.length === 0) return undefined;
          return {
            appendSystemContext: buildRoutingPrompt(data.rules),
          };
        },
        priority: 0,
      });

      // catchErrors: true (default) -- our hook still runs
      const runner = createHookRunner(registry, { catchErrors: true });
      const result = await runner.runBeforePromptBuild(
        { prompt: "test", messages: [] },
        TEST_PLUGIN_AGENT_CTX,
      );

      expect(result?.appendSystemContext).toContain("## Model Routing Rules");
    });
  });

  describe("command handler integration", () => {
    // Simulate the command handler logic as it would run in OpenClaw
    function handleRouteCommand(args: string): { text?: string } {
      const trimmed = args.trim();
      const spaceIdx = trimmed.indexOf(" ");
      const sub = spaceIdx === -1 ? trimmed : trimmed.slice(0, spaceIdx);
      const rest = spaceIdx === -1 ? "" : trimmed.slice(spaceIdx + 1).trim();

      switch (sub.toLowerCase()) {
        case "add": {
          if (!rest) {
            return { text: "Usage: /route add <rule>\nExample: /route add simple tasks use ollama/llama3.3:8b" };
          }
          const rule = addRule(rulesPath, rest);
          return { text: `Added rule #${rule.id}: ${rule.text}` };
        }
        case "list": {
          const data = loadRulesSync(rulesPath);
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
          const removed = removeRule(rulesPath, id);
          return { text: removed ? `Removed rule #${id}` : `Rule #${id} not found` };
        }
        case "clear": {
          clearRules(rulesPath);
          return { text: "Cleared all routing rules" };
        }
        default:
          return { text: "Usage:\n  /route add <rule>     - Add a routing rule\n  /route list           - List all rules\n  /route remove <number> - Remove a rule\n  /route clear          - Clear all rules" };
      }
    }

    it("full CRUD lifecycle works end-to-end", () => {
      // Add
      let result = handleRouteCommand("add simple Q&A use ollama/llama3.3:8b");
      expect(result.text).toContain("Added rule #1");

      result = handleRouteCommand("add coding use anthropic/claude-opus-4-5");
      expect(result.text).toContain("Added rule #2");

      // List
      result = handleRouteCommand("list");
      expect(result.text).toContain("1. simple Q&A use ollama/llama3.3:8b");
      expect(result.text).toContain("2. coding use anthropic/claude-opus-4-5");

      // Remove
      result = handleRouteCommand("remove 1");
      expect(result.text).toContain("Removed rule #1");

      // List after remove
      result = handleRouteCommand("list");
      expect(result.text).not.toContain("simple Q&A");
      expect(result.text).toContain("2. coding use anthropic/claude-opus-4-5");

      // Clear
      result = handleRouteCommand("clear");
      expect(result.text).toContain("Cleared");

      result = handleRouteCommand("list");
      expect(result.text).toContain("No routing rules configured");
    });

    it("command result is a valid ReplyPayload (has text field)", () => {
      const result = handleRouteCommand("add test rule");
      // OpenClaw PluginCommandResult = ReplyPayload = { text?: string, ... }
      expect(typeof result.text).toBe("string");
      expect(result.text!.length).toBeGreaterThan(0);
    });

    it("handles edge cases", () => {
      // Empty add
      expect(handleRouteCommand("add").text).toContain("Usage");
      expect(handleRouteCommand("add   ").text).toContain("Usage");

      // Invalid remove
      expect(handleRouteCommand("remove abc").text).toContain("Usage");
      expect(handleRouteCommand("remove").text).toContain("Usage");

      // Remove non-existent
      expect(handleRouteCommand("remove 999").text).toContain("not found");

      // Unknown subcommand
      expect(handleRouteCommand("unknown").text).toContain("Usage");
      expect(handleRouteCommand("").text).toContain("Usage");
    });
  });

  describe("end-to-end: command -> storage -> hook -> prompt", () => {
    it("rules added via command appear in hook output", async () => {
      // Step 1: User adds rules via /route command
      addRule(rulesPath, "translation use google/gemini-2.5-flash");
      addRule(rulesPath, "complex reasoning use anthropic/claude-opus-4-6");

      // Step 2: On next message, before_prompt_build fires
      const registry = createEmptyPluginRegistry();
      addTestHook({
        registry,
        pluginId: "model-router",
        hookName: "before_prompt_build",
        handler: (_event: unknown, _ctx: unknown) => {
          const data = loadRulesSync(rulesPath);
          if (data.rules.length === 0) return undefined;
          return {
            appendSystemContext: buildRoutingPrompt(data.rules),
          };
        },
        priority: 0,
      });

      const runner = createHookRunner(registry, { catchErrors: false });
      const result = await runner.runBeforePromptBuild(
        { prompt: "translate this article to Japanese", messages: [] },
        TEST_PLUGIN_AGENT_CTX,
      );

      // Step 3: Verify the injected prompt contains the rules
      const ctx = result?.appendSystemContext ?? "";
      expect(ctx).toContain("translation use google/gemini-2.5-flash");
      expect(ctx).toContain("complex reasoning use anthropic/claude-opus-4-6");
      expect(ctx).toContain("sessions_spawn");

      // Step 4: User removes a rule
      removeRule(rulesPath, 1);

      // Step 5: Next message, hook fires again with updated rules
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
