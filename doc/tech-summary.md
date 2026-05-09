# OpenCode Copilot — VSCode 扩展技术总结

## 概述

`opencode-copilot` 是一个 VSCode 扩展，将 OpenCode AI 编码助手集成到 Copilot Chat 中。通过在聊天输入框中使用 `@opencode`，用户可以无缝地与 OpenCode 服务器交互，获得完整的 AI 思考过程、工具调用和流式响应。

---

## 架构

```
┌─────────────────────────────────────────────────────┐
│ VSCode Copilot Chat UI                              │
│  @opencode hello → ChatResponseStream               │
└─────────────────────┬───────────────────────────────┘
                      │ ChatRequestHandler
┌─────────────────────▼───────────────────────────────┐
│ src/participant/handler.ts                          │
│  • 斜杠命令路由                                       │
│  • 懒加载服务器启动                                    │
│  • 会话管理                                          │
│  • 事件桥接                                          │
└─────────────────────┬───────────────────────────────┘
                      │ StreamBridge
┌─────────────────────▼───────────────────────────────┐
│ src/participant/streaming.ts                        │
│  • reasoning → thinkingProgress() 实时思考流          │
│  • tool → beginToolInvocation() + ChatToolInvocationPart │
│  • text → markdown() token-by-token 流式输出          │
└─────────────────────┬───────────────────────────────┘
                      │ SSE events
┌─────────────────────▼───────────────────────────────┐
│ src/opencode/server.ts                              │
│  createOpencode({ port: 0 }) → server + client       │
│  @opencode-ai/sdk v1.14.41                          │
└─────────────────────┬───────────────────────────────┘
                      │ HTTP + SSE
┌─────────────────────▼───────────────────────────────┐
│ OpenCode CLI (localhost, ephemeral port)             │
└─────────────────────────────────────────────────────┘
```

### 文件结构

```
src/
├── extension.ts          # activate/deactivate, 注册 ChatParticipant
├── opencode/
│   └── server.ts         # OpenCodeServerManager (SDK 封装)
├── participant/
│   ├── handler.ts        # ChatRequestHandler 主流程
│   ├── streaming.ts      # StreamBridge (SSE→Chat UI)
│   ├── commands.ts       # /new, /help, /model 路由
│   └── errors.ts         # 错误常量 + 空提示检测
├── types/
│   ├── index.ts          # ExtensionState, SessionInfo
│   └── events.ts         # SSE 事件类型 + 常量
└── test/
    ├── vscode-mock.ts    # Vitest 的 VSCode API 模拟
    ├── streaming.test.ts # 16 个流式渲染测试
    ├── handler.test.ts   # 12 个处理器测试
    ├── commands.test.ts  # 11 个命令测试
    ├── server.test.ts    # 12 个服务器测试
    ├── client.test.ts    # 15 个客户端测试
    └── extension.test.ts # 1 个激活测试
```

---

## 核心技术点

### 1. VSCode Chat Participant API (稳定)

```typescript
// package.json
"contributes": {
  "chatParticipants": [{
    "id": "opencode-copilot.opencode",
    "name": "opencode",
    "isSticky": true,
    "commands": [{"name": "new"}, {"name": "help"}, {"name": "model"}]
  }]
}

// extension.ts
const participant = vscode.chat.createChatParticipant(
  'opencode-copilot.opencode',
  createParticipantHandler(state),
);
```

**稳定 API 方法：**
| 方法 | 参数 | 用途 |
|------|------|------|
| `stream.markdown(value)` | `string` | 输出 Markdown 文本（支持代码块、表格等） |
| `stream.progress(value)` | `string` | 显示进度条消息 |
| `stream.push(part)` | `ChatResponsePart` | 推送自定义渲染部件 |

### 2. Proposed API: chatParticipantAdditions

需在 `package.json` 中声明：
```json
"enabledApiProposals": ["chatParticipantAdditions"]
```

这些类型**不在** `@types/vscode` 中，需要本地声明。

**Proposed API 方法：**

| 方法 | 签名 | 用途 |
|------|------|------|
| `stream.thinkingProgress(delta)` | `(delta: ThinkingDelta)` | 实时流式显示思考 token |
| `stream.beginToolInvocation(id, name, data?)` | `(callId, toolName, streamData?)` | 开始流式工具调用 UI（spinner） |
| `stream.updateToolInvocation(id, data)` | `(callId, streamData)` | 更新工具调用参数 |
| `stream.push(ChatToolInvocationPart)` | `ChatToolInvocationPart` | 推送完成的工具调用卡片 |

**ThinkingDelta 类型：**
```typescript
{ text?: string | string[]; id?: string; metadata?: { readonly [key]: string]: unknown } }
```

### 3. ChatToolInvocationPart — 工具调用渲染

```typescript
class ChatToolInvocationPart {
  toolName: string;           // 工具名 (read, bash, write...)
  toolCallId: string;         // 唯一调用 ID
  isComplete?: boolean;       // 是否完成
  invocationMessage?: string; // 运行中消息
  pastTenseMessage?: string;  // 完成后消息 (Read file.ts 0.5s)
  enablePartialUpdate?: bool; // 支持流式更新
  toolSpecificData?:          // 工具特定数据（决定 UI 渲染方式）
    | TerminalToolData        // → 终端命令行样式
    | SimpleToolResultData    // → 可折叠 Input/Output
    | ToolResourcesData       // → 文件引用列表
    | SubagentToolData;       // → 子代理展开
}
```

### 4. 工具特定数据类型

| 类型 | 场景 | 字段 | UI 效果 |
|------|------|------|---------|
| `TerminalToolData` | bash/shell | `commandLine`, `language`, `output`, `state` | 终端样式 + 退出码 + 耗时 |
| `SimpleToolResultData` | read/list/grep | `input`, `output` | 可折叠的输入/输出块 |
| `ToolResourcesData` | write/edit | `values: [{path, line?}]` | 文件引用列表（可点击跳转） |
| `SubagentToolData` | task/subagent | `agentName`, `prompt`, `result` | 点击展开子代理完整对话 |

### 5. OpenCode SDK 集成

```typescript
import { createOpencode } from '@opencode-ai/sdk';

// 核心函数
const oc = await createOpencode({ port: 0 });
// → { server: { url, close }, client }

// 会话创建
const result = await oc.client.session.create({ body: {} });
const sessionId = result.data.id;  // ← 注意: data.id

// 事件订阅（必须在 prompt 之前）
const events = await oc.client.event.subscribe();

// 发送 prompt（fire-and-forget, 不 await）
const promise = oc.client.session.prompt({
  path: { id: sessionId },
  body: { parts: [{ type: 'text', text: userPrompt }] },
});

// 消费事件流（并行的）
for await (const evt of events.stream) { ... }
await promise;  // 最后才 await
```

**关键陷阱：**
- ❌ 不要设置 `OPENCODE_SERVER_PASSWORD` — 会导致 401
- ❌ 不要 `await prompt()` — 会阻塞事件消费，导致所有事件丢失
- ✅ 先 `subscribe()` 再 `prompt()`
- ✅ `session.create()` 返回 `{ data: { id } }`，不是直接的 `{ id }`

---

## 事件流详解

### SSE 事件类型

每个对话回合的事件顺序：

```
1. message.part.updated  type=text        → 用户回显（跳过）
2. message.part.updated  type=step-start  → 步骤开始
3. message.part.updated  type=reasoning   → 思考部分创建
4. message.part.delta    field=text       → 思考 token 流 → thinkingProgress()
5. message.part.updated  type=tool        → 工具调用 (pending→running→completed)
6. message.part.updated  type=text        → AI 文本部分创建
7. message.part.delta    field=text       → AI token 流 → markdown()
8. message.part.updated  type=step-finish → 步骤结束
9. session.idle                           → 回合完成 → break
```

### 工具调用状态机

```
pending ──→ beginToolInvocation(callId, toolName)
  │
  ├─ running ──→ updateToolInvocation(callId, { partialInput })
  │
  └─ completed ──→ stream.push(new ChatToolInvocationPart(...))
                   └── toolSpecificData = buildToolSpecificData(toolName, ...)
```

### 工具名 → 数据类型映射

```typescript
function buildToolSpecificData(toolName, input, output, ...) {
  switch (toolName) {
    case 'bash':
    case 'shell':  return TerminalToolData { commandLine, language, output, state };
    case 'read':
    case 'list':
    case 'grep':   return SimpleToolResultData { input, output };
    case 'write':
    case 'edit':   return ToolResourcesData { values: [{ path }] };
    case 'task':
    case 'subagent': return SubagentToolData { agentName, prompt, result };
    default:       return SimpleToolResultData { input, output };  // 降级
  }
}
```

---

## 配置与构建

### package.json 关键字段

```json
{
  "engines": { "vscode": "^1.95.0" },
  "enabledApiProposals": ["chatParticipantAdditions"],
  "main": "./out/extension.js",
  "activationEvents": ["onStartupFinished"],
  "dependencies": { "@opencode-ai/sdk": "^1.14.41" }
}
```

### 构建 (esbuild)

```bash
# CJS 格式, vscode 作为外部依赖, ESM SDK 自动处理
esbuild src/extension.ts --bundle --outfile=out/extension.js \
  --external:vscode --format=cjs --platform=node
```

### 测试 (vitest)

```typescript
// vitest.config.ts
resolve: {
  alias: {
    vscode: path.resolve(__dirname, 'src/test/vscode-mock.ts'),
  },
}
```

- 67 个单元测试，全部通过
- 通过 `paths` 别名将 `vscode` 映射到 mock 模块
- SDK 调用全部被 mock（不依赖真实 OpenCode 服务）
- 通过真机终端 E2E 测试验证了完整的 SSE 事件流

### 类型检查

`tsconfig.json` 中 `vscode` 通过 `paths` 映射到 mock 类型声明，避免了 `@types/vscode` 中缺少 proposed API 类型的问题。

---

## 关键设计决策

| 决策 | 原因 |
|------|------|
| `createOpencode({ port: 0 })` 而非子进程 | SDK 管理完整的服务器生命周期 |
| 不设置 `OPENCODE_SERVER_PASSWORD` | 导致 401；SDK 无需密码即可运行 |
| prompt fire-and-forget + 并行事件消费 | `await prompt()` 会阻塞事件流，导致所有事件丢失 |
| `thinkingProgress()` 实时流式传输推理内容 | 推理内容不缓冲；每个增量立即显示 |
| 工具调用采用流式生命周期 (begin→update→push) | 原生 spinner → 实时参数更新 → 完成卡片 |
| `toolSpecificData` 按工具名自动选择 | 根据工具类型触发不同的 VSCode UI 渲染 |
| esbuild 打包，`--external:vscode` | VSCode 扩展的标准构建方式 |
| vitest + mock vscode 模块 | 无需 VSCode 扩展主机即可运行测试 |

---

## 依赖版本

| 包 | 版本 | 用途 |
|---|------|------|
| `@opencode-ai/sdk` | ^1.14.41 | OpenCode 服务器和客户端管理 |
| `@types/vscode` | ^1.118.0 | VSCode API 类型（稳定部分） |
| `@types/node` | ^20.19.40 | Node.js 类型 |
| `esbuild` | ^0.24.2 | ESM→CJS 打包 |
| `typescript` | ^5.9.3 | 类型检查 |
| `vitest` | ^4.1.5 | 单元测试 |
| VSCode | ≥1.119.0 | 运行环境（支持 chatParticipantAdditions） |
| OpenCode CLI | 1.14.41 | 本地 AI 服务器 |
