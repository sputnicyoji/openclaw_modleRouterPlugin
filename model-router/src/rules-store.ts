import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

export type Rule = {
  id: number;
  text: string;
};

export type RulesData = {
  rules: Rule[];
  nextId: number;
};

function emptyData(): RulesData {
  return { rules: [], nextId: 1 };
}

export function loadRulesSync(rulesFilePath: string): RulesData {
  try {
    const raw = readFileSync(rulesFilePath, "utf-8");
    const data = JSON.parse(raw) as RulesData;
    if (!Array.isArray(data.rules)) return emptyData();
    return data;
  } catch {
    return emptyData();
  }
}

function save(rulesFilePath: string, data: RulesData): void {
  mkdirSync(dirname(rulesFilePath), { recursive: true });
  writeFileSync(rulesFilePath, JSON.stringify(data, null, 2), "utf-8");
}

export function saveRulesSync(rulesFilePath: string, data: RulesData): void {
  save(rulesFilePath, data);
}

export function addRule(rulesFilePath: string, text: string): Rule {
  const data = loadRulesSync(rulesFilePath);
  const rule: Rule = { id: data.nextId, text };
  data.rules.push(rule);
  data.nextId++;
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
  save(rulesFilePath, emptyData());
}
