import { join } from "node:path";
import { homedir } from "node:os";
import { loadRulesSync, addRule, removeRule, clearRules } from "./src/rules-store.js";
import { buildRoutingPrompt } from "./src/prompt-inject.js";
import type { RulesData } from "./src/rules-store.js";

const DEFAULT_RULES_PATH = join(
  homedir(),
  ".openclaw",
  "plugins",
  "model-router",
  "rules.json",
);

export function handleRouteCommand(
  args: string,
  rulesFilePath: string,
  cache: { data: RulesData; prompt: string },
): { text: string } {
  const trimmed = args.trim();
  const spaceIdx = trimmed.indexOf(" ");
  const sub = spaceIdx === -1 ? trimmed : trimmed.slice(0, spaceIdx);
  const rest = spaceIdx === -1 ? "" : trimmed.slice(spaceIdx + 1).trim();

  switch (sub.toLowerCase()) {
    case "add": {
      if (!rest) {
        return { text: "Usage: /route add <rule>\nExample: /route add simple tasks use ollama/llama3.3:8b" };
      }
      const rule = addRule(rulesFilePath, rest);
      refreshCache(rulesFilePath, cache);
      return { text: `Added rule #${rule.id}: ${rule.text}` };
    }
    case "list": {
      if (cache.data.rules.length === 0) {
        return { text: "No routing rules configured. Use /route add <rule> to add one." };
      }
      const lines = cache.data.rules.map((r) => `${r.id}. ${r.text}`);
      return { text: `Current routing rules:\n${lines.join("\n")}` };
    }
    case "remove": {
      const id = parseInt(rest, 10);
      if (isNaN(id)) {
        return { text: "Usage: /route remove <rule number>" };
      }
      const removed = removeRule(rulesFilePath, id);
      if (removed) refreshCache(rulesFilePath, cache);
      return { text: removed ? `Removed rule #${id}` : `Rule #${id} not found` };
    }
    case "clear": {
      clearRules(rulesFilePath);
      refreshCache(rulesFilePath, cache);
      return { text: "Cleared all routing rules" };
    }
    default:
      return {
        text: "Usage:\n  /route add <rule>     - Add a routing rule\n  /route list           - List all rules\n  /route remove <number> - Remove a rule\n  /route clear          - Clear all rules",
      };
  }
}

function refreshCache(
  rulesFilePath: string,
  cache: { data: RulesData; prompt: string },
): void {
  cache.data = loadRulesSync(rulesFilePath);
  cache.prompt = buildRoutingPrompt(cache.data.rules);
}

export default {
  id: "model-router",
  name: "Model Router",
  description: "Natural language model routing rules via /route command",

  register(api: any) {
    const rulesFilePath = DEFAULT_RULES_PATH;
    const cache = {
      data: loadRulesSync(rulesFilePath),
      prompt: "",
    };
    cache.prompt = buildRoutingPrompt(cache.data.rules);

    api.registerCommand({
      name: "route",
      description: "Manage model routing rules: /route add|list|remove|clear",
      acceptsArgs: true,
      handler(ctx) {
        return handleRouteCommand(ctx.args ?? "", rulesFilePath, cache);
      },
    });

    api.on("before_prompt_build", () => {
      if (cache.data.rules.length === 0) return undefined;
      return { appendSystemContext: cache.prompt };
    }, { priority: 0 });
  },
};
