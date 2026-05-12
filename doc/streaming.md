# Streaming 渲染技术文档

## 架构选型：SSE 事件流 vs 轮询

### 结论

**必须使用 SSE 事件流（Server-Sent Events），禁止使用轮询方案。**

### 原因

OpenCode 服务端通过 `/event` SSE 端点推送两种粒度的实时事件：

| 事件类型 | 粒度 | 用途 |
|---|---|---|
| `message.part.updated` | 整个 Part 的状态变更 | 工具状态机 `pending→running→completed` |
| `message.part.delta` | 单次增量文本（几个 token） | 逐字流式输出思考/回复 |
| `session.idle` | 信号 | 标记回合结束 |

轮询（`promptAsync` + `messages()` 轮询）只能拿到 **已完成** 的 Part 快照，丧失了：

1. **逐字流式**：SSE 的 `delta` 是几个 token 的增量，轮询拿到的是整个 `part.text`
2. **工具状态机**：SSE 有 `pending→running→completed` 三阶段渐进渲染，轮询只能拿到 `completed`
3. **实时性**：SSE 服务端推送延迟毫秒级，轮询至少 400ms

---

## SSE 事件处理流程

### 事件时序

一个完整的对话回合，SSE 事件按以下顺序到达：

```
message.part.updated  type=text         ← 用户回显（记录 messageID 后跳过）
message.part.updated  type=reasoning    ← 思考部分创建（空文本）
message.part.delta    field=text        ← 思考 token 增量 → thinkingProgress()
message.part.updated  type=tool         ← 工具调用（state.status=pending）
message.part.updated  type=tool         ← 工具调用（state.status=running，含 input）
message.part.updated  type=tool         ← 工具调用（state.status=completed，含 output）
... (可能多个工具循环)
message.part.updated  type=text         ← AI 文本部分创建（空文本）
message.part.delta    field=text        ← AI token 增量 → markdown()
session.idle                             ← 回合结束信号
```

### 消费模式：Fire-and-Forget

```typescript
// 1. 先订阅 SSE（必须在 prompt 之前）
const events = await client.event.subscribe();

// 2. Fire-and-forget：不 await prompt，让事件并发流过
const promptPromise = client.session
  .prompt({ path: { id: sessionId }, body: { parts: [...] } })
  .catch(err => { /* log error */ });

// 3. 消费事件流（并发的）
await bridge.bridgeEventsToStream(events, stream, token);

// 4. 最后才 await prompt
await promptPromise;
```

**为什么不能 await prompt()：** `prompt()` 内部是 HTTP POST，服务端在处理期间保持连接。如果 await，所有 SSE 事件在 await 期间触发，但此时没有任何消费者在读取事件流 → 事件丢失。

---

## SDK 调用格式

### 正确格式（path/body/query）

```typescript
// session.create
client.session.create({
  body: {},
  query: directory ? { directory } : undefined,
});

// session.prompt
client.session.prompt({
  path: { id: sessionId },
  body: { parts: [{ type: 'text', text: prompt }] },
  query: directory ? { directory } : undefined,
});

// session.revert
client.session.revert({
  path: { id: sessionId },
  body: { messageID: messageId },
  query: directory ? { directory } : undefined,
});
```

### 错误格式（flat 格式，会导致 SSE 事件不触发）

```typescript
// ❌ 不要使用这种 flat 格式
client.session.prompt({
  sessionID: sessionId,
  parts: [{ type: 'text', text: prompt }],
  directory,
});
```

`flat` 格式会让 SDK 生成错误的 HTTP 请求 → 服务端无法正确关联 session → SSE `/event` 端点只收到 `server.connected` 生命周期事件，收不到 `message.part.*` 处理事件。

---

## 工具调用渲染

### 状态机：pending → running → completed

```
┌──────────────────────────────────────────────────────────┐
│ pending                                                   │
│   → beginToolInvocation(callID, toolName)  [spinner]      │
│   → toolMetas.set(callID, { name, ... })                  │
├──────────────────────────────────────────────────────────┤
│ running                                                   │
│   → updateToolInvocation(callID, { partialInput })        │
│   → meta.input = state.input; meta.title = state.title    │
├──────────────────────────────────────────────────────────┤
│ completed                                                 │
│   → new ChatToolInvocationPart(toolName, callID)          │
│   → part.toolSpecificData = buildToolSpecificData(...)    │
│   → stream.push(part)                        [完成卡片]    │
│   → toolMetas.delete(callID)                              │
└──────────────────────────────────────────────────────────┘
```

### 工具名 → toolSpecificData 映射

| 工具名 | 数据类型 | UI 效果 |
|---|---|---|
| `bash`, `shell` | `TerminalToolData` | 终端样式：命令行 + 输出 + 耗时 |
| `read`, `list`, `grep` | `SimpleToolResultData` | 可折叠的 Input/Output 块 |
| `write`, `edit` | `ToolResourcesData` | 文件引用列表（可点击跳转） |
| `task`, `subagent` | `SubagentToolData` | 子代理展开面板 |
| 其他 | `SimpleToolResultData` | 通用可折叠降级 |

### 非工具事件的处理

- `message.part.updated` + `type=text`：通过 `messageID` 区分用户回显（跳过）和 AI 回复（记录 partKind）
- `message.part.updated` + `type=reasoning`：仅记录 partKind，等待后续 delta
- `message.part.delta`：根据 partKind 决定走 `thinkingProgress()` 还是 `markdown()`

---

## StreamBridge 类设计

### 核心状态

```typescript
class StreamBridge {
  private userMessageId: string | null;    // 用户消息 ID（用于 turn 追踪）
  private partKinds: Map<string, PartKind>; // partID → 'reasoning' | 'text' | 'tool'
  private toolCallIds: Map<string, string>; // partID → callID
  private toolMetas: Map<string, ToolMeta>; // callID → 累积的工具元数据
}
```

### userMessageId 的生命周期

```
handlePartUpdated() 中捕获首个非空 text part 的 messageID
    ↓
reset() 中不清除（保留给外部读取）
    ↓
handler.ts 通过 getUserMessageId() 读取
    ↓
写入 turnMap 用于 revert 追踪
```

`reset()` 必须跳过 `userMessageId` — 否则 finally 块执行后，handler 读取时为 null。

### 可选 API 降级

```typescript
hasThinking = typeof stream.thinkingProgress === 'function';
hasToolUI    = typeof stream.beginToolInvocation === 'function';
```

- `hasThinking = false` → reasoning delta 被忽略（用户看不到思考过程）
- `hasToolUI = false` → 工具渲染降级为 markdown 格式（`🔧 **toolName**` + 代码块输出）

---

## 历史教训：为什么轮询方案不可行

### 失败演化路径

```
V2 (22d7abd)     用了 flat SDK 格式 → SSE 事件不触发
     ↓
V2.5 (7f7d567)   误判为 "SSE 不支持" → 抛弃 SSE，改用同步 prompt()
     ↓
V3 (92e566e)     同步太慢 → 改用 promptAsync() + 400ms 轮询
```

### V2 的根因

V2 将 SDK 调用从 `path/body` 格式改为 `flat` 格式：

```typescript
// V2 错误的 flat 格式
client.session.prompt({ sessionID, parts, directory })
```

导致 SSE 事件不触发。V2.5 的注释记录了这个误判：

> *"Server-Sent Events (SSE) via /event only deliver server-level events (server.connected) — session processing events DO NOT flow through SSE."*

### V3 轮询方案的具体缺陷

| 维度 | SSE | 400ms 轮询 |
|---|---|---|
| 文本渲染 | 逐 token（delta） | 整块 part.text 一次性出现 |
| 工具渲染 | 三阶段状态机（spinner→输入→完成） | 仅 completed/error |
| 延迟 | 毫秒级（服务端推送） | 400ms+（poll interval） |
| 取消响应 | 立即 break | 需等下一次 poll |
| 服务端负载 | 1 个长连接 | 频繁 HTTP GET |

### 教训

1. **SDK 格式必须使用 `path/body/query`**，不要发明 flat 格式
2. **SSE 事件不触发时，先排查 SDK 调用格式**，不要假设 SSE 不可用
3. **不要为了解决一个问题（revert）而引入更大的问题（重写渲染层）**
4. **解耦是关键**：revert 逻辑（sessionMap + turnMap + resolveSession）与渲染逻辑（SSE + StreamBridge）完全独立，可以独立移植
