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
