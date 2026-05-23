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
- **ACP-first 架构**: 以 ACP 语义层解耦 backend 与 VS Code surface，OpenCode 只是一个 backend 实现
- **实验性 Session Provider 开关**: 可在入口层按运行时能力切换是否启用实验性 surface

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

### ACP-first 架构

当前代码库已引入 ACP-compatible 分层：

```txt
src/
├── acp/                  # 协议语义层（不依赖 vscode / SDK）
├── backends/opencode/    # OpenCode → ACP backend 适配
├── surfaces/vscode/      # VS Code stable / experimental surface
├── participant/          # 兼容层，逐步迁移中的 participant 入口
└── extension.ts          # 入口分流：backend + surface 装配
```

- `src/acp/*`：定义统一语义事件、会话、权限、模型接口
- `src/backends/opencode/*`：把 OpenCode SDK 与事件流归一化到 ACP
- `src/surfaces/vscode/*`：把 ACP 事件渲染到 VS Code Chat UI

这意味着未来可以保留同一套 VS Code surface，同时接入别的 ACP backend，而不把 OpenCode 细节泄漏到 UI 层。

### 实验性 Session Provider

默认仍然使用稳定的 chat participant 路径。

如果想实验性启用 session provider surface，可在 VS Code 设置中打开：

```json
{
  "opencode.experimental.sessionProvider": true
}
```

说明：

- 该开关**只在运行时存在对应 proposed API 时生效**
- 如果运行环境不支持，扩展会自动回退到稳定 participant 路径
- 当前实验 surface 主要用于架构隔离和未来扩展点预留

### 项目结构

```
src/
├── acp/                  # ACP 语义层
├── backends/opencode/    # OpenCode ACP backend
├── surfaces/vscode/      # VS Code surfaces
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
