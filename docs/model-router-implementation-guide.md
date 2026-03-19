# Model Router Plugin 实现指南

> 日期: 2026-03-19
> 基于: OpenClaw v2026.3.14
> 前置阅读: `docs/openclaw-analysis-report.md`

---

## 目录

1. [目标与约束](#1-目标与约束)
2. [可用的路由维度](#2-可用的路由维度)
3. [插件骨架](#3-插件骨架)
4. [路由规则设计](#4-路由规则设计)
5. [与现有系统的交互](#5-与现有系统的交互)
6. [部署与安装](#6-部署与安装)
7. [测试策略](#7-测试策略)
8. [实现路线图](#8-实现路线图)

---

## 1. 目标与约束

### 目标

在企业内网部署的 OpenClaw 实例上，实现基于任务需求的动态模型路由，使不同 sub-agent 或不同场景使用不同的 LLM。

### 约束

| 约束 | 说明 |
|------|------|
| 企业内网 | 部署在企业内部数据中心，运维有完全访问权限 |
| 安全层阻断 | 终端用户无法通过 prompt 注入路由规则 |
| 运维配置 | 路由逻辑必须通过后端机制配置 |
| 简单集成 | 尽可能作为插件安装，避免修改核心 |

### 技术约束 (来自源码分析)

| 约束 | 来源 |
|------|------|
| `register(api)` 必须同步 | `loader.ts` -- async 返回值被丢弃 |
| event 仅包含 prompt | `types.ts` -- 无 session messages |
| 多插件 first-override-wins | `hooks.ts:163` -- `??` 合并语义 |
| 钩子按 priority 降序串行 | `hooks.ts:269` -- 非并行 |
| SDK 边界 | 只能从 `openclaw/plugin-sdk/*` 导入 |

---

## 2. 可用的路由维度

### 来自 `before_model_resolve` 事件

```typescript
type PluginHookBeforeModelResolveEvent = {
  prompt: string;  // 当前用户 prompt (仅此一条, 无历史)
};
```

### 来自 Agent 上下文

```typescript
type PluginHookAgentContext = {
  agentId?: string;       // 当前 agent ID (如 "coding-agent", "default")
  sessionKey?: string;    // 会话标识符
  sessionId?: string;     // 会话 ID
  workspaceDir?: string;  // 工作区目录
  messageProvider?: string;
  trigger?: string;       // "user" | "heartbeat" | "cron" | "memory"
  channelId?: string;     // "telegram" | "discord" | "slack" 等
};
```

### 路由决策矩阵

| 维度 | 可用信息 | 示例规则 |
|------|----------|----------|
| Channel | `ctx.channelId` | Telegram 用轻量模型, Discord 用强模型 |
| Agent | `ctx.agentId` | coding-agent 用 Claude, 翻译 agent 用 GPT |
| 触发类型 | `ctx.trigger` | heartbeat/cron 用便宜模型, user 用强模型 |
| Prompt 内容 | `event.prompt` | 代码相关用 Claude, 通用问答用 GPT |
| Session | `ctx.sessionKey` | 特定会话绑定特定模型 |
| 时间段 | `new Date()` | 高峰期用本地模型, 低谷用云 API |
| 组合条件 | 以上任意组合 | Discord coding-agent 用 Claude, 其余用 Ollama |

### 不可用维度 (设计限制)

- **Session 历史**: event 中没有历史消息
- **用户身份**: ctx 中没有用户 ID (只有 sessionKey)
- **消息附件**: event 中没有附件信息
- **模型负载**: 无法获取当前模型/provider 的负载状态

---

## 3. 插件骨架

### 3.1 最小可行插件

```typescript
// index.ts
import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";

export default definePluginEntry({
  id: "model-router",
  name: "Model Router",
  description: "Dynamic model routing based on context",

  register(api) {
    api.on("before_model_resolve", (event, ctx) => {
      // 路由逻辑
      return routeModel(event, ctx);
    }, { priority: 100 });
  },
});

function routeModel(
  event: { prompt: string },
  ctx: {
    agentId?: string;
    channelId?: string;
    trigger?: string;
    sessionKey?: string;
  },
): { modelOverride?: string; providerOverride?: string } | undefined {
  // 示例: 按 channel 路由
  if (ctx.channelId === "telegram") {
    return { providerOverride: "ollama", modelOverride: "llama3.3:8b" };
  }

  // 示例: 按 agent 路由
  if (ctx.agentId === "coding-agent") {
    return { providerOverride: "anthropic", modelOverride: "claude-opus-4-5" };
  }

  // 返回 undefined = 使用默认模型
  return undefined;
}
```

### 3.2 带配置的插件

```typescript
// index.ts
import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";

type RoutingRule = {
  name: string;
  conditions: {
    channelId?: string | string[];
    agentId?: string | string[];
    trigger?: string | string[];
    promptContains?: string[];
    promptRegex?: string;
  };
  target: {
    provider: string;
    model: string;
  };
  priority?: number;  // 规则内优先级, 与钩子 priority 不同
};

type PluginConfig = {
  rules: RoutingRule[];
  defaultTarget?: { provider: string; model: string };
  logging?: boolean;
};

export default definePluginEntry({
  id: "model-router",
  name: "Model Router",
  description: "Configurable dynamic model routing",

  register(api) {
    // 注意: register 必须同步, 配置读取也需同步
    // 可通过 api.getPluginConfig() 或环境变量获取配置路径

    api.on("before_model_resolve", (event, ctx) => {
      const config = loadConfig();  // 同步或缓存的配置
      const match = evaluateRules(config.rules, event, ctx);

      if (match) {
        if (config.logging) {
          console.log(`[model-router] Routing to ${match.provider}/${match.model} (rule: ${match.ruleName})`);
        }
        return {
          providerOverride: match.provider,
          modelOverride: match.model,
        };
      }

      if (config.defaultTarget) {
        return {
          providerOverride: config.defaultTarget.provider,
          modelOverride: config.defaultTarget.model,
        };
      }

      return undefined;
    }, { priority: 100 });
  },
});
```

### 3.3 项目结构

```
model-router-plugin/
  package.json
  openclaw.plugin.json
  index.ts              - definePluginEntry + register
  src/
    rules.ts            - 路由规则评估引擎
    config.ts           - 配置加载与验证
    types.ts            - TypeScript 类型定义
  config/
    routing-rules.json5 - 路由规则配置文件 (示例)
```

### 3.4 package.json

```json
{
  "name": "@openclaw-ext/model-router",
  "version": "1.0.0",
  "type": "module",
  "main": "index.ts",
  "devDependencies": {
    "openclaw": "^2026.3.14"
  },
  "peerDependencies": {
    "openclaw": "^2026.3.0"
  }
}
```

### 3.5 openclaw.plugin.json

```json
{
  "id": "model-router",
  "configSchema": {
    "type": "object",
    "properties": {
      "rulesPath": {
        "type": "string",
        "description": "Path to routing rules JSON5 file"
      },
      "logging": {
        "type": "boolean",
        "default": false
      }
    }
  }
}
```

---

## 4. 路由规则设计

### 4.1 规则评估顺序

规则在配置数组中按序排列，**第一个匹配的规则胜出**:

```json5
{
  "rules": [
    // 高优先级: 特定 agent + channel 组合
    {
      "name": "coding-on-discord",
      "conditions": { "agentId": "coding-agent", "channelId": "discord" },
      "target": { "provider": "anthropic", "model": "claude-opus-4-5" }
    },
    // 中优先级: 所有 coding agent
    {
      "name": "coding-default",
      "conditions": { "agentId": "coding-agent" },
      "target": { "provider": "anthropic", "model": "claude-sonnet-4-5" }
    },
    // 低优先级: 按 channel 路由
    {
      "name": "telegram-lightweight",
      "conditions": { "channelId": "telegram" },
      "target": { "provider": "ollama", "model": "llama3.3:8b" }
    },
    // 兜底: 默认模型
    {
      "name": "fallback",
      "conditions": {},
      "target": { "provider": "openai", "model": "gpt-4o" }
    }
  ]
}
```

### 4.2 条件匹配语义

```typescript
function matchesConditions(
  conditions: RoutingConditions,
  event: { prompt: string },
  ctx: PluginHookAgentContext,
): boolean {
  // 空条件 = 通配 (始终匹配)
  if (Object.keys(conditions).length === 0) return true;

  // 所有指定条件必须全部满足 (AND 语义)
  if (conditions.channelId) {
    const channels = Array.isArray(conditions.channelId)
      ? conditions.channelId : [conditions.channelId];
    if (!ctx.channelId || !channels.includes(ctx.channelId)) return false;
  }

  if (conditions.agentId) {
    const agents = Array.isArray(conditions.agentId)
      ? conditions.agentId : [conditions.agentId];
    if (!ctx.agentId || !agents.includes(ctx.agentId)) return false;
  }

  if (conditions.trigger) {
    const triggers = Array.isArray(conditions.trigger)
      ? conditions.trigger : [conditions.trigger];
    if (!ctx.trigger || !triggers.includes(ctx.trigger)) return false;
  }

  if (conditions.promptContains) {
    const lower = event.prompt.toLowerCase();
    if (!conditions.promptContains.some(kw => lower.includes(kw.toLowerCase()))) {
      return false;
    }
  }

  if (conditions.promptRegex) {
    if (!new RegExp(conditions.promptRegex, "i").test(event.prompt)) return false;
  }

  return true;
}
```

### 4.3 高级路由策略

#### 基于 prompt 分类的路由

```json5
{
  "rules": [
    {
      "name": "code-tasks",
      "conditions": {
        "promptRegex": "(code|debug|fix|implement|refactor|test|review|build|compile)"
      },
      "target": { "provider": "anthropic", "model": "claude-opus-4-5" }
    },
    {
      "name": "translation",
      "conditions": {
        "promptContains": ["translate", "translation"]
      },
      "target": { "provider": "openai", "model": "gpt-4o" }
    },
    {
      "name": "simple-qa",
      "conditions": {},
      "target": { "provider": "ollama", "model": "llama3.3:8b" }
    }
  ]
}
```

#### 时间段路由

```typescript
function getTimeBasedTarget(): { provider: string; model: string } | undefined {
  const hour = new Date().getHours();
  // 工作时间 (9-18): 使用云 API
  if (hour >= 9 && hour < 18) {
    return { provider: "anthropic", model: "claude-sonnet-4-5" };
  }
  // 非工作时间: 使用本地模型 (节省成本)
  return { provider: "ollama", model: "llama3.3:70b" };
}
```

#### 负载均衡 (round-robin)

```typescript
let requestCounter = 0;
const targets = [
  { provider: "anthropic", model: "claude-sonnet-4-5" },
  { provider: "openai", model: "gpt-4o" },
];

function roundRobinTarget() {
  const target = targets[requestCounter % targets.length];
  requestCounter++;
  return target;
}
```

---

## 5. 与现有系统的交互

### 5.1 与 Channel Model Override 的关系

**执行顺序**: Channel Model Override 在 `before_model_resolve` 之前执行。

但实际上，Channel Model Override 的结果会被设置为初始 `params.model`/`params.provider`，随后被 `before_model_resolve` 钩子的 override 覆盖。

**结论**: 插件的路由决策 > Channel Model Override > 默认模型

### 5.2 与 Model Fallback 的关系

插件通过 `before_model_resolve` 设置的模型作为 **primary model** 进入 `runWithModelFallback()`。

fallback 链仍然由 agent 配置的 `model.fallbacks[]` 决定。

**设计考虑**: 如果插件路由到的模型不可用，fallback 链会使用 agent 配置中定义的回退模型，而非插件指定的其他模型。如果需要插件控制 fallback，需要使用 `fallbacksOverride` (但这需要修改核心代码)。

### 5.3 与 Auth Profile 的关系

插件路由到的 provider 必须已有有效的 auth profile (API key 等)。

如果目标 provider 的所有 auth profile 都在冷却中:
- `auth`/`auth_permanent` -> 跳过，进入 fallback
- `rate_limit`/`overloaded` -> 可能探针尝试 (30s 间隔)
- `billing` -> 可能探针尝试 (仅 primary)

### 5.4 与其他插件的共存

多个插件都可以注册 `before_model_resolve` 钩子:
- 按 `priority` 降序串行执行
- **first-defined-override-wins**: 高优先级插件的 override 不会被低优先级覆盖
- 建议 model-router 使用 `priority: 100` 确保优先

**错误隔离**: 如果 model-router 抛异常，其他插件的 hook 仍会执行 (catchErrors 默认 true)。

---

## 6. 部署与安装

### 6.1 安装方式

#### 方式 A: 全局安装

```bash
# 将插件目录放到全局扩展路径
cp -r model-router-plugin/ ~/.openclaw/extensions/model-router/
```

#### 方式 B: 项目本地安装

```bash
# 在 OpenClaw 工作区中
cp -r model-router-plugin/ .openclaw/extensions/model-router/
```

#### 方式 C: 配置 loadPaths

在 OpenClaw 配置中添加:

```json5
{
  "plugins": {
    "allow": ["model-router"],
    "loadPaths": ["/opt/openclaw-plugins/model-router"]
  }
}
```

### 6.2 配置

在 OpenClaw 配置中启用插件并提供配置:

```json5
{
  "plugins": {
    "allow": ["model-router"],
    "entries": {
      "model-router": {
        "enabled": true,
        "config": {
          "rulesPath": "/etc/openclaw/routing-rules.json5",
          "logging": true
        }
      }
    }
  }
}
```

### 6.3 确保目标 Provider 可用

插件路由到的所有 provider 都必须:
1. 有对应的 extension 已安装且启用
2. 有有效的 API key 或认证配置
3. 在 `models.providers` 中有配置 (或 extension 自动发现)

```json5
{
  "models": {
    "providers": {
      "ollama": {
        "baseUrl": "http://gpu-server.internal:11434",
        "models": [
          { "id": "llama3.3:8b", "name": "Llama 3.3 8B", "api": "ollama",
            "reasoning": false, "input": ["text"], "contextWindow": 131072, "maxTokens": 4096,
            "cost": { "input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0 } }
        ]
      }
    }
  }
}
```

---

## 7. 测试策略

### 7.1 单元测试 (规则评估)

```typescript
import { describe, it, expect } from "vitest";
import { matchesConditions, evaluateRules } from "./src/rules";

describe("routing rules", () => {
  it("matches channel condition", () => {
    expect(matchesConditions(
      { channelId: "telegram" },
      { prompt: "hello" },
      { channelId: "telegram" },
    )).toBe(true);
  });

  it("rejects non-matching channel", () => {
    expect(matchesConditions(
      { channelId: "telegram" },
      { prompt: "hello" },
      { channelId: "discord" },
    )).toBe(false);
  });

  it("first matching rule wins", () => {
    const rules = [
      { name: "specific", conditions: { channelId: "telegram", agentId: "code" },
        target: { provider: "anthropic", model: "claude-opus-4-5" } },
      { name: "generic", conditions: { channelId: "telegram" },
        target: { provider: "ollama", model: "llama3.3:8b" } },
    ];
    const result = evaluateRules(rules, { prompt: "hello" },
      { channelId: "telegram", agentId: "code" });
    expect(result?.model).toBe("claude-opus-4-5");
  });
});
```

### 7.2 集成测试 (参考 hooks.model-override-wiring.test.ts 的模式)

```typescript
import { describe, it, expect } from "vitest";
import { createPluginRegistry, createHookRunner } from "openclaw/src/plugins/hooks";

describe("model-router hook integration", () => {
  it("overrides model via before_model_resolve", async () => {
    const registry = createPluginRegistry();
    // 注册 model-router 的 hook
    registry.typedHooks.push({
      pluginId: "model-router",
      hookName: "before_model_resolve",
      handler: (event, ctx) => {
        if (ctx.channelId === "telegram") {
          return { providerOverride: "ollama", modelOverride: "llama3.3:8b" };
        }
      },
      priority: 100,
      source: "test",
    });

    const runner = createHookRunner(registry, { catchErrors: true });
    const result = await runner.runBeforeModelResolve(
      { prompt: "hello" },
      { channelId: "telegram" },
    );

    expect(result?.providerOverride).toBe("ollama");
    expect(result?.modelOverride).toBe("llama3.3:8b");
  });
});
```

---

## 8. 实现路线图

### Phase 1: MVP (最小可行产品)

**目标**: 基于 channel + agent 的静态路由

1. 创建插件骨架 (definePluginEntry + before_model_resolve)
2. 实现简单的 channel/agent 条件匹配
3. 硬编码路由规则进行验证
4. 编写单元测试

**预计代码量**: ~150 行
**预计时间**: 1-2 小时

### Phase 2: 配置化

**目标**: 外部 JSON5 配置文件驱动路由

1. 设计路由规则配置 schema
2. 实现配置加载和验证 (Zod)
3. 支持多条件 AND 匹配
4. 添加 promptContains / promptRegex 匹配
5. 路由日志记录

**预计代码量**: ~300 行
**预计时间**: 2-4 小时

### Phase 3: 高级功能

**目标**: 生产级路由能力

1. 时间段路由
2. 路由规则热更新 (file watcher)
3. 路由决策指标 (配合 diagnostics-otel extension)
4. 负载均衡策略 (round-robin, weighted)
5. prompt 分类器 (基于关键词/正则)

**预计代码量**: ~500 行
**预计时间**: 4-8 小时

### Phase 4: 企业增强 (可选)

**目标**: 企业级运维功能

1. CLI 子命令 (`api.registerCli`) 用于查看/管理路由规则
2. HTTP API (`api.registerHttpRoute`) 用于动态更新路由
3. 路由统计面板 (配合 Web UI)
4. 成本控制 (基于模型成本 + 使用量的路由决策)
