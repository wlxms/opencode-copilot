# OpenCode Copilot

在 VSCode Copilot Chat 中直接使用 OpenCode AI 编码助手。

`@opencode hello` → 实时推理过程 → 工具调用 → AI 流式输出

## 功能

- **聊天集成**: 在 Copilot Chat 输入 `@opencode` 即可对话
- **实时推理显示**: AI 思考过程实时流式展示（thinkingProgress API）
- **原生工具调用卡片**: 文件读取、Shell 命令等以原生 UI 渲染，可点击展开
- **子代理支持**: 子代理/子任务自动以可展开卡片展示
- **流式输出**: AI 回复 token-by-token 实时显示
- **斜杠命令**: `/new` 新会话, `/help` 帮助, `/model` 模型列表

## 工具调用 UI 展示

```typescript
read / list / grep   → 可折叠的 Input/Output 区块
bash / shell         → 终端样式 + 执行耗时
write / edit         → 文件引用列表（可点击跳转）
task / subagent      → 点击展开子代理完整对话
```

## 安装

1. 确保已安装 [OpenCode CLI](https://opencode-ai.com) 并完成认证
2. 克隆仓库
   ```bash
   git clone https://github.com/wlxms/opencode-copilot.git
   cd opencode-copilot
   npm install
   ```
3. 构建
   ```bash
   npm run compile
   ```
4. 在 VSCode 中按 `F5` 启动扩展开发主机

## 使用

在 Copilot Chat 中输入：

| 输入 | 效果 |
|------|------|
| `@opencode read package.json` | 调用 read 工具读取文件，展示 AI 回复 |
| `@opencode /model` | 显示可用 AI 模型列表 |
| `@opencode /new` | 开始新对话会话 |
| `@opencode /help` | 显示帮助 |

## 开发

```bash
# 类型检查
npm run lint

# 测试（67 个单元测试）
npm test
```

### 技术栈

| 层 | 技术 |
|---|------|
| 聊天 UI | VSCode Chat Participant API (稳定 + `chatParticipantAdditions` proposal) |
| 流式桥接 | SSE 事件 → `thinkingProgress()` / `markdown()` |
| 工具渲染 | `ChatToolInvocationPart` + 6 种 `toolSpecificData` |
| SDK | `@opencode-ai/sdk` v1.14.41 |
| 构建 | esbuild (ESM→CJS) |
| 测试 | vitest + 自定义 vscode mock |

### 项目结构

```
src/
├── extension.ts          # 入口: activate/deactivate
├── opencode/
│   └── server.ts         # SDK 封装 (createOpencode)
├── participant/
│   ├── handler.ts        # ChatRequestHandler 主流程
│   ├── streaming.ts      # StreamBridge: SSE → Chat UI
│   ├── commands.ts       # 斜杠命令路由
│   └── errors.ts         # 错误处理
├── types/
│   ├── index.ts          # ExtensionState
│   └── events.ts         # SSE 事件类型
└── test/
    ├── vscode-mock.ts    # VSCode API mock
    └── *.test.ts         # 各模块测试
```

详细技术文档见 [doc/tech-summary.md](doc/tech-summary.md)。

## 许可证

MIT
