import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

export type Rule = {
  id: number;
  text: string;
};

export type RulesData = {
  rules: Rule[];
};

function nextId(rules: Rule[]): number {
  if (rules.length === 0) return 1;
  return Math.max(...rules.map((r) => r.id)) + 1;
}

export function loadRulesSync(rulesFilePath: string): RulesData {
  try {
    const raw = readFileSync(rulesFilePath, "utf-8");
    const data = JSON.parse(raw);
    if (!Array.isArray(data?.rules)) return { rules: [] };
    return { rules: data.rules };
  } catch {
    return { rules: [] };
  }
}

function save(rulesFilePath: string, data: RulesData): void {
  mkdirSync(dirname(rulesFilePath), { recursive: true });
  writeFileSync(rulesFilePath, JSON.stringify(data, null, 2), "utf-8");
}

export function addRule(rulesFilePath: string, text: string): Rule {
  const data = loadRulesSync(rulesFilePath);
  const rule: Rule = { id: nextId(data.rules), text };
  data.rules.push(rule);
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
  save(rulesFilePath, { rules: [] });
}
