# ACP 共性+特性 架构重构计划

## 目标

将当前半完成的双轨架构（ACP ↔ SDK 反复转换）重构为"共性+特性"分层：
- **框架层**（handler/streaming/commands）只依赖 ACP 接口，零 SDK 依赖
- **后端层**（backends/opencode/）自治管理 SDK 连接、事件归一化、服务器生命周期
- **ACP 接口**精简为框架实际消费的最小事件集

## 约束

- 每个 Phase 完成后项目必须可编译、测试通过
- 不改变外部行为（用户看到的 VSCode Chat 交互不变）
- 不一次性大改，按 Phase 逐步推进，每步可验证

---

## Phase 0: 基线验证

**目标**: 确认当前测试全绿，建立重构基线。

### 步骤
- [ ] 运行 `npm run test`（或 vitest），记录当前测试结果
- [ ] 运行 `npm run build`（或 tsc），确认编译通过
- [ ] 记录当前测试数量和覆盖率基线

### 验证
- 所有现有测试通过
- 编译零错误

---

## Phase 1: 精简 ACP 类型（纯类型变更，不改逻辑）

**目标**: `acp/types.ts` 只保留框架消费的类型，删除未使用的事件和类型。

### 删除的事件类型（框架不消费）
- `AcpSessionLifecycleEvent`（session.created/updated/deleted/error → handler 返回 null）
- `AcpPermissionReplyEvent`（permission.replied → handler 返回 null）
- `AcpServerLifecycleEvent`（server.connected/heartbeat → handler 返回 null）
- `AcpEventType` 中对应枚举值

### 精简后的 AcpEventType
```typescript
export type AcpEventType =
  | 'part.updated'
  | 'part.delta'
  | 'session.idle'
  | 'session.diff'
  | 'permission.asked';
```

### 精简后的 AcpEvent
```typescript
export type AcpEvent =
  | AcpPartUpdatedEvent
  | AcpPartDeltaEvent
  | AcpSessionIdleEvent
  | AcpSessionDiffEvent
  | AcpPermissionRequestEvent;
```

### 保留不变
- `AcpPartType`（5 种 part 类型：text/reasoning/tool/step-start/step-finish）
- `AcpStreamPart` 及各子类型
- `AcpToolState`、`AcpFileDiff`
- `AcpResult`、`AcpServerStatus`、`AcpServerInfo`、`AcpSessionInfo`

### 涉及文件
- `src/acp/types.ts` — 删除未使用类型
- `src/backends/opencode/events.ts` — normalizeEvent 中对被删事件类型的处理改为返回 `[]`（如果原本就不是 `[]` 则需调整）
- `src/backends/opencode/adapter.ts` — 如有对被删类型的引用，改用内部类型

### 注意
- `backends/opencode/events.ts` 的 `normalizeEvent` 函数本身可以保留对 `session.created` 等的 normalize 逻辑，但这些 ACP 类型不再暴露给框架。后端内部可以定义自己的 `OpenCodeAcpEvent extends AcpEvent` 来携带额外事件。
- 或者更简单：`normalizeEvent` 里这些 case 直接返回 `[]`，后端层面如果需要这些事件可以不走 ACP 通道。

### 验证
- `npm run build` 通过
- `npm run test` 通过
- 流程层（handler/streaming）代码中不再 import 被删除的类型

---

## Phase 2: StreamBridge 改为消费 AcpEvent（核心变更）

**目标**: `StreamBridge` 的输入从 `OpenCodeEventStream` 改为 `AsyncIterable<AcpEvent>`，消除 handler 中的 denormalize 往返。

### 步骤

#### 2a. 修改 StreamBridge 签名

```typescript
// 现在
async bridgeEventsToStream(
  events: OpenCodeEventStream,   // 包含 SDK 类型
  stream: vscode.ChatResponseStream,
  token: vscode.CancellationToken,
): Promise<boolean>

// 重构后
async run(
  events: AsyncIterable<AcpEvent>,  // 纯 ACP 事件流
  stream: vscode.ChatResponseStream,
  token: vscode.CancellationToken,
): Promise<boolean>
```

#### 2b. 重写 StreamBridge 内部事件处理

将所有 `evt.type === 'message.part.updated'` 改为 `event.type === 'part.updated'`，将 `evt.properties.part` 改为 `event.part`，以此类推。

具体映射：

| 现在（SDK） | 重构后（ACP） |
|---|---|
| `evt.type === 'message.part.updated'` | `event.type === 'part.updated'` |
| `evt.properties.part` | `event.part` |
| `evt.properties.delta` | `event.delta` |
| `evt.type === 'message.part.delta'` | `event.type === 'part.delta'` |
| `evt.properties.partID` | `event.partId` |
| `evt.type === 'session.idle'` | `event.type === 'session.idle'` |
| `evt.type === 'session.diff'` | `event.type === 'session.diff'` |
| `evt.properties.diff` | `event.diffs` |
| `evt.type === 'permission.asked'` | `event.type === 'permission.asked'` |
| `evt.properties.id` | `event.permissionId` |
| `evt.properties.sessionID` | `event.sessionId` |
| `evt.properties.tool?.callID` | `event.tool?.callId` |
| `evt.properties.tool?.messageID` | `event.tool?.messageId` |
| `part.messageID` | `part.messageId` |
| `part.sessionID` | `part.sessionId` |
| `part.callID` | `part.callId` |
| `part.tool` | `part.toolName` |
| `part.state` | `part.state` (结构已不同，需适配) |

#### 2c. Part 类型处理

现在 `handlePartUpdated` 内部用 `part as TextStreamPart` 等 SDK 类型断言。改为直接使用 ACP 类型：

```typescript
// 现在
case 'text': {
  const textPart = part as TextStreamPart;    // SDK 类型
  const msgId = textPart.messageID;           // SDK 命名
  ...
}

// 重构后
case 'text': {
  const textPart = event.part;                // AcpTextPart，无需断言
  const msgId = textPart.messageId;           // ACP 命名
  ...
}
```

#### 2d. Tool 状态处理

`handleToolState` 现在接收 `StreamToolPart`（SDK 判别联合）。改为接收 `AcpToolPart`（ACP 单一接口）：

```typescript
// 现在：判别联合
switch (state.status) {
  case 'pending': state.input (只有这一个字段)
  case 'running': state.input + state.title + state.metadata + state.time?.start
  case 'completed': state.input + state.output + state.title + state.metadata + state.time
}

// 重构后：统一接口
state.status / state.input / state.title / state.metadata / state.startTime / state.endTime
// 字段都直接访问，无需 switch 分支
```

#### 2e. Permission 处理

`handlePermissionAsked` 现在访问 `evt.properties.sessionID`、`evt.properties.id` 等。改为 `event.sessionId`、`event.permissionId` 等。

#### 2f. Session Diff 处理

`handleSessionDiff` 现在访问 `evt.properties.diff`。改为 `event.diffs`。diff 结构从 `SnapshotFileDiff` 改为 `AcpFileDiff`（字段基本一致）。

#### 2g. 删除 StreamBridge 中的 SDK 依赖

删除 streaming.ts 头部的以下 import：
- `import type { MessagePartUpdatedEvent, OpenCodeEvent, OpenCodeEventStream, ... } from '../types/events'`
- `import type { ChatTerminalToolInvocationData, ChatSimpleToolResultData, ... } from '../types/vscode-proposed-additions'`

保留的 import：
- `import type { AcpEvent, AcpStreamPart, AcpTextPart, ... } from '../acp/types'`
- `import * as vscode from 'vscode'`
- `import { ExternalEditTracker } from './external-edit-tracker'`

### 涉及文件
- `src/participant/streaming.ts` — 重写事件消费逻辑
- `src/participant/handler.ts` — 修改调用方式，删除 `denormalizeAcpEvent` 及 `denormalizePart`/`denormalizeToolState`
- `src/test/streaming.test.ts` — 更新测试，使用 ACP 类型构造测试数据

### 涉及文件详细变更

**handler.ts**:
- 删除 `denormalizeAcpEvent()` 函数（405-473 行）
- 删除 `denormalizePart()` 函数（475-523 行）
- 删除 `denormalizeToolState()` 函数（526-564 行）
- 修改 `executeTurnWithBridge` 中调用 bridge 的方式：

```typescript
// 现在
const bridge = new StreamBridge({ ... });
await bridge.bridgeEventsToStream(
  { stream: (async function* normalizedToLegacy() {
    for await (const event of events.stream) {
      const legacy = denormalizeAcpEvent(event);
      if (legacy) yield legacy;
    }
  })() },
  stream,
  token,
);

// 重构后
const bridge = new StreamBridge({ ... });
await bridge.run(events, stream, token);
```

注意：`events` 现在是 `AsyncIterable<AcpEvent>` 而不是 `AcpEventStream`，需要看 backend.events.openSessionStream 的返回类型是否需要调整。当前返回 `AcpEventStream`（包装了 `stream: AsyncIterable<AcpEvent>`），需要改为直接返回 `AsyncIterable<AcpEvent>` 或者让 bridge.run 接受 `AcpEventStream` 并内部解包。推荐后者，保持 backend 接口稳定。

### 验证
- `npm run build` 通过
- `npm run test` 全部通过
- streaming.test.ts 的测试数据从 SDK 类型改为 ACP 类型
- handler.test.ts 的 denormalize 测试删除（功能已不存在）

---

## Phase 3: AcpBackend 接口精简 + 流返回类型统一

**目标**: 精简 `AcpBackend` 接口，`openSessionStream` 返回类型简化，将非核心操作移到扩展接口。

### 步骤

#### 3a. 修改 events 操作返回类型

```typescript
// 现在
interface AcpEventOperations {
  openSessionStream(sessionId: string): AcpEventStream;  // AcpEventStream = { stream: AsyncIterable<AcpEvent> }
  ...
}

// 重构后（方案 A：保留包装，bridge 内部解包）
interface AcpEventOperations {
  openSessionStream(sessionId: string): AsyncIterable<AcpEvent>;  // 直接返回
  ...
}
```

如果选择方案 A，需要同步修改：
- `backends/opencode/adapter.ts` 的 `openSessionStream` 实现
- `handler.ts` 中调用 `openSessionStream` 的地方
- 删除 `AcpEventStream` 接口定义

#### 3b. 将非框架必需操作移到扩展接口

框架核心操作（handler/streaming 消费的）：
```typescript
interface AcpBackend {
  getStatus(): AcpServerStatus;
  start(cwd?: string): Promise<AcpResult<AcpServerInfo>>;
  sessions: AcpSessionOps;
  events: AcpEventOps;
  permissions: AcpPermissionOps;
}
```

扩展操作（只有 commands.ts 的 `/model` 等用）：
```typescript
interface AcpBackendExtended extends AcpBackend {
  sessions: AcpSessionOps & AcpSessionExtendedOps;  // get, list
  config: AcpConfigOps;                              // models
}
```

#### 3c. commands.ts 的类型适配

`commands.ts` 中 `handleModelCommand` 使用了 `state.client.config.providers()`。需要改为通过 backend 扩展接口：
- `ExtensionState.backend` 类型改为 `AcpBackendExtended`
- 或者 commands.ts 内部自行获取 client（不推荐，违反分层原则）

### 涉及文件
- `src/acp/backend.ts` — 接口拆分
- `src/backends/opencode/adapter.ts` — 实现调整
- `src/types/index.ts` — ExtensionState 类型更新
- `src/participant/commands.ts` — 适配新接口

### 验证
- 编译通过
- 测试通过
- commands 的 /new、/model 功能正常

---

## Phase 4: ExtensionState 精简

**目标**: 删除 ExtensionState 中的冗余字段，backend 成为唯一后端入口。

### 步骤

```typescript
// 现在
interface ExtensionState {
  backend: AcpBackend;
  serverManager: OpenCodeServerController;  // 冗余
  client: OpenCodeClient | null;            // 冗余
  activeSessionId: string | null;           // 冗余（sessionMap 已覆盖）
  serverStatus: 'stopped' | ...;            // 冗余（backend.getStatus() 已有）
  outputChannel: vscode.OutputChannel;
  eventBroker: GlobalEventBroker;           // 冗余
  sessionMap: Map<string, SessionState>;
}

// 重构后
interface ExtensionState {
  backend: AcpBackend;
  outputChannel: vscode.OutputChannel;
  sessionMap: Map<string, SessionState>;
}
```

### 需要处理的引用

1. `state.serverManager` — 只在 extension.ts 的 deactivate 中调用 `stop()`
   - 解决：通过 `state.backend.stop()` 暴露（或 backend 自行管理生命周期）

2. `state.client` — 在 commands.ts 的 `handleModelCommand` 中使用
   - 解决：Phase 3 已通过扩展接口解决

3. `state.activeSessionId` — 在 commands.ts 的 `handleNewCommand` 中设置
   - 解决：handleNewCommand 已改为通过 backend.sessions.create()，activeSessionId 可移除或保留为 convenience

4. `state.serverStatus` — 在 handler.ts 中检查
   - 解决：改为 `state.backend.getStatus()`

5. `state.eventBroker` — 在 handler.ts 中不直接使用（通过 backend 间接使用）
   - 解决：直接删除

### 涉及文件
- `src/types/index.ts` — 精简 ExtensionState
- `src/extension.ts` — 移除冗余实例创建，deactivate 通过 backend
- `src/participant/handler.ts` — `state.serverStatus` → `state.backend.getStatus()`
- `src/participant/commands.ts` — 适配新 state 结构
- `src/acp/backend.ts` — 添加 `stop()` 方法到接口

### 验证
- 编译通过
- 测试通过
- extension activate/deactivate 正常

---

## Phase 5: SDK 类型降级到后端内部

**目标**: `src/types/events.ts` 移入 `src/backends/opencode/` 内部，框架层完全消除 SDK 类型依赖。

### 步骤

#### 5a. 移动文件
- `src/types/events.ts` → `src/backends/opencode/protocol.ts`（或保留 events.ts 名字）
- 更新所有 `backends/opencode/` 内部文件的 import 路径

#### 5b. 清理框架层引用
确认以下文件不再 import `types/events.ts`：
- `src/participant/handler.ts` — 已在 Phase 2 清除
- `src/participant/streaming.ts` — 已在 Phase 2 清除
- `src/participant/commands.ts` — 检查是否有残留
- `src/types/index.ts` — 检查是否有残留（`OpenCodeEventStream` import）

#### 5c. 移动 event-broker
- `src/participant/event-broker.ts` → `src/backends/opencode/event-broker.ts`
- 更新 import 路径
- 从 `src/types/index.ts` 中移除 `GlobalEventBroker` 的 import

### 涉及文件
- 移动 `src/types/events.ts` → `src/backends/opencode/`
- 移动 `src/participant/event-broker.ts` → `src/backends/opencode/`
- 更新 import 路径：`adapter.ts`, `backends/opencode/events.ts`, `types/index.ts`

### 验证
- 编译通过
- 框架层（participant/、acp/、types/）零 SDK import
- `grep -r "types/events" src/participant/ src/acp/` 无结果

---

## Phase 6: surfaces 层对齐

**目标**: `src/surfaces/vscode/` 中的渲染器也统一到 ACP 类型，消除内部 SDK 类型残留。

### 步骤

#### 6a. acp-renderer.ts 清理
- 当前 `acp-renderer.ts` import 了 `OpenCodeEvent`, `TextStreamPart` 等 SDK 类型
- 改为纯 ACP 类型：`AcpEvent`, `AcpStreamPart`, `AcpTextPart` 等
- `renderEvent()` 等方法的输入改为 ACP 事件

#### 6b. experimental-session.ts 清理
- import 的 SDK 类型改为 ACP 类型
- 事件流类型改为 `AsyncIterable<AcpEvent>`

#### 6c. stable-participant.ts 清理
- 同上

### 涉及文件
- `src/surfaces/vscode/acp-renderer.ts`
- `src/surfaces/vscode/experimental-session.ts`
- `src/surfaces/vscode/stable-participant.ts`

### 验证
- 编译通过
- surfaces 层零 SDK import

---

## Phase 7: 测试对齐 + 清理

**目标**: 更新所有测试，清理死代码。

### 步骤

#### 7a. 测试更新
- `src/test/streaming.test.ts` — 测试数据从 SDK 类型改为 ACP 类型，方法名 `bridgeEventsToStream` → `run`
- `src/test/handler.test.ts` — 删除 `denormalizeAcpEvent` 相关测试，更新 handler 测试的 mock 数据
- `src/test/commands.test.ts` — 适配新 ExtensionState 结构
- `src/test/integration/*` — 适配新接口

#### 7b. 死代码清理
- 删除 `denormalizeAcpEvent`、`denormalizePart`、`denormalizeToolState`（Phase 2 应已删）
- 删除 `unwrapStreamEvent`、`describeStreamEvent` 等辅助函数（如果不再需要）
- 删除 `AcpEventStream` 接口（如果 Phase 3 改为直接返回 AsyncIterable）
- 删除 `src/types/index.ts` 中的 `OpenCodeClient`、`OpenCodeServerController`、`OpenCodeApiResponse`（如果已移入后端）

#### 7c. Import 清理
- 运行 tsc 或 lint，确认无 unused import
- 确认框架层零 `@opencode-ai/sdk` 依赖
- 确认框架层零 `types/events.ts` 依赖

### 验证
- `npm run build` 零错误零警告
- `npm run test` 全部通过
- `npm run lint`（如有）通过
- 框架层（participant/、acp/、surfaces/、types/index.ts）中无 SDK import

---

## 依赖关系图

```
Phase 0 (基线验证)
    │
    ▼
Phase 1 (精简 ACP 类型)  ← 纯类型，无逻辑变更
    │
    ▼
Phase 2 (StreamBridge 重写)  ← 核心变更，最复杂
    │
    ├──────────────────┐
    ▼                  ▼
Phase 3 (接口精简)   Phase 5 (SDK 降级)
    │                  │
    ▼                  │
Phase 4 (State 精简)   │
    │                  │
    └────────┬─────────┘
             ▼
       Phase 6 (surfaces 对齐)
             │
             ▼
       Phase 7 (测试+清理)
```

Phase 3 和 Phase 5 可以并行。Phase 6 依赖 Phase 2 和 Phase 5 完成。

---

## 风险点

1. **StreamBridge 改写最复杂**（Phase 2）: 约 500 行代码，涉及事件分发、tool 状态机、permission 处理。建议分小步提交，每改一个事件类型就跑测试。

2. **测试数据迁移**: 测试中大量使用 SDK 类型构造 mock，需要逐一改为 ACP 类型。工作量大但机械。

3. **commands.ts 的 client 依赖**: `handleModelCommand` 直接用 SDK 的 `ConfigProvidersResponse`。Phase 3 需要通过 backend 扩展接口封装。

4. **integration test 依赖**: `live-opencode.ts` 和 `opencode-backend.integration.test.ts` 直接操作 SDK client。需要评估是否通过 backend 接口重写。
