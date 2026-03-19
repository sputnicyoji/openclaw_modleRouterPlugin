# OpenClaw 工程全面分析报告

> 分析日期: 2026-03-19 (深度更新)
> 版本: OpenClaw v2026.3.14
> 分析范围: 项目架构、插件系统、模型路由机制、扩展体系、代码级实现细节

---

## 目录

1. [项目概况](#1-项目概况)
2. [Monorepo 结构](#2-monorepo-结构)
3. [技术栈](#3-技术栈)
4. [核心源码结构](#4-核心源码结构)
5. [插件系统架构](#5-插件系统架构)
6. [模型路由系统](#6-模型路由系统)
7. [钩子系统](#7-钩子系统)
8. [Provider 插件接口](#8-provider-插件接口)
9. [Extension 扩展体系](#9-extension-扩展体系)
10. [Skills 技能系统](#10-skills-技能系统)
11. [MCP 集成](#11-mcp-集成)
12. [配置系统](#12-配置系统)
13. [Auth Profile 与冷却管理](#13-auth-profile-与冷却管理)
14. [完整调用链](#14-完整调用链)
15. [参考实现深度分析](#15-参考实现深度分析)
16. [构建 modelRouterPlugin 的关键文件](#16-构建-modelrouterplugin-的关键文件)
17. [总结与建议](#17-总结与建议)

---

## 1. 项目概况

**OpenClaw** 是一个自托管的**多通道 AI 网关**，核心价值是作为可扩展的中间件，将各种即时通讯平台桥接到多个 LLM 后端。

### 支持的消息通道 (30+)

WhatsApp, Telegram, Discord, Slack, iMessage, Signal, IRC, Matrix, MS Teams, Google Chat, Feishu, LINE, Nostr, Nextcloud Talk, Synology Chat, Twitch, Zalo, Mattermost, BlueBubbles, Tlon 等。

### 支持的 AI 提供者

Anthropic, OpenAI, OpenRouter, Google, Amazon Bedrock, Ollama, Mistral, HuggingFace, Moonshot, Minimax, NVIDIA, xAI, Together, Venice, vLLM, SGLang, BytePlus, Volcengine, Qianfan, ModelStudio, KiloCode, Kimi Coding, Perplexity, Cloudflare AI Gateway, Vercel AI Gateway, Microsoft, GitHub Copilot 等。

---

## 2. Monorepo 结构

pnpm workspace (`pnpm-workspace.yaml`) 定义了四个工作区根目录:

```
. (root)          - 主 openclaw 包 (核心 + 插件 SDK)
ui/               - Web UI (Vite + Lit Web Components 控制面板)
packages/*        - 内部包: clawdbot (兼容层), moltbot
extensions/*      - Provider 和 Channel 插件 (~80+ 扩展)
```

### 顶层目录映射

| 路径 | 用途 |
|------|------|
| `src/` | 所有核心 TypeScript 源码 |
| `extensions/` | Provider + Channel 插件 (workspace packages) |
| `packages/` | `clawdbot/` (兼容层), `moltbot/` |
| `ui/` | Web 控制面板 (Vite + Lit Web Components) |
| `skills/` | 内置技能定义 (50+ 技能) |
| `apps/` | 原生应用: iOS, macOS, Android |
| `docs/` | Mintlify 文档 |
| `openclaw.mjs` | 主 CLI 入口 |

---

## 3. 技术栈

| 类别 | 技术 |
|------|------|
| 语言 | TypeScript (ESM-first, strict mode) |
| 运行时 | Node.js 22+ (兼容 Bun) |
| 构建工具 | tsdown (bundles), tsc (Plugin SDK DTS), Vite (UI) |
| 测试框架 | Vitest 4.x (unit, gateway, channels, extensions, e2e) |
| Lint/Format | Oxlint + Oxfmt |
| Schema 验证 | Zod 4.x + `@sinclair/typebox` |
| HTTP 框架 | Hono (网关层), Express (部分辅助) |
| WebSocket | `ws` |
| 配置 | JSON5 (via `jiti`) |
| AI SDK 核心 | `@mariozechner/pi-agent-core`, `@mariozechner/pi-ai`, `@mariozechner/pi-coding-agent`, `@mariozechner/pi-tui` |
| MCP | `@modelcontextprotocol/sdk` |
| ACP | `@agentclientprotocol/sdk` |
| 文档 | Mintlify |
| 原生应用 | Swift (iOS/macOS), Kotlin (Android) |

---

## 4. 核心源码结构

`src/` 下的关键子目录:

| 目录 | 职责 |
|------|------|
| `src/agents/` | LLM 模型加载、模型目录、模型回退、Provider 发现、沙箱、Auth Profile、技能 |
| `src/routing/` | **Agent 路由引擎** -- 将入站 channel+account+peer 映射到 agent+session |
| `src/config/` | 配置 Schema (Zod)、加载、验证、迁移、类型 |
| `src/gateway/` | **主网关服务器** (WebSocket + HTTP)、启动、会话管理 |
| `src/channels/` | Channel 插件基础设施 |
| `src/plugin-sdk/` | 公共插件 SDK (从内部模块 re-export) |
| `src/plugins/` | 插件系统: 注册表、运行时、发现、认证流程 |
| `src/providers/` | Provider 特定辅助 (GitHub Copilot auth, Google shared, Qwen OAuth) |
| `src/commands/` | CLI 命令实现 (onboard, models, agents, status, doctor 等) |
| `src/cli/` | CLI 参数解析、进度条、Profile 处理 |
| `src/auto-reply/` | 回复管道、思考/推理逻辑 |
| `src/secrets/` | Secret 解析 (env, file, exec 来源) |
| `src/hooks/` | 钩子系统 |
| `src/memory/` | 记忆子系统 |
| `src/tts/` | TTS 提供者 |
| `src/image-generation/` | 图像生成管道 |
| `src/media-understanding/` | 多模态媒体理解 |
| `src/web-search/` | Web 搜索抽象 |
| `src/sessions/` | 会话持久化 |
| `src/security/` | 安全策略 |
| `src/infra/` | 基础设施工具 |

---

## 5. 插件系统架构

插件系统是 OpenClaw 最核心的架构组件。所有能力 -- AI Provider、消息通道、工具、钩子、MCP 服务器、CLI 命令、语音、图像生成、Web 搜索 -- 都以插件形式注册。

### 5.1 插件清单: `openclaw.plugin.json`

每个扩展都有一个清单文件:

```json
{
  "id": "anthropic",
  "providers": ["anthropic"],
  "providerAuthEnvVars": { "anthropic": "ANTHROPIC_API_KEY" },
  "providerAuthChoices": [...],
  "configSchema": {...}
}
```

### 5.2 插件入口: `definePluginEntry()`

**文件**: `src/plugin-sdk/plugin-entry.ts`

```typescript
type DefinePluginEntryOptions = {
  id: string;
  name: string;
  description: string;
  kind?: OpenClawPluginDefinition["kind"];   // "memory" | "context-engine"
  configSchema?: OpenClawPluginConfigSchema | (() => OpenClawPluginConfigSchema);
  register: (api: OpenClawPluginApi) => void;  // 必须同步
};
```

**configSchema** 接受 Zod schema 形状的对象 (有 `safeParse/parse`)，或自定义 `validate` 函数，也可传返回 schema 的函数 (惰性初始化):

```typescript
type OpenClawPluginConfigSchema = {
  safeParse?: (value: unknown) => { success: boolean; data?: unknown; error?: { issues?: ... } };
  parse?: (value: unknown) => unknown;
  validate?: (value: unknown) => PluginConfigValidation;
  uiHints?: Record<string, PluginConfigUiHint>;
  jsonSchema?: Record<string, unknown>;
};
```

Channel 插件使用 `defineChannelPluginEntry()` (自动调用 `api.registerChannel()`)。

**关键约束**: `register(api)` **必须同步**。异步返回值被丢弃并发出 diagnostic 警告。

### 5.3 OpenClawPluginApi: 注册接口

`register(api)` 回调中的 `api` 对象提供以下注册方法:

| 方法 | 注册内容 |
|------|----------|
| `api.registerProvider(provider)` | AI 推理提供者 |
| `api.registerChannel(registration)` | 消息通道插件 |
| `api.registerTool(tool, opts)` | AI Agent 工具 (函数调用) |
| `api.on(hookName, handler, opts)` | 类型化生命周期钩子 (推荐) |
| `api.registerHook(events, handler, opts)` | 遗留文件钩子 |
| `api.registerHttpRoute(params)` | HTTP 路由 |
| `api.registerGatewayMethod(method, handler)` | 网关 JSON-RPC 方法 |
| `api.registerCli(registrar, opts)` | CLI 子命令 (commander.js) |
| `api.registerService(service)` | 后台服务 |
| `api.registerSpeechProvider(provider)` | TTS 提供者 |
| `api.registerMediaUnderstandingProvider(provider)` | 视觉/音频提供者 |
| `api.registerImageGenerationProvider(provider)` | 图像生成提供者 |
| `api.registerWebSearchProvider(provider)` | Web 搜索提供者 |
| `api.registerInteractiveHandler(registration)` | 交互按钮回调 |
| `api.registerCommand(command)` | 插件命令 (绕过 LLM 的斜杠命令) |
| `api.registerContextEngine(id, factory)` | 自定义上下文/压缩引擎 |
| `api.onConversationBindingResolved(handler)` | 会话绑定解析事件 |

**`api.on()` 方法签名** (`types.ts:1346`):

```typescript
on: <K extends PluginHookName>(
  hookName: K,
  handler: PluginHookHandlerMap[K],
  opts?: { priority?: number },
) => void;
```

### 5.4 插件加载流程

**文件**: `src/plugins/loader.ts` (1259 行)

**发现阶段** (`discoverOpenClawPlugins()`):

1. 扫描目录 (按优先级):
   - `config loadPaths` (配置指定的额外路径)
   - `global` = `~/.openclaw/extensions/` (用户全局安装)
   - `stock` = 内置插件目录
   - `workspace` = `.openclaw/extensions/` (项目本地)
2. 安全检查: 路径包含、文件权限、所有权验证
3. 读取每个候选的 `package.json` 提取元数据

**去重规则** (`compareDuplicateCandidateOrder()`):
- 优先级: config > global explicit install > bundled > workspace > other
- `seenIds` map 防止同一 pluginId 被注册两次

**Jiti 别名机制** (核心实现):
- 创建两个 jiti 实例 (`tryNative=true` 和 `false`)，通过 `shouldPreferNativeJiti()` 选择
- `aliasMap` 将 `"openclaw/plugin-sdk"` 映射到 `root-alias.cjs`
- `resolvePluginSdkScopedAliasMap()` 生成所有子路径别名
- 这使插件 `import "openclaw/plugin-sdk/..."` 能在运行时解析到正确的模块

**注册模式 (registrationMode)**:
- `"full"` -- 普通完整注册
- `"setup-runtime"` -- channel 插件的轻量启动入口
- `"setup-only"` -- 未启用的 channel 插件 (仅 setup)
- `null` -- 跳过 (disabled)

**Register 调用**:
```typescript
const result = register(api);
if (result && typeof result.then === "function") {
  // 警告: async register 被忽略
}
```

**缓存**: `registryCache: Map<string, PluginRegistry>` 最多 128 条，LRU 驱逐。

**激活**: 调用 `activatePluginRegistry()` 设置全局注册表并初始化钩子运行器。

### 5.5 插件注册表

`createPluginRegistry()` 返回的注册表包含:

```
PluginRegistry {
  plugins: PluginRecord[]
  tools: PluginToolRegistration[]
  hooks: PluginHookRegistration[]
  typedHooks: TypedPluginHookRegistration[]
  channels: PluginChannelRegistration[]
  providers: PluginProviderRegistration[]
  speechProviders, mediaUnderstandingProviders, imageGenerationProviders, webSearchProviders
  gatewayHandlers: GatewayRequestHandlers
  httpRoutes: PluginHttpRouteRegistration[]
  cliRegistrars: PluginCliRegistration[]
  services: PluginServiceRegistration[]
  commands: PluginCommandRegistration[]
  diagnostics: PluginDiagnostic[]
}
```

**关键约束**:
- 重复的 provider/channel/hook/gateway-method 注册会被拒绝并生成诊断
- HTTP 路由在不同 auth 模式之间的重叠会被拒绝
- 第三方插件的 prompt 注入钩子可通过 `plugins.entries.<id>.hooks.allowPromptInjection=false` 约束

### 5.6 插件 SDK 导出

`package.json` 定义了约 80 个命名子路径导出:

- `./plugin-sdk/plugin-entry`, `./plugin-sdk/runtime`, `./plugin-sdk/runtime-env`
- `./plugin-sdk/provider-setup`, `./plugin-sdk/provider-auth`, `./plugin-sdk/provider-catalog`
- `./plugin-sdk/provider-stream`, `./plugin-sdk/provider-usage`, `./plugin-sdk/provider-models`
- `./plugin-sdk/channel-setup`, `./plugin-sdk/channel-runtime`, `./plugin-sdk/channel-lifecycle`
- `./plugin-sdk/routing`, `./plugin-sdk/gateway-runtime`, `./plugin-sdk/agent-runtime`
- `./plugin-sdk/hook-runtime`
- 各 Channel 专用: `./plugin-sdk/telegram`, `./plugin-sdk/discord`, `./plugin-sdk/slack` 等

**边界强制**: 扩展禁止从 `src/` 直接导入或从整体 `./plugin-sdk` 入口导入，由自定义 lint 规则强制执行。

---

## 6. 模型路由系统

这是项目名 `modleRouterPlugin` 的核心关注点。模型路由分为两层:

### 6.1 Agent/会话路由

**文件**: `src/routing/resolve-route.ts` (805 行)

将入站消息 (channel + account + peer/group) 映射到特定 agent 配置。`resolveAgentRoute()` 实现**分级绑定系统**:

| 优先级 | 绑定类型 | 说明 |
|--------|----------|------|
| 1 (最高) | `binding.peer` | 精确 peer (DM/group/channel) 匹配 |
| 2 | `binding.peer.parent` | 线程父 peer 匹配 |
| 3 | `binding.guild+roles` | Discord guild + 成员角色 |
| 4 | `binding.guild` | Discord guild (任意角色) |
| 5 | `binding.team` | MSTeams team 匹配 |
| 6 | `binding.account` | 特定 account ID |
| 7 | `binding.channel` | 该 channel 上的任意 account |
| 8 (最低) | `default` | 回退到默认 agent |

**缓存机制** (三级 WeakMap):
- `agentLookupCacheByCfg` -- agent ID 规范化索引
- `evaluatedBindingsCacheByCfg` -- 预处理 binding 索引，MAX 2000 条
- `resolvedRouteCacheByCfg` -- 最终路由结果，MAX 4000 条
- **当 verbose 日志开启或有 identityLinks 时，路由缓存被禁用**

### 6.2 模型选择与引用

**文件**: `src/agents/model-selection.ts`

- 模型引用格式: `provider/modelId` (如 `anthropic/claude-opus-4-6`, `openrouter/auto`)
- `ModelRef = { provider: string; model: string }`
- `parseModelRef()` 和 `normalizeModelRef()` 处理 Provider 特定的归一化
- 默认: `DEFAULT_PROVIDER = "anthropic"`, `DEFAULT_MODEL = "claude-opus-4-6"`

### 6.3 模型解析流程 (深度分析)

**文件**: `src/agents/pi-embedded-runner/model.ts`

`resolveModelAsync(provider, modelId, agentDir, cfg)` 的解析顺序:

```
1. resolveExplicitModelWithRegistry
   -> modelRegistry.find(provider, modelId) 在 models.json 中查找
   -> shouldSuppressBuiltInModel() 检查 -- 如果被抑制则报错

2. applyConfiguredProviderOverrides()
   -> 合并配置文件中的 baseUrl, api, headers 等

3. normalizeResolvedModel()
   -> 触发 ProviderPlugin.normalizeResolvedModel() 进行传输层重写

4. 若不在注册表中:
   -> cfg.models.providers[provider].models 中查找内联配置 (需要有 api 字段)

5. runProviderDynamicModel()
   -> 调用 ProviderPlugin.resolveDynamicModel() (同步回退, 无 I/O)

6. Config inline provider 回退
   -> 只要 providerConfig 存在或 modelId 以 "mock-" 开头，构造最小 Model 对象

7. ProviderPlugin.prepareDynamicModel()
   -> 异步预取, 然后重试上述步骤
```

### 6.4 模型回退链 (深度分析)

**文件**: `src/agents/model-fallback.ts` (829 行)

`runWithModelFallback()` 包装推理运行在回退循环中:

```typescript
async function runWithModelFallback<T>(params: {
  cfg: OpenClawConfig | undefined;
  provider: string;
  model: string;
  runId?: string;
  agentDir?: string;
  fallbacksOverride?: string[];
  run: (provider: string, model: string, options?: ModelFallbackRunOptions) => Promise<T>;
  onError?: (attempt: { provider, model, error, attempt, total }) => void | Promise<void>;
}): Promise<ModelFallbackRunResult<T>>
```

**核心逻辑**:
1. `resolveFallbackCandidates()` 构建 candidate 列表 (primary + fallbacks), 去重
2. 遍历每个 candidate, 先检查 auth profile 冷却状态:
   - `auth` / `auth_permanent` -> 直接跳过整个 provider
   - `billing` -> 仅在 isPrimary 且 probe throttle 开放时才尝试
   - `rate_limit` / `overloaded` / `unknown` -> `resolveCooldownDecision` 决定是否跳过或探针尝试
3. `runFallbackAttempt()` 执行实际 run
4. 失败时 `coerceToFailoverError()` 归一化错误
5. Context overflow 错误立即 rethrow (不进入下一候选)
6. 所有 candidates 失败后 `throwFallbackFailureSummary()`

**FailoverError** 类:
```typescript
class FailoverError extends Error {
  readonly reason: FailoverReason;
  // "rate_limit" | "billing" | "auth" | "auth_permanent" |
  // "overloaded" | "timeout" | "format" | "model_not_found" |
  // "session_expired" | "unknown"
  readonly provider?: string;
  readonly model?: string;
  readonly profileId?: string;
  readonly status?: number;   // HTTP status code
  readonly code?: string;     // 符号错误码如 RESOURCE_EXHAUSTED
}
```

### 6.5 Channel 级模型覆盖 (深度分析)

**文件**: `src/channels/model-overrides.ts` (143 行)

`resolveChannelModelOverride()` 返回:

```typescript
type ChannelModelOverride = {
  channel: string;
  model: string;
  matchKey?: string;
  matchSource?: ChannelMatchSource;
};
```

**工作流程**:
1. 读取 `cfg.channels?.modelByChannel` (类型 `Record<string, Record<string, string>>`)
2. 外层 key 是 channel ID, 内层 key 是 groupId/groupChannel/groupSubject 等候选值
3. `resolveProviderEntry()` 用规范化 channel 名匹配外层 key
4. `buildChannelCandidates()` 生成内层候选 key 列表 (支持 thread 后缀剥离、parent groupId 推断)
5. `resolveChannelEntryMatchWithFallback()` 用 `"*"` 作通配 key 匹配

**配置格式**:
```yaml
channels:
  modelByChannel:
    slack:
      "C1234567": "ollama/llama3.3:8b"
      "*": "anthropic/claude-haiku-4-5"
    telegram:
      "*": "openai/gpt-4o"
```

### 6.6 模型目录系统 (深度分析)

**文件**: `src/agents/model-catalog.ts` (291 行)

```typescript
type ModelCatalogEntry = {
  id: string;
  name: string;
  provider: string;
  contextWindow?: number;
  reasoning?: boolean;
  input?: ModelInputType[];  // "text" | "image" | "document"
};
```

`loadModelCatalog()` 异步加载，带单例 promise 缓存:

1. `ensureOpenClawModelsJson(cfg)` -- 确保 `models.json` 存在
2. 动态 import `pi-model-discovery-runtime.js`，用 `ModelRegistry` 读取 `{agentDir}/models.json`
3. `shouldSuppressBuiltInModel()` 过滤被抑制的模型
4. `mergeConfiguredOptInProviderModels()` -- 将非 pi-ai 原生 Provider (目前仅 `"kilocode"`) 的模型合并
5. `augmentModelCatalogWithProviderPlugins()` -- 让插件通过 `ProviderPlugin.augmentModelCatalog()` 注入额外模型条目
6. 去重后按 `provider + name` 排序返回

**错误韧性**: 出错时清空 promise 缓存让下次重试；若已有部分结果则仍返回，不毒化缓存。

---

## 7. 钩子系统 (深度分析)

**文件**: `src/plugins/hooks.ts`

### 7.1 全部 25 种钩子

```typescript
type PluginHookName =
  | "before_model_resolve"    | "before_prompt_build"     | "before_agent_start"
  | "llm_input"               | "llm_output"              | "agent_end"
  | "before_compaction"       | "after_compaction"         | "before_reset"
  | "inbound_claim"           | "message_received"         | "message_sending"
  | "message_sent"            | "before_tool_call"         | "after_tool_call"
  | "tool_result_persist"     | "before_message_write"     | "session_start"
  | "session_end"             | "subagent_spawning"        | "subagent_delivery_target"
  | "subagent_spawned"        | "subagent_ended"           | "gateway_start"
  | "gateway_stop";
```

### 7.2 执行模式

| 模式 | 行为 | 适用钩子 |
|------|------|----------|
| `runVoidHook` | 并行执行 (`Promise.all`), 无返回值 | `llm_input`, `llm_output`, `agent_end`, `message_received`, `message_sent`, `session_start/end` 等 |
| `runModifyingHook` | **按优先级顺序串行执行**, 结果合并 | `before_model_resolve`, `before_prompt_build`, `before_agent_start`, `message_sending`, `before_tool_call` 等 |
| `runClaimingHook` | 顺序执行, 首个 `{ handled: true }` 停止 | `inbound_claim` |
| 同步钩子 | 同步执行 (热路径) | `tool_result_persist`, `before_message_write` |

### 7.3 优先级排序机制

通过 `api.on(hookName, handler, { priority: N })` 注册。

```typescript
// hooks.ts:139-146
function getHooksForName<K extends PluginHookName>(
  registry: PluginRegistry,
  hookName: K,
): PluginHookRegistration<K>[] {
  return (registry.typedHooks as PluginHookRegistration<K>[])
    .filter((h) => h.hookName === hookName)
    .toSorted((a, b) => (b.priority ?? 0) - (a.priority ?? 0));
}
```

- **降序排列**: 高优先级先执行，默认优先级为 0
- `before_model_resolve` 使用 `runModifyingHook`，按优先级**串行**执行 (不是并行)
- 高优先级插件的路由决策通过 `??` 运算符保护，低优先级插件无法覆盖

### 7.4 `before_model_resolve` -- 模型路由钩子 (完整类型)

**事件和上下文类型** (`types.ts:1447-1471`):

```typescript
// Agent 上下文 (所有 agent 钩子共享)
type PluginHookAgentContext = {
  agentId?: string;
  sessionKey?: string;
  sessionId?: string;
  workspaceDir?: string;
  messageProvider?: string;
  trigger?: string;        // "user" | "heartbeat" | "cron" | "memory"
  channelId?: string;      // "telegram" | "discord" | "whatsapp" 等
};

// before_model_resolve 事件
type PluginHookBeforeModelResolveEvent = {
  prompt: string;  // 当前 prompt, 无 session messages
};

// before_model_resolve 返回值
type PluginHookBeforeModelResolveResult = {
  modelOverride?: string;     // 如 "llama3.3:8b"
  providerOverride?: string;  // 如 "ollama"
};
```

**Handler 类型签名**:

```typescript
type PluginHookHandlerMap = {
  before_model_resolve: (
    event: PluginHookBeforeModelResolveEvent,
    ctx: PluginHookAgentContext,
  ) =>
    | Promise<PluginHookBeforeModelResolveResult | void>
    | PluginHookBeforeModelResolveResult
    | void;
  // ... 其他钩子
};
```

**注册条目类型**:

```typescript
type PluginHookRegistration<K extends PluginHookName = PluginHookName> = {
  pluginId: string;
  hookName: K;
  handler: PluginHookHandlerMap[K];
  priority?: number;
  source: string;
};
```

### 7.5 钩子执行器核心实现

**`runBeforeModelResolve`** (`hooks.ts:429`):

```typescript
async function runBeforeModelResolve(
  event: PluginHookBeforeModelResolveEvent,
  ctx: PluginHookAgentContext,
): Promise<PluginHookBeforeModelResolveResult | undefined> {
  return runModifyingHook<"before_model_resolve", PluginHookBeforeModelResolveResult>(
    "before_model_resolve", event, ctx, mergeBeforeModelResolve,
  );
}
```

**结果合并函数** (`hooks.ts:163`) -- **first-defined-override-wins**:

```typescript
const mergeBeforeModelResolve = (
  acc: PluginHookBeforeModelResolveResult | undefined,
  next: PluginHookBeforeModelResolveResult,
): PluginHookBeforeModelResolveResult => ({
  modelOverride: acc?.modelOverride ?? next.modelOverride,
  providerOverride: acc?.providerOverride ?? next.providerOverride,
});
```

`??` 运算符确保高优先级钩子的结果被保留，后续低优先级钩子的返回值只有在对应字段为 `undefined` 时才会填入。

**`runModifyingHook` 核心** (`hooks.ts:269`):

```typescript
async function runModifyingHook<K extends PluginHookName, TResult>(
  hookName: K, event, ctx, mergeResults?,
): Promise<TResult | undefined> {
  const hooks = getHooksForName(registry, hookName);  // 按 priority 降序
  let result: TResult | undefined;

  for (const hook of hooks) {  // 串行执行
    try {
      const handlerResult = await hook.handler(event, ctx);
      if (handlerResult !== undefined && handlerResult !== null) {
        if (mergeResults && result !== undefined) {
          result = mergeResults(result, handlerResult);
        } else {
          result = handlerResult;
        }
      }
    } catch (err) {
      handleHookError({ hookName, pluginId: hook.pluginId, error: err });
    }
  }
  return result;
}
```

### 7.6 钩子结果在 run.ts 中的消费链

**文件**: `src/agents/pi-embedded-runner/run.ts` (关键片段)

```typescript
// 初始值
let provider = (params.provider ?? DEFAULT_PROVIDER).trim() || DEFAULT_PROVIDER;
let modelId = (params.model ?? DEFAULT_MODEL).trim() || DEFAULT_MODEL;

// hookCtx 构建
const hookCtx = {
  agentId: workspaceResolution.agentId,
  sessionKey: params.sessionKey,
  sessionId: params.sessionId,
  workspaceDir: resolvedWorkspace,
  messageProvider: params.messageProvider ?? undefined,
  trigger: params.trigger,
  channelId: params.messageChannel ?? params.messageProvider ?? undefined,
};

// 步骤1: 运行 before_model_resolve (新钩子, 优先)
if (hookRunner?.hasHooks("before_model_resolve")) {
  modelResolveOverride = await hookRunner.runBeforeModelResolve(
    { prompt: params.prompt }, hookCtx,
  );
}

// 步骤2: 运行 before_agent_start (旧兼容钩子, 只补充未设置的字段)
if (hookRunner?.hasHooks("before_agent_start")) {
  legacyResult = await hookRunner.runBeforeAgentStart(
    { prompt: params.prompt }, hookCtx,
  );
  modelResolveOverride = {
    providerOverride:
      modelResolveOverride?.providerOverride ?? legacyResult?.providerOverride,
    modelOverride:
      modelResolveOverride?.modelOverride ?? legacyResult?.modelOverride,
  };
}

// 步骤3: 应用 override (实际路由生效点)
if (modelResolveOverride?.providerOverride) {
  provider = modelResolveOverride.providerOverride;
}
if (modelResolveOverride?.modelOverride) {
  modelId = modelResolveOverride.modelOverride;
}

// 步骤4: 用覆盖后的 provider/modelId 执行模型解析
const { model, error, authStorage, modelRegistry } = await resolveModelAsync(
  provider, modelId, agentDir, params.config,
);
```

**完整的优先级链** (从高到低):
1. `before_model_resolve` 钩子 (plugin 路由逻辑)
2. `before_agent_start` 旧钩子 (仅补充未被 1 设置的字段)
3. `params.provider` / `params.model` (调用方传入的默认值)
4. `DEFAULT_PROVIDER` / `DEFAULT_MODEL` (`"anthropic"` / `"claude-opus-4-6"`)

### 7.7 测试验证的关键结论

**文件**: `src/plugins/hooks.model-override-wiring.test.ts`

1. **事件最小化**: event 只包含 `prompt`，没有 session messages
2. **新旧钩子优先级**: `before_model_resolve` 返回的 override 通过 `??` 屏蔽了旧钩子 `before_agent_start` 的相同字段
3. **错误隔离**: 一个插件崩溃不会阻断其他插件 (当 `catchErrors: true`，默认值)
4. **按需跳过**: `hasHooks()` 可独立检测每个钩子的注册状态，run.ts 用它跳过未注册钩子的调用

---

## 8. Provider 插件接口

**文件**: `src/plugins/types.ts`

`ProviderPlugin` 接口定义了 Provider 的完整生命周期:

| 方法 | 用途 |
|------|------|
| `auth[]` | 认证方式列表 (API key, OAuth, setup-token, device code, custom) |
| `catalog.run(ctx)` | 返回 Provider 配置 + 模型定义，合并到 `models.providers` |
| `resolveDynamicModel(ctx)` | 未知模型 ID 的同步回退 (无 I/O) |
| `prepareDynamicModel(ctx)` | `resolveDynamicModel` 重试前的异步预取 |
| `normalizeResolvedModel(ctx)` | 推理前重写已解析模型 (交换 API ID, 修补 URL) |
| `prepareRuntimeAuth(ctx)` | 将原始凭据交换为短期运行时令牌 + 可选 baseUrl 覆盖 |
| `resolveUsageAuth(ctx)` | 用量/计费端点的独立认证 |
| `fetchUsageSnapshot(ctx)` | Provider 特定的用量 HTTP 请求 |
| `prepareExtraParams(ctx)` | 流式前归一化额外推理参数 |
| `wrapStreamFn(ctx)` | 包装流式函数 (Provider 特定的 header/重写) |
| `isCacheTtlEligible(ctx)` | Prompt 缓存 TTL 资格 |
| `augmentModelCatalog(ctx)` | 向模型目录追加前向兼容条目 |
| `suppressBuiltInModel(ctx)` | 隐藏过时的内置目录条目 |
| `isModernModelRef(ctx)` | smoke/profile 过滤策略 |
| `isBinaryThinking(ctx)` | Provider 使用 on/off 思考切换 |
| `supportsXHighThinking(ctx)` | Provider 支持 xhigh 推理级别 |
| `resolveDefaultThinkingLevel(ctx)` | 模型族的默认思考级别 |

**Provider Runtime 分发函数** (`src/plugins/provider-runtime.ts`, 402 行):

```typescript
// 同步调用 provider 插件的 resolveDynamicModel
function runProviderDynamicModel(params): ProviderRuntimeModel | undefined {
  return resolveProviderRuntimePlugin(params)
    ?.resolveDynamicModel?.(params.context) ?? undefined;
}

// 运行 provider 的 normalizeResolvedModel 钩子
function normalizeProviderResolvedModelWithPlugin(params): ProviderRuntimeModel | undefined {
  return resolveProviderRuntimePlugin(params)
    ?.normalizeResolvedModel?.(params.context) ?? undefined;
}

// 异步调用 provider 的 prepareRuntimeAuth
async function prepareProviderRuntimeAuth(params) {
  return await resolveProviderRuntimePlugin(params)
    ?.prepareRuntimeAuth?.(params.context);
}
```

所有分发函数依赖 `resolveProviderRuntimePlugin()`，通过 plugin id 从注册表找到 `ProviderPlugin`，有 WeakMap 缓存。

**支持的 API 协议类型**:
- `openai-completions`
- `openai-responses`
- `openai-codex-responses`
- `anthropic-messages`
- `google-generative-ai`
- `github-copilot`
- `bedrock-converse-stream`
- `ollama`

---

## 9. Extension 扩展体系

**位置**: `extensions/`

### 9.1 标准布局

Channel 扩展:
```
extensions/<name>/
  index.ts              - 主插件入口 (defineChannelPluginEntry)
  setup-entry.ts        - 轻量 setup-only 入口
  runtime-api.ts        - 插件自身 SDK 子路径 re-export
  api.ts                - 公共类型/辅助
  src/
    config-schema.ts
    channel.ts / channel.runtime.ts / channel.setup.ts
    accounts.ts
    monitor.ts          - 入站消息监控
    send.ts             - 出站消息发送
    runtime.ts
```

Provider 扩展 (更简单):
```
extensions/<provider>/
  index.ts              - definePluginEntry + api.registerProvider(...)
  provider-catalog.ts
  onboard.ts
  model-definitions.ts
```

### 9.2 边界约束

扩展必须只从 `openclaw/plugin-sdk/*` 子路径导入，禁止:
- 从 `openclaw/src/` 直接导入
- 从其他扩展的 `src/` 导入
- 使用整体 `./plugin-sdk` 入口

由自定义 lint 脚本强制执行 (`scripts/check-extension-plugin-sdk-boundary.mjs`)。

### 9.3 扩展分类

**AI Provider 扩展**: anthropic, openai, openrouter, google, amazon-bedrock, ollama, mistral, huggingface, moonshot, minimax, nvidia, xai, together, chutes, venice, vllm, sglang, byteplus, volcengine, qianfan, modelstudio, kilocode, kimi-coding, perplexity, cloudflare-ai-gateway, vercel-ai-gateway, microsoft, github-copilot, copilot-proxy, opencode, zai, fal, elevenlabs

**消息通道扩展**: telegram, discord, slack, whatsapp, signal, matrix, mattermost, msteams, irc, feishu, googlechat, imessage, bluebubbles, line, nostr, nextcloud-talk, tlon, zalo, synology-chat, twitch, lobster

**功能扩展**: memory-core, memory-lancedb, llm-task, diffs, diagnostics-otel, device-pair, acpx, voice-call, open-prose, openshell, brave, firecrawl, thread-ownership, phone-control, talk-voice

---

## 10. Skills 技能系统

**位置**: `skills/`

技能是**基于 Markdown 的 Agent 能力描述**，而非 TypeScript 代码:

```yaml
---
name: voice-call
description: Start voice calls via the OpenClaw voice-call plugin.
metadata:
  {
    "openclaw": {
      "emoji": "...",
      "skillKey": "voice-call",
      "requires": { "config": ["plugins.entries.voice-call.enabled"] }
    }
  }
---
```

主体是描述 CLI、工具和使用模式的 Markdown 文档。

### 部分内置技能

- **消息集成**: discord, slack, imsg, wacli
- **AI 工具**: coding-agent, gemini, openai-image-gen, openai-whisper
- **生产力**: github, gh-issues, notion, obsidian, trello, things-mac
- **系统**: tmux, peekaboo, camsnap, healthcheck
- **媒体**: video-frames, songsee, spotify-player
- **特殊**: oracle, session-logs, model-usage, skill-creator, clawhub

---

## 11. MCP 集成

**文件**: `src/plugins/bundle-mcp.ts`

MCP (Model Context Protocol) 通过 **bundle 格式**集成。Bundle 插件不是 TypeScript openclaw 插件，而是包含外部工具配置的目录。

### 支持的 Bundle 格式

| 格式 | 来源 |
|------|------|
| `claude` | Claude Desktop (`.claude/mcp.json`, `.mcp.json`, `claude_desktop_config.json`) |
| `codex` | OpenAI Codex (`codex.json`) |
| `cursor` | Cursor IDE (`.cursor/mcp.json`) |

`loadEnabledBundleMcpConfig()` 遍历所有启用的 bundle 插件，读取 MCP 服务器配置，深度合并，路径绝对化，展开 `${CLAUDE_PLUGIN_ROOT}` 占位符。

依赖: `@modelcontextprotocol/sdk` v1.27.1

---

## 12. 配置系统 (深度分析)

配置文件为 JSON5 格式，从 `~/.openclaw/` 或 per-agent 目录加载。所有配置均由 Zod Schema 验证。

### 关键配置段

| 配置段 | 类型 | 用途 |
|--------|------|------|
| `agents.list[]` | Array | 多 Agent 定义 (模型、系统 prompt、工具) |
| `agents.defaults` | Object | 默认 Agent 设置 |
| `bindings[]` | Array | Agent 路由规则 |
| `models.providers` | Record | 模型 Provider 配置 (baseUrl, apiKey, models) |
| `models.mode` | `"merge"/"replace"` | 合并或替换内置 Provider |
| `models.bedrockDiscovery` | Object | AWS Bedrock 自动发现 |
| `channels.*` | Nested | 每个 Channel 的配置 |
| `secrets.providers` | Record | Secret 来源: env/file/exec |
| `session` | Object | DM 范围、身份链接 |
| `hooks` | Object | 事件钩子映射 |
| `tools` | Object | 工具权限、媒体理解 |
| `tts` | Object | TTS 配置 |
| `memory` | Object | 记忆后端配置 |
| `skills` | Object | 技能配置 |
| `plugins.allow` | Array | 允许的插件列表 |
| `plugins.entries` | Record | 每插件配置 |

### 模型配置类型 (完整)

**文件**: `src/config/types.models.ts`

```typescript
// 单个模型定义
type ModelDefinitionConfig = {
  id: string;
  name: string;
  api?: ModelApi;  // "openai-completions" | "anthropic-messages" | "ollama" 等
  reasoning: boolean;
  input: Array<"text" | "image">;
  cost: { input: number; output: number; cacheRead: number; cacheWrite: number };
  contextWindow: number;
  maxTokens: number;
  headers?: Record<string, string>;
  compat?: ModelCompatConfig;
};

// 单个 Provider 配置
type ModelProviderConfig = {
  baseUrl: string;
  apiKey?: SecretInput;
  auth?: ModelProviderAuthMode;  // "api-key" | "aws-sdk" | "oauth" | "token"
  api?: ModelApi;
  injectNumCtxForOpenAICompat?: boolean;
  headers?: Record<string, SecretInput>;
  authHeader?: boolean;
  models: ModelDefinitionConfig[];
};

// 顶层 models 配置
type ModelsConfig = {
  mode?: "merge" | "replace";
  providers?: Record<string, ModelProviderConfig>;
  bedrockDiscovery?: BedrockDiscoveryConfig;
};
```

### Secret 引用

支持三种来源:

```yaml
# 环境变量
apiKey:
  source: "env"
  provider: "default"
  id: "OPENAI_API_KEY"

# 文件 (JSON pointer)
apiKey:
  source: "file"
  path: "/path/to/secrets.json"
  pointer: "/openai/key"

# 外部命令
apiKey:
  source: "exec"
  command: "op read op://vault/openai/key"
```

---

## 13. Auth Profile 与冷却管理 (深度分析)

**文件**: `src/agents/auth-profiles/`

### 13.1 核心类型

```typescript
// 凭据类型
type AuthProfileCredential = ApiKeyCredential | TokenCredential | OAuthCredential;

// 失败原因枚举
type AuthProfileFailureReason =
  | "auth" | "auth_permanent" | "format" | "overloaded"
  | "rate_limit" | "billing" | "timeout"
  | "model_not_found" | "session_expired" | "unknown";

// Profile 使用统计
type ProfileUsageStats = {
  lastUsed?: number;
  cooldownUntil?: number;
  disabledUntil?: number;
  disabledReason?: string;
  errorCount?: number;
  failureCounts?: Record<string, number>;
};

// Auth Profile 存储
type AuthProfileStore = {
  version: number;
  profiles: Record<string, AuthProfileCredential>;
  order?: string[];
  lastGood?: string;
  usageStats?: Record<string, ProfileUsageStats>;
};
```

### 13.2 冷却时间计算

**文件**: `auth-profiles/usage.ts`

`calculateAuthProfileCooldownMs(errorCount)` -- 指数退避:

```
min(1 hour, 5min * 5^min(errorCount-1, 3))
```

| 错误次数 | 冷却时间 |
|----------|----------|
| 1 | 5 分钟 |
| 2 | 25 分钟 |
| 3+ | 1 小时 (上限) |

**两类不可用状态**:
- `cooldownUntil` -- 临时冷却 (rate_limit/overloaded 等)
- `disabledUntil` -- 长期禁用 (billing/auth_permanent)，基础 5h，最大 24h

### 13.3 Profile 排序

**文件**: `auth-profiles/order.ts`

`resolveAuthProfileOrder()` 流程:
1. 清除过期冷却 (`clearExpiredCooldowns`)
2. 读取显式顺序: `store.order` > `cfg.auth.order` > `cfg.auth.profiles` 顺序 > store 扫描
3. 有显式顺序时: 按可用/冷却分组，冷却的按 `cooldownUntil` 从近到远排末尾
4. 无显式顺序时: `orderProfilesByMode()` -- 按类型优先 (oauth > token > api_key)，同类型按 `lastUsed` 最旧优先 (round-robin)
5. `preferredProfile` 始终置顶

### 13.4 冷却探针机制

与 `runWithModelFallback()` 配合:

- `MIN_PROBE_INTERVAL_MS = 30_000` (30 秒) -- 同 provider 两次探针间的最小间隔
- `PROBE_MARGIN_MS = 2 * 60 * 1000` (2 分钟) -- 在冷却到期前 2 分钟开始探针
- 每次 fallback run 中每个 provider 至多探针一次 (`cooldownProbeUsedProviders`)

**Bypass 特例**: `openrouter` 和 `kilocode` provider 完全绕过冷却机制。

---

## 14. 完整调用链

```
用户消息 (任意 Channel)
        |
  [Channel Plugin]  extensions/<channel>/src/monitor.ts
        |
  [inbound_claim Hook]  runInboundClaim() -- 首个 {handled:true} 胜出
        |
  [Plugin Commands]  匹配则绕过 LLM
        |
  [Agent Route Resolution]  resolveAgentRoute()
        |                    7级绑定 + 三级 WeakMap 缓存 (4000 key)
        |
  [Channel Model Override]  resolveChannelModelOverride()
        |                    cfg.channels.modelByChannel -> 二级 key 匹配
        |
  [before_model_resolve Hook]  ** 模型路由插件切入点 **
        |                       返回 { modelOverride, providerOverride }
        |                       串行按 priority 降序执行
        |                       first-defined-override-wins 合并
        |
  [before_agent_start Hook]  旧兼容钩子
        |                     仅补充 before_model_resolve 未设置的字段
        |
  [Model Resolution]  resolveModelAsync()
        |              catalog -> config inline -> dynamic -> prepareDynamic retry
        |
  [Auth Preparation]  resolveAuthProfileOrder() + prepareProviderRuntimeAuth()
        |              profile 排序 -> 冷却检查 -> 凭据交换
        |
  [Model Fallback Loop]  runWithModelFallback()
        |                  primary -> fallbacks[] -> auth profile rotation
        |                  冷却探针 (30s 间隔, 到期前 2min 开始)
        |                  FailoverError 归一化 -> 下一候选
        |
  [before_prompt_build Hook]  系统 prompt 注入
        |
  [prepareExtraParams]  Provider 特定参数
        |
  [wrapStreamFn]  Provider 特定流包装
        |
  [@mariozechner/pi-ai]  推理引擎执行
        |
  [llm_input / llm_output Hooks]  可观测性
        |
  [Tool Execution]  before_tool_call -> 执行 -> after_tool_call -> tool_result_persist
        |
  [message_sending Hook]  内容过滤/取消
        |
  [Channel Plugin]  extensions/<channel>/src/send.ts
        |
  [message_sent Hook]  可观测性
```

---

## 15. 参考实现深度分析

### 15.1 OpenRouter 扩展

**文件**: `extensions/openrouter/index.ts` (159 行) -- 最佳参考实现

**注册方式**:
```typescript
export default definePluginEntry({
  id: "openrouter",
  name: "OpenRouter Provider",
  description: "Bundled OpenRouter provider plugin",
  register(api) {
    api.registerProvider({ ... });
  },
});
```

**动态模型解析 (二阶段)**:
```typescript
// 同步阶段: 直接用 modelId 构建 ProviderRuntimeModel
resolveDynamicModel: (ctx) => buildDynamicOpenRouterModel(ctx),

// 异步预热: 如果需要网络获取 capabilities
prepareDynamicModel: async (ctx) => {
  await loadOpenRouterModelCapabilities(ctx.modelId);
},
```

`buildDynamicOpenRouterModel` 返回的模型对象:
```typescript
{
  id: ctx.modelId,
  name: capabilities?.name ?? ctx.modelId,
  api: "openai-completions",
  provider: PROVIDER_ID,
  baseUrl: OPENROUTER_BASE_URL,
  reasoning: capabilities?.reasoning ?? false,
  input: capabilities?.input ?? ["text"],
  cost: capabilities?.cost ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: capabilities?.contextWindow ?? DEFAULT_CONTEXT_TOKENS,
  maxTokens: capabilities?.maxTokens ?? OPENROUTER_DEFAULT_MAX_TOKENS,
}
```

**Stream 包装** (三层):
```typescript
wrapStreamFn: (ctx) => {
  let streamFn = ctx.streamFn;
  // 1. 注入 provider routing 元数据
  streamFn = injectOpenRouterRouting(streamFn, providerRouting);
  // 2. 包装 reasoning 级别
  streamFn = createOpenRouterWrapper(streamFn, openRouterThinkingLevel);
  // 3. 包装 system cache 头
  streamFn = createOpenRouterSystemCacheWrapper(streamFn);
  return streamFn;
},
```

### 15.2 Ollama 扩展

**文件**: `extensions/ollama/index.ts` (124 行) -- 本地 Provider 参考

**关键特性**:
- 使用 `discovery` (旧 API, 等同 `catalog`) + `order: "late"` 延迟执行
- 自动检测本地 Ollama 实例
- 没有 `resolveDynamicModel` -- 在 catalog/discovery 时就列出所有模型
- Auth 使用 `kind: "custom"` -- 有交互式和非交互式两条路径
- `onModelSelected` 自动拉取未下载的模型

```typescript
onModelSelected: async ({ config, model, prompter }) => {
  if (!model.startsWith("ollama/")) return;
  await providerSetup.ensureOllamaModelPulled({ config, model, prompter });
},
```

---

## 16. 构建 modelRouterPlugin 的关键文件

### 核心模型流

| 文件 | 内容 |
|------|------|
| `src/agents/pi-embedded-runner/run.ts` | 嵌入式运行器入口，钩子触发和模型选择 |
| `src/agents/pi-embedded-runner/model.ts` | `resolveModel`, `resolveModelAsync`, `resolveModelWithRegistry` |
| `src/agents/model-selection.ts` | `parseModelRef`, `normalizeModelRef`, `resolveConfiguredModelRef` |
| `src/agents/model-fallback.ts` | `runWithModelFallback`, 回退循环 + 冷却/探测逻辑 |
| `src/agents/model-catalog.ts` | `loadModelCatalog`, 目录构建和扩充 |
| `src/agents/defaults.ts` | 默认 provider/model 常量 |
| `src/agents/failover-error.ts` | `FailoverError` 类定义和 `coerceToFailoverError` |

### 插件扩展接口

| 文件 | 内容 |
|------|------|
| `src/plugins/types.ts` | `ProviderPlugin`, `OpenClawPluginApi`, 所有钩子类型 |
| `src/plugins/hooks.ts` | `createHookRunner`, `runBeforeModelResolve`, 所有钩子执行逻辑 |
| `src/plugins/provider-runtime.ts` | Provider 钩子分发函数 (402 行) |
| `src/plugins/loader.ts` | 插件发现、加载、jiti 别名、注册 (1259 行) |
| `src/plugin-sdk/plugin-entry.ts` | `definePluginEntry` 入口 |
| `src/plugin-sdk/core.ts` | `definePluginEntry`, `defineChannelPluginEntry`, `defineSetupPluginEntry` |

### 配置与路由

| 文件 | 内容 |
|------|------|
| `src/config/types.models.ts` | `ModelProviderConfig`, `ModelDefinitionConfig`, `ModelsConfig` |
| `src/channels/model-overrides.ts` | `resolveChannelModelOverride` (143 行) |
| `src/routing/resolve-route.ts` | `resolveAgentRoute` (805 行) |
| `src/agents/models-config.ts` | `ensureOpenClawModelsJson`, models.json 生命周期 |
| `src/agents/auth-profiles/` | Auth Profile 管理、冷却、排序 |

### 参考实现

| 文件 | 内容 |
|------|------|
| `extensions/openrouter/index.ts` | 最佳参考实现 (含动态模型和流包装, 159 行) |
| `extensions/ollama/index.ts` | 本地 Provider 参考 (124 行) |
| `extensions/anthropic/index.ts` | Anthropic Provider 参考实现 |
| `src/plugins/hooks.model-override-wiring.test.ts` | 路由钩子测试用例 |
| `src/plugins/hooks.phase-hooks.test.ts` | 优先级排序测试 |

### 运行时 API

| 文件 | 内容 |
|------|------|
| `src/plugins/runtime/types-core.ts` | `PluginRuntimeCore` -- 完整运行时 API |
| `src/plugins/runtime/types.ts` | `PluginRuntime` 类型 |
| `src/plugin-sdk/routing.ts` | 会话 key / 路由解析导出 |
| `src/plugin-sdk/provider-models.ts` | Provider/模型 SDK 导出 |

---

## 17. 总结与建议

### 架构评估

OpenClaw 是一个**成熟、架构完善的多通道 AI 网关**，具备:

- **完整的插件生态**: 80+ 扩展覆盖主流 AI Provider 和消息通道
- **灵活的模型路由**: 通过 `before_model_resolve` 钩子 + 回退链 + Channel 覆盖实现多层路由
- **类型安全**: 全 TypeScript, Zod Schema 验证, 严格的 SDK 边界
- **可扩展性**: 清晰的 Provider/Channel/Tool/Hook 注册 API
- **容错设计**: 钩子错误隔离、FailoverError 归一化、Auth profile 冷却指数退避

### 构建 modelRouterPlugin 的可行路径

#### 路径 1: Hook-based 插件 (推荐, 最简)

使用 `definePluginEntry()` + `api.on("before_model_resolve")` 钩子。

**优势**:
- 代码量最少 (预计 100-300 行)
- 不修改核心，纯插件安装
- 可访问 prompt 内容 + channel/agent 上下文

**限制**:
- event 中只有 `prompt` (当前 prompt)，没有 session messages
- 无法修改推理参数 (需要额外使用 `before_prompt_build` 或 `prepareExtraParams`)

```typescript
import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";

export default definePluginEntry({
  id: "model-router",
  name: "Model Router",
  description: "Routes requests to different models based on context",
  register(api) {
    api.on("before_model_resolve", (event, ctx) => {
      // ctx.channelId: "telegram" | "discord" | ...
      // ctx.agentId: 当前 agent ID
      // ctx.trigger: "user" | "heartbeat" | "cron" | "memory"
      // event.prompt: 当前用户 prompt

      const rules = loadRoutingRules();  // 从配置/文件加载
      const match = rules.find(r => r.matches(event, ctx));
      if (match) {
        return {
          providerOverride: match.provider,
          modelOverride: match.model,
        };
      }
      // 返回 undefined = 使用默认模型
    }, { priority: 100 });
  },
});
```

#### 路径 2: 完整 ProviderPlugin (虚拟聚合 Provider)

实现 `ProviderPlugin` 接口，注册为虚拟 Provider，内部聚合多个底层 Provider。

**优势**:
- 完全控制模型解析、认证、流包装
- 可实现复杂的负载均衡、成本优化
- 类似自托管 OpenRouter

**限制**:
- 代码复杂度高 (预计 500-1000+ 行)
- 需要管理多个底层 Provider 的凭据
- 需要实现 `resolveDynamicModel` + `prepareDynamicModel` + `wrapStreamFn`

#### 路径 3: Config-only (零代码)

使用现有配置能力，无需编写插件:

```yaml
# Agent 级回退链
agents:
  list:
    - model:
        primary: "anthropic/claude-opus-4-5"
        fallbacks:
          - "ollama/llama3.3:70b"
          - "openrouter/auto"

# Channel 级路由
channels:
  modelByChannel:
    telegram:
      "*": "ollama/llama3.3:8b"
    discord:
      "server-123": "anthropic/claude-haiku-4-5"
      "*": "openai/gpt-4o"

# Provider 配置
models:
  providers:
    ollama:
      baseUrl: "http://localhost:11434"
      models:
        - id: "llama3.3:8b"
          name: "Llama 3.3 8B"
          api: "ollama"
```

**优势**: 零代码，运维友好
**限制**: 只能按 channel 或 agent 静态路由，无法基于 prompt 内容动态决策

#### 路径 4: 混合方案 (推荐用于生产)

Plugin 实现动态路由逻辑 + Config 管理 Provider 凭据和回退链。

这是最实用的方案: 路由决策由插件代码实现 (灵活)，而凭据管理、回退链、Channel 覆盖使用原生配置 (运维友好)。

### 关键设计考量

1. **路由规则存储**: 插件 configSchema + JSON5 配置文件 vs 独立 YAML 规则文件
2. **路由维度**: prompt 关键词匹配 / channel / agent / trigger / 自定义标签
3. **可观测性**: 利用 `llm_input`/`llm_output` void hooks 记录路由决策日志
4. **回退策略**: 路由失败时是否退回默认模型 (通过 model.fallbacks 配置)
5. **热更新**: 路由规则变更是否需要重启 (可通过 watch config file 实现)
