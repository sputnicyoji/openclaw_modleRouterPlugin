# OpenClaw Model Router Plugin

[English](README.md)

一个轻量级 OpenClaw 插件，让用户通过自然语言定义模型路由规则。当任务匹配规则时，主 agent 自动委派给使用指定模型的子 agent 完成 -- 不切换主模型，不浪费 token。

## 工作原理

```
用户: /route add 简单问答用 ollama/llama3.3:8b
用户: /route add 代码任务用 anthropic/claude-opus-4-5

用户: 帮我翻译这篇文章
  -> 主 agent 在 system prompt 中看到路由规则
  -> 匹配"翻译" -> 拉起子 agent 使用指定模型
  -> 子 agent 完成任务，结果返回给用户
```

主 agent 的模型始终不变。需要其他模型的任务通过 OpenClaw 原生的 `sessions_spawn(model=...)` 工具委派。

## 支持平台

支持 OpenClaw 全平台: **macOS**、**Linux**、**Windows**。

## 安装部署

### 前置条件

- OpenClaw v2026.3.0+ 已安装并运行 (通过 `npm install -g openclaw` 或平台安装器)
- 至少配置了一个模型 Provider (Anthropic、OpenAI、Ollama 等)

### 步骤 1: 安装插件

```bash
openclaw plugins install /path/to/model-router
```

或从本仓库安装:

```bash
git clone https://github.com/sputnicyoji/openclaw_modleRouterPlugin.git
openclaw plugins install openclaw_modleRouterPlugin/model-router
```

### 步骤 2: 启用 prompt 注入权限

```bash
openclaw config set plugins.entries.model-router.hooks.allowPromptInjection true
```

`allowPromptInjection: true` 是**必需的** -- 没有它，OpenClaw 的安全层会静默丢弃 `before_prompt_build` 钩子，路由规则将永远不会被注入。

### 步骤 3: 重启网关

```bash
openclaw gateway stop
openclaw gateway start
```

### 步骤 4: 验证

在任意已连接的通道 (Telegram、Discord、Web UI 等) 中:

```
/route add test rule
```

如果看到 `Added rule #1: test rule`，插件已生效。用 `/route remove 1` 清理。

## 使用方法

```
/route add <规则>        添加路由规则 (自然语言)
/route list              列出所有规则
/route remove <编号>     按编号删除规则
/route clear             清空所有规则
```

### 示例

```
/route add 简单问答用 ollama/llama3.3:8b
/route add 代码审查用 anthropic/claude-opus-4-5
/route add 翻译任务用 google/gemini-2.5-flash
/route add 复杂推理用 anthropic/claude-opus-4-6
```

规则存储在 `~/.openclaw/plugins/model-router/rules.json`，网关重启后不会丢失。

### 路由流程

1. 用户通过 `/route add` 定义规则 (绕过 LLM，不消耗 token)
2. 每条消息到来时，规则作为强制指令注入主 agent 的 system prompt
3. 主 agent 检查当前任务是否匹配任何规则
4. 如果规则匹配，agent **必须**通过 `sessions_spawn(model="...", task="...")` 生成子代理处理，禁止自己回答
5. 子代理使用指定模型运行，返回结果
6. 如果没有规则匹配，主 agent 直接处理

主 agent 的模型**始终不切换** -- 委派通过子代理完成，避免上下文重新注入的 token 浪费。

## 架构

| 组件 | 机制 | 用途 |
|------|------|------|
| `/route` 命令 | `api.registerCommand()` | 规则增删改查，绕过 LLM |
| Prompt 注入 | `before_prompt_build` 钩子 | 通过 `appendSystemContext` 将规则追加到 system prompt |
| 任务委派 | `sessions_spawn(model=...)` | 主 agent 拉起子 agent 使用目标模型 |
| 内存缓存 | `register()` 闭包 | 热路径钩子读缓存，每条消息零磁盘 I/O |

约 140 行 TypeScript，零外部依赖。

## 测试

**单元测试** (独立运行，不依赖 OpenClaw):

```bash
cd model-router && npx vitest run
# 12 个测试: 规则存储 CRUD (8) + prompt 注入文本 (4)
```

**集成测试** (需要 OpenClaw 源码并 `pnpm install`):

```bash
# 复制测试文件到 OpenClaw 源码树中
cp tests/integration.test.ts openclaw/src/plugins/model-router-integration.test.ts
cp tests/loader.test.ts openclaw/src/plugins/model-router-loader.test.ts
cp tests/cache.test.ts openclaw/src/plugins/model-router-cache.test.ts

# 运行
cd openclaw && npx vitest run src/plugins/model-router-integration.test.ts src/plugins/model-router-loader.test.ts src/plugins/model-router-cache.test.ts

# 清理
rm openclaw/src/plugins/model-router-*.test.ts
```

集成测试验证: 真实插件加载器 (jiti)、钩子运行器、命令注册、缓存刷新、多插件共存、错误隔离。

详见 [tests/README.md](tests/README.md)。

## 故障排查

| 现象 | 原因 | 解决方法 |
|------|------|----------|
| `/route` 命令无响应 | 插件未加载 | 检查 `plugins.allow` 包含 `"model-router"`，重启网关 |
| 添加了规则但 agent 不委派 | `allowPromptInjection` 未设置 | 在插件配置中添加 `hooks.allowPromptInjection: true` |
| `sessions_spawn` 报模型错误 | 目标 Provider 未配置 | 确认该 Provider 在 OpenClaw 配置中有有效 API Key |
| Agent 委派了但子 agent 失败 | 模型 ID 格式错误 | 使用 `provider/model-id` 格式 (如 `ollama/llama3.3:8b`) |

## 设计理念

- **不切换主 agent 模型** -- 避免将完整会话上下文重新注入新模型导致的 token 浪费
- **LLM 解释规则** -- 自然语言规则注入 system prompt，由主 agent 自行判断何时委派 (比关键词匹配更灵活)
- **Slash 命令绕过安全检查** -- `api.registerCommand()` 在 LLM 管道之外运行，规则管理不会触发 OpenClaw 的 prompt 注入审查
- **内存缓存** -- 规则启动时从磁盘加载一次，仅在写命令时刷新；每条消息的钩子从内存读取

## 项目结构

```
model-router/                  # 插件本体 (部署时只需复制这个目录)
  package.json
  openclaw.plugin.json
  index.ts                     - 插件入口: /route 命令 + prompt 钩子 + 缓存
  src/
    rules-store.ts             - 规则增删改查 + JSON 文件持久化
    prompt-inject.ts           - 构建注入 system prompt 的路由指令文本

tests/                         # 集成测试 (在 OpenClaw 源码树中运行)
  integration.test.ts          - 钩子运行器 + 命令处理器测试
  loader.test.ts               - 真实插件加载器 (jiti) 验证
  cache.test.ts                - 缓存刷新机制测试

docs/                          # 研究和设计文档
```

## 文档

- [设计规格](docs/superpowers/specs/2026-03-20-model-router-plugin-design.md)
- [实现计划](docs/superpowers/plans/2026-03-20-model-router-plugin.md)
- [OpenClaw 架构分析](docs/openclaw-analysis-report.md)

## 许可证

MIT
