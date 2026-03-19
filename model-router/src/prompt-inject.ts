import type { Rule } from "./rules-store.js";

export function buildRoutingPrompt(rules: Rule[]): string {
  if (rules.length === 0) return "";

  const rulesList = rules
    .map((r, i) => `${i + 1}. ${r.text}`)
    .join("\n");

  return `## MANDATORY: Model Routing via Subagent

You MUST use a subagent to handle tasks that match the routing rules below. Do NOT answer matching tasks yourself under any circumstances.

For every user message:
1. Check if any rule below matches the task
2. If YES: spawn a subagent using sessions_spawn with the specified model. Do NOT answer the task yourself. Do NOT explain why you are delegating. Just spawn the subagent immediately.
3. If NO rule matches: answer normally

Rules:
${rulesList}

When spawning the subagent, call:
sessions_spawn(model="<model from matching rule>", runtime="subagent", task="<the user's original message>")

Remember: when a rule matches, your ONLY job is to spawn the subagent. Never answer the task directly.`;
}
