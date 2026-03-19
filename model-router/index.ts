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
