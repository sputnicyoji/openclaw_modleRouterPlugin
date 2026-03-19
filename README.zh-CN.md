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

## 安装

**步骤 1:** 复制插件目录

```bash
cp -r model-router/ ~/.openclaw/extensions/model-router/
```

**步骤 2:** 配置 (config.yaml)

```yaml
plugins:
  allow:
    - model-router
  entries:
    model-router:
      hooks:
        allowPromptInjection: true
```

`allowPromptInjection: true` 是必需的，因为插件通过 `before_prompt_build` 钩子向 system prompt 追加路由指令。

**步骤 3:** 重启网关

## 使用方法

```
/route add <规则>        添加路由规则（自然语言）
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

## 架构

| 组件 | 机制 | 用途 |
|------|------|------|
| `/route` 命令 | `api.registerCommand()` | 规则增删改查，绕过 LLM |
| Prompt 注入 | `before_prompt_build` 钩子 | 将规则追加到 system prompt |
| 任务委派 | `sessions_spawn(model=...)` | 主 agent 拉起子 agent 使用目标模型 |

插件约 140 行 TypeScript，零外部依赖。

## 环境要求

- OpenClaw v2026.3.0+
- 目标模型的 Provider 必须已配置有效凭据

## 设计理念

- **不切换主 agent 模型** -- 避免将完整会话上下文重新注入新模型导致的 token 浪费
- **LLM 解释规则** -- 自然语言规则注入 system prompt，由主 agent 自行判断何时委派（比关键词匹配更灵活）
- **Slash 命令绕过安全检查** -- `api.registerCommand()` 在 LLM 管道之外运行，规则管理不会触发 OpenClaw 的 prompt 注入审查

## 项目结构

```
model-router/
  package.json
  openclaw.plugin.json
  index.ts                 - 插件入口：注册 /route 命令 + prompt 钩子
  src/
    rules-store.ts         - 规则增删改查 + JSON 文件持久化
    prompt-inject.ts       - 构建注入 system prompt 的路由指令文本
```

## 文档

- [设计规格](docs/superpowers/specs/2026-03-20-model-router-plugin-design.md)
- [实现计划](docs/superpowers/plans/2026-03-20-model-router-plugin.md)
- [OpenClaw 架构分析](docs/openclaw-analysis-report.md)

## 许可证

MIT
