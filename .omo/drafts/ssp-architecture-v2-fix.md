# SSP Architecture v2 修复设计文档

> 本文档记录 v2 重构后发现的架构缺陷分析，以及正确目标架构的设计决策。
> 
> 前置文档: `.sisyphus/drafts/ssp-architecture-v2.md` (原始 v2 设计)
> 计划文档: `.sisyphus/plans/ssp-architecture-v2.md` (已完成 26 个 Task)

## TL;DR

v2 重构完成了管线骨架（SSP 基类、Projector 接口、Bridge 路由、293 个测试），但**工具渲染逻辑从未从旧 Bridge 移植到 Projector**。当前工具卡片只能显示 emoji（🔧→✅），丢失了旧 Bridge 2000 行状态机中的全部富渲染能力。此外存在三重持久化 bug 和子代理渲染 stub。

本文档定义正确的分层职责和 5 个 Wave 的修复计划。

---

## 1. 当前实现的问题

### 1.1 VSCSPProjector 不接收 vscodeApi → ChatToolInvocationPart 永远不可用

**现象**: 所有工具完成/错误都降级为 emoji markdown（✅ / ❌）。

**根因**: `handler.ts:831` 创建 Projector 时只传 stream，不传 vscodeApi：
```typescript
// 当前（错误）
const projector = new VSCSPProjector(stream);

// VSCSPProjector.pushCompletedCard 内部:
const Ctor = this.vscodeApi?.ChatToolInvocationPart;
if (!Ctor) {  // ← 永远 true，vscodeApi 是 undefined
  this.stream.markdown(isError ? '❌' : '✅');
  return;
}
```

**旧 Bridge 做法**: `const VS = vscode as ProposedVscode` 直接在 Bridge 内部访问 proposed API 类。新架构把渲染移到了 Projector，但 handler 忘了把 VSCode 类型构造器注入。

### 1.2 SSP.render() 传给 Projector 的数据太薄

ToolInvocationSSP.render() 在 `completed` 状态只传 `{output, title, metadata}`，缺少 `toolName`、`input`、`startTime`、`endTime`。VSCSPProjector 无法执行 `buildToolSpecificData(toolName, input, output)` 和 `formatInvocationMsg(toolName, input, title)`。

### 1.3 三重持久化

一个 `part.updated` tool 事件触发 **3 次 JSONL 写入**到同一个 `turns.jsonl`：

| 写入路径 | 触发点 | 格式 |
|----------|--------|------|
| `serializer.append(ssp)` | `getOrCreateSSP()` 创建时 | SSP record |
| `serializer.append(this)` | `SSP.update()` 更新时 | SSP record |
| `callbacks.onEvent(event)` | `Bridge.persistEvent()` | SerializableStreamPart (via `serializeEvent`) |

**根因**: 新旧持久化路径同时存在。SSP 内部 serializer（v2 新路径）和 SerializableSessionStream callback（v1 旧路径）都在工作。

**决策**: 移除 SSP 内部 serializer，保留 SerializableSessionStream callback 作为唯一持久化路径。

**理由**: SerializableSessionStream 是经过验证的完整持久化系统（处理 turn 边界、快照、meta 更新、SerializableStreamPartEventHandler 逻辑）。JSONLSessionSerializer 是简化的新系统，功能不完整。设计文档期望"SSP 自管理持久化"，但这是一个可延后的优化——当前修复 bug 优先。

### 1.4 子代理渲染是 stub

```typescript
// VSCSPProjector 当前:
updateSubagentCard(_sessionId, scope) {
  this.stream.markdown(`↳ ${JSON.stringify(scope)}`);  // JSON dump
}
pushFinalSubagentUpdate(_sessionId, _scope) {
  this.stream.markdown('✓ Subagent complete');           // 纯文本
}
```

缺失：
- `subAgentInvocationId` 生成 → 子工具卡片无法嵌套到父卡片下
- `ChatSubagentToolInvocationData` 创建 → 无可展开子代理卡片
- `formatSubagentProgress()` → 无 "3× read, 2× edit" 活动摘要

### 1.5 外部编辑工具未抑制

旧 Bridge 的 `isExternalEditToolCall(toolName, callID)` 检测编辑器触发的 write/edit 并跳过工具卡片渲染。新代码没有这个检测，外部编辑会显示为普通工具卡片（错误行为）。

### 1.6 pushToolSpecificData / tool-data.ts 是死代码

- `VSCSPProjector.pushToolSpecificData()` 是 no-op
- 没有任何 SSP 的 render() 调用它
- `tool-data.ts` 的 7 个映射函数从未被执行

### 1.7 SSPFactory 是死代码

- 被 import 在 bridge.ts 中但从未调用
- Bridge 直接用 `new ToolInvocationSSP(...)` 创建 SSP
- Session restore 也绕过 factory，通过 `bridge.processEvent()` 重放事件

---

## 2. 正确目标架构

### 2.1 设计原则（来自用户原始需求）

1. **固定单向管线**: `RawEvent → AcpEvent → SSP → VSCSP`，无回调
2. **SSP 驱动渲染**: SSP 决定何时渲染什么，Projector 翻译成具体 Surface API
3. **Projector 是哑翻译器**: 不做决策，只做映射（但映射本身可以很复杂）
4. **不在 src/acp/ 中 import VSCode**: 通过 Projector 接口和构造器注入解耦

### 2.2 分层职责

```
┌─────────────────────────────────────────────────────────────────┐
│ ToolInvocationSSP (src/acp/ssp/impl/tool-invocation.ts)       │
│                                                                 │
│ 职责:                                                           │
│   - 生命周期追踪 (pending→running→completed→error)             │
│   - isFirstRender 追踪 (begin vs update)                       │
│   - 传递完整数据给 Projector                                    │
│                                                                 │
│ render() 调用 Projector:                                        │
│   p.beginToolInvocation(callId, toolName, {                    │
│     status, input, title                                       │
│   })                                                           │
│   p.updateToolInvocation(callId, {                             │
│     status, input, title                                       │
│   })                                                           │
│   p.completeToolInvocation(callId, {                           │
│     toolName, input, output, title,                            │
│     startTime, endTime, metadata,                              │
│     subAgentInvocationId                                       │
│   })                                                           │
│   p.errorToolInvocation(callId, {                              │
│     toolName, error, input                                     │
│   })                                                           │
│                                                                 │
│ 不做:                                                           │
│   ❌ formatInvocationMsg (surface-specific, 需要工具名到自然语言映射) │
│   ❌ buildToolSpecificData (需要 VSCode 类型)                   │
│   ❌ 创建 ChatToolInvocationPart                                │
└────────────────────────────┬────────────────────────────────────┘
                             │ Projector interface
                             ▼
┌─────────────────────────────────────────────────────────────────┐
│ VSCSPProjector (src/acp/projector/vscsp.ts)                   │
│                                                                 │
│ 构造: new VSCSPProjector(stream, vscodeApi)                    │
│   vscodeApi = {                                                 │
│     ChatToolInvocationPart,      // from vscode proposed API   │
│     ChatSubagentToolInvocationData,                              │
│   }                                                             │
│                                                                 │
│ 职责 (工具渲染):                                                 │
│   - 接收 SSP 传来的结构化数据                                    │
│   - formatInvocationMsg(toolName, input, title)                │
│       → "Reading src/index.ts", "Running npm install"          │
│   - formatPastTenseMsg(toolName, title, start, end)            │
│       → "Read src/index.ts (0.3s)"                             │
│   - buildToolSpecificData(toolName, input, output)             │
│       → bash: ChatTerminalToolInvocationData                   │
│       → list/grep: ChatSimpleToolResultData                    │
│       → read/write/edit: ChatToolResourcesInvocationData       │
│       → task: ChatSubagentToolInvocationData                   │
│       → todo: ChatTodoToolInvocationData                       │
│       → 其他: ChatSimpleToolResultData                         │
│   - 创建 ChatToolInvocationPart (所有属性)                      │
│   - 处理 fallback (markdown 降级)                               │
│   - transient tool presentation (hiddenAfterComplete)          │
│                                                                 │
│ 职责 (子代理渲染):                                               │
│   - updateSubagentCard: 创建 ChatSubagentToolInvocationData    │
│   - pushFinalSubagentUpdate: 最终卡片 + formatSubagentProgress │
│                                                                 │
│ 不做:                                                           │
│   ❌ 生命周期决策 (SSP 的职责)                                   │
│   ❌ 状态累积 (SSP 的职责)                                       │
└────────────────────────────┬────────────────────────────────────┘
                             │
                             ▼
                    VSCode ChatResponseStream
```

### 2.3 Bridge 职责（修复后）

```
┌─────────────────────────────────────────────────────────────────┐
│ OpenCodeBridge (src/backends/opencode/opencode-bridge.ts)      │
│                                                                 │
│ 职责:                                                           │
│   - 事件路由 (switch/case → 对应 SSP handler)                   │
│   - subAgentInvocationId 生成和传播                             │
│   - 外部编辑工具检测和抑制                                       │
│   - 子代理 deferred idle 管理                                    │
│   - 持久化 callback (persistEvent → SerializableSessionStream) │
│   - 结果提取 (getUserMessageId, getSessionTitle)               │
│                                                                 │
│ 不做:                                                           │
│   ❌ 渲染逻辑 (已移到 Projector)                                 │
│   ❌ 直接持久化 SSP (移除 serializer)                           │
│   ❌ 工具状态机 (已移到 ToolInvocationSSP)                      │
└─────────────────────────────────────────────────────────────────┘
```

---

## 3. 关键架构决策

### 3.1 工具特定渲染逻辑归属

**决策**: Hybrid 分层。

- **ToolInvocationSSP** 准备结构化数据（toolName, state, input, output, timing）但不知道 VSCode 类型
- **VSCSPProjector** 接收数据后映射到 VSCode 类型（ChatTerminalToolInvocationData 等）

**理由**:
- SSP 不能 import vscode（约束），但 VSCSPProjector 是 VSCode 集成点，可以也应该知道 VSCode 类型
- 消息格式化（"Reading X", "Ran X (0.3s)"）是 surface-specific 的，不同 surface 有不同的人类可读格式
- 工具类型映射（bash→terminal, read→resources）需要 VSCode 类型构造器

**选择 Hybrid 而非 SSP-internal 的原因**: 如果 SSP 直接构造 VSCode 类型数据，就违反了"不在 src/acp/ 中 import VSCode"约束。

**选择 Hybrid 而非 Projector-internal-only 的原因**: SSP 需要决定何时 begin/update/complete（生命周期决策），这是 SSP 的核心职责。

### 3.2 VSCSPProjector 如何获取 VSCode 类型构造器

**决策**: 构造器注入（Option A）。

```typescript
// handler.ts (有 vscode import 权限)
import * as vscode from 'vscode';
import { ChatToolInvocationPart, ChatSubagentToolInvocationData }
  from '../types/vscode-proposed-additions';

const VS = vscode as typeof vscode & {
  ChatToolInvocationPart?: typeof ChatToolInvocationPart;
  ChatSubagentToolInvocationData?: typeof ChatSubagentToolInvocationData;
};

const projector = new VSCSPProjector(stream, {
  ChatToolInvocationPart: VS.ChatToolInvocationPart,
  ChatSubagentToolInvocationData: VS.ChatSubagentToolInvocationData,
});
```

**理由**:
- handler.ts 已经有 `import * as vscode from 'vscode'`
- VSCSPProjector 通过 `VsCodeApi` 接口接收构造器，不直接 import vscode
- 运行时 proposed API 通过 `enabledApiProposals: ["chatParticipantAdditions"]` 已启用
- 类型定义在 `src/types/vscode-proposed-additions.ts` 中

**不选 "移动 VSCSPProjector 到 src/surfaces/vscode/" 的原因**: VSCSPProjector 当前位置在 `src/acp/projector/` 是合理的（它是 ACP 层的 Projector 实现），移动会增加改动面。构造器注入已经足够解耦。

### 3.3 Projector 接口变更

**决策**: 最小变更。

当前接口方法签名已经用 `Record<string, unknown>` 作为 data 参数，足够灵活。不需要改变签名，只需要：
- SSP 传更多字段到 `Record<string, unknown>` 中
- VSCSPProjector 从 `Record<string, unknown>` 中提取更多字段

**移除死方法**:
- `pushToolSpecificData()` — 合并到 `completeToolInvocation` 内部处理
- `pushToolInvocationFallback()` — Projector 内部处理 fallback

**保留方法（15→13）**:
```
markdown(content)
thinkingProgress(content)
beginToolInvocation(callId, toolName, data)
updateToolInvocation(callId, data)
completeToolInvocation(callId, data)
errorToolInvocation(callId, data)
beginExternalEdit(callId)
endExternalEdit(callId, editId)
updateSubagentCard(sessionId, scope)
pushFinalSubagentUpdate(sessionId, scope)
progress(message)
reference(uri)
finalize()
```

### 3.4 subAgentInvocationId 生成归属

**决策**: Bridge 生成，传递给 SubagentSSP 和子 ToolInvocationSSP。

```typescript
// Bridge.handlePartUpdated() — 当检测到 task/subagent 工具时:
if (toolName === 'task' || toolName === 'subagent') {
  const subAgentInvocationId = `subagent-${toolPart.callId}-${Date.now()}`;
  // 存储到 SubagentSSP
  // 后续子工具事件从 subagentSSPs map 中查询 parent 的 subAgentInvocationId
  // 传给 ToolInvocationSSP → Projector.completeToolInvocation(data.subAgentInvocationId)
}
```

**理由**:
- Bridge 是事件路由器，有跨 SSP 协调上下文
- SubagentSSP 可以暴露 subAgentInvocationId 但不应自己生成（它不知道自己何时被"创建"）
- 子工具需要知道 parent 的 subAgentInvocationId 才能嵌套

### 3.5 持久化去重方案

**决策**: 移除 SSP 内部 serializer，保留 Bridge callback 持久化。

具体变更：
1. `SSP.attach()` 只接收 `projector`，不接收 `serializer`
2. `SSP.update()` 移除 `this._serializer?.append(this)`
3. `Bridge.getOrCreateSSP()` 移除 `this.serializer?.append(ssp)`
4. `Bridge.setProjector(projector, serializer)` 改为 `setProjector(projector)`
5. `Bridge.persistEvent()` 保持不变（唯一持久化路径）
6. `SerializableSessionStream.onEvent()` 保持不变（唯一持久化实现）

**延后优化**: 未来可以将 SerializableSessionStream 的逻辑重构为 SSP 的 serializer，实现设计文档中的"SSP 自管理持久化"。但这需要 SerializableSessionStream 支持 turn 边界、快照等高级功能，当前不在修复范围内。

### 3.6 外部编辑工具抑制归属

**决策**: Bridge 检测和抑制。

```typescript
// Bridge.handlePartUpdated() — 在创建 ToolInvocationSSP 之前:
if (this.isExternalEditToolCall(toolName, toolPart.callId)) {
  return;  // 跳过工具卡片渲染
}
```

**理由**:
- Projector 不应该知道编辑同步逻辑
- SSP 不应该知道哪些工具调用是编辑器触发的
- Bridge 是唯一能做这个判断的层（它管理 ExternalEditSSP 的生命周期）

### 3.7 消息格式化函数移植

**决策**: 从旧 Bridge 移植到 VSCSPProjector。

| 函数 | 旧位置 | 新位置 | 原因 |
|------|--------|--------|------|
| `formatInvocationMsg()` | Bridge 内部 | VSCSPProjector | Surface-specific（VSCode 特定的人类可读格式） |
| `formatPastTenseMsg()` | Bridge 内部 | VSCSPProjector | 同上 |
| `buildToolSpecificData()` | Bridge 内部 | VSCSPProjector | 需要 VSCode 类型（ChatTerminalToolInvocationData 等） |
| `isTransientFileTool()` | Bridge 模块函数 | VSCSPProjector | Surface-specific 行为（presentation 属性） |
| `formatSubagentProgress()` | `src/participant/subagent.ts` | VSCSPProjector 或保留为共享工具 | 纯字符串格式化，可共享 |

`formatSubagentProgress()` 是纯函数不依赖 VSCode，可以保留在 `src/participant/subagent.ts` 或移到 `src/acp/shared/` 中由 VSCSPProjector import。

---

## 4. 各文件修改清单

### 4.1 新增文件

| 文件 | 用途 |
|------|------|
| `src/acp/projector/tool-format.ts` | `formatInvocationMsg`, `formatPastTenseMsg`, `isTransientFileTool` — 从旧 Bridge 移植 |

### 4.2 修改文件

| 文件 | 修改内容 |
|------|---------|
| `src/acp/projector/types.ts` | 移除 `pushToolSpecificData`, `pushToolInvocationFallback` |
| `src/acp/projector/vscsp.ts` | 扩展 `VsCodeApi` 接口；实现 `completeToolInvocation` 富渲染；移植 `buildToolSpecificData`；重写 `updateSubagentCard`/`pushFinalSubagentUpdate`；注入 `formatInvocationMsg` 等函数 |
| `src/acp/ssp/types.ts` | `attach()` 移除 serializer 参数；`update()` 移除 serializer.append；移除 `_serializer` 字段 |
| `src/acp/ssp/impl/tool-invocation.ts` | `render()` 传完整数据（toolName, input, output, timing, subAgentInvocationId） |
| `src/acp/ssp/impl/subagent.ts` | `render()` 传 subAgentInvocationId；使用 formatSubagentProgress |
| `src/backends/opencode/opencode-bridge.ts` | 移除 serializer；生成 subAgentInvocationId；添加 isExternalEditToolCall；`setProjector` 改签名 |
| `src/participant/handler.ts` | 传入 vscodeApi 给 VSCSPProjector 构造器 |
| `src/acp/ssp/factory.ts` | 删除（死代码） |

### 4.3 删除文件

| 文件 | 原因 |
|------|------|
| `src/acp/ssp/factory.ts` | 死代码（Bridge 直接创建 SSP，从不调用 factory） |
| `src/acp/projector/tool-data.ts` | 逻辑移入 VSCSPProjector 内部（或 tool-format.ts） |
| `src/acp/serializer/session-serializer.ts` | 不再需要（SSP 不再内部持久化） |

### 4.4 修改测试

| 文件 | 修改内容 |
|------|---------|
| `src/test/ssp/factory.test.ts` | 删除（factory 被删除） |
| `src/test/ssp/compat.test.ts` | 删除或重构（不再测 factory.fromJSON） |
| `src/test/streaming.test.ts` | 移除 serializer 参数；传入 vscodeApi |
| `src/test/projector/vscsp.test.ts` | 增加 vscodeApi 测试；测试富工具渲染 |
| `src/test/projector/tool-data.test.ts` | 删除（tool-data.ts 被删除） |
| `src/test/serializer/session-serializer.test.ts` | 删除（serializer 被删除） |

---

## 5. 实施波次

### Wave 1: 基础设施修复（无依赖）

| Task | 文件 | 描述 |
|------|------|------|
| W1-T1 | `handler.ts` | 传入 vscodeApi 给 VSCSPProjector 构造器 |
| W1-T2 | `src/acp/ssp/types.ts` | `attach()` 移除 serializer 参数；`update()` 移除 serializer.append |
| W1-T3 | `src/backends/opencode/opencode-bridge.ts` | 移除 serializer 字段；`setProjector` 改为只接 projector；`getOrCreateSSP` 不再调 serializer.append |
| W1-T4 | `src/acp/projector/types.ts` | 移除 `pushToolSpecificData`, `pushToolInvocationFallback` |
| W1-T5 | `src/acp/projector/vscsp.ts` | 移除 pushToolSpecificData, pushToolInvocationFallback 方法 |
| W1-T6 | 各测试文件 | 更新 setProjector 签名；移除 serializer 参数 |

**验证**: `bun test` 通过；`tsc --noEmit` 零错误

### Wave 2: 工具渲染移植（依赖 Wave 1）

| Task | 文件 | 描述 |
|------|------|------|
| W2-T1 | `src/acp/projector/tool-format.ts` (新) | 移植 `formatInvocationMsg` (~70行), `formatPastTenseMsg` (~80行), `isTransientFileTool` (~5行) 从旧 Bridge |
| W2-T2 | `src/acp/projector/vscsp.ts` | 移植 `buildToolSpecificData` (~100行) 到 VSCSPProjector |
| W2-T3 | `src/acp/projector/vscsp.ts` | 重写 `completeToolInvocation`: 创建 ChatToolInvocationPart 含所有属性 (invocationMessage, pastTenseMessage, toolSpecificData, presentation, enablePartialUpdate, isComplete) |
| W2-T4 | `src/acp/projector/vscsp.ts` | 重写 `errorToolInvocation`: 创建 ChatToolInvocationPart 含 isError |
| W2-T5 | `src/acp/projector/vscsp.ts` | 改进 `beginToolInvocation`: 传 invocationMessage |
| W2-T6 | `src/acp/ssp/impl/tool-invocation.ts` | `render()` 传完整数据: completed 传 `{toolName, input, output, title, startTime, endTime, metadata}`; error 传 `{toolName, error, input}` |
| W2-T7 | `src/acp/projector/vscsp.ts` | 扩展 `VsCodeApi` 接口: 增加 ChatSubagentToolInvocationData |
| W2-T8 | 测试 | VSCSPProjector 富渲染测试: 验证 ChatToolInvocationPart 创建；验证 toolSpecificData 映射；验证 fallback 降级 |

**验证**: 对比旧 Bridge 输出（用相同输入跑旧 Bridge 和新 Projector，比较 stream.push 调用）

### Wave 3: 子代理渲染（依赖 Wave 2）

| Task | 文件 | 描述 |
|------|------|------|
| W3-T1 | `src/backends/opencode/opencode-bridge.ts` | 生成 `subAgentInvocationId`; 存储到 SubagentSSP |
| W3-T2 | `src/backends/opencode/opencode-bridge.ts` | 子工具事件路由: 查询 parent 的 subAgentInvocationId 并传给 ToolInvocationSSP |
| W3-T3 | `src/acp/ssp/impl/subagent.ts` | 暴露 `subAgentInvocationId` 字段; `render()` 传给 Projector |
| W3-T4 | `src/acp/ssp/impl/tool-invocation.ts` | `render()` 从 payload.subAgentInvocationId 传给 Projector |
| W3-T5 | `src/acp/projector/vscsp.ts` | 重写 `updateSubagentCard`: 创建 ChatSubagentToolInvocationData |
| W3-T6 | `src/acp/projector/vscsp.ts` | 重写 `pushFinalSubagentUpdate`: 使用 formatSubagentProgress + ChatSubagentToolInvocationData |
| W3-T7 | 测试 | 子代理卡片测试; subAgentInvocationId 传播测试 |

### Wave 4: 外部编辑（依赖 Wave 2）

| Task | 文件 | 描述 |
|------|------|------|
| W4-T1 | `src/backends/opencode/opencode-bridge.ts` | 添加 `isExternalEditToolCall()` 检测; 在 handlePartUpdated 中抑制 |
| W4-T2 | `src/acp/projector/vscsp.ts` | `beginExternalEdit`/`endExternalEdit`: 实现或保留 no-op（取决于 VSCode experimental API 可用性） |
| W4-T3 | 测试 | 外部编辑抑制测试 |

### Wave 5: 清理

| Task | 文件 | 描述 |
|------|------|------|
| W5-T1 | `src/acp/ssp/factory.ts` | 删除文件 |
| W5-T2 | `src/acp/projector/tool-data.ts` | 删除文件（逻辑已在 VSCSPProjector 中） |
| W5-T3 | `src/acp/serializer/session-serializer.ts` | 删除文件（不再使用） |
| W5-T4 | 对应测试文件 | 删除 factory.test.ts, tool-data.test.ts, session-serializer.test.ts |
| W5-T5 | `src/backends/opencode/opencode-bridge.ts` | 移除 SSPFactory import |

---

## 6. 约束清单

### Must NOT（不变）

- 不变更 JSONL v2 格式
- 不删除 `src/acp/serializable/types.ts`（保留为序列化合约）
- 不在 SSP 中 import VSCode（通过 Projector 接口和构造器注入解耦）
- 不引入新持久化存储（继续使用 `.acpilot/` 目录）

### Must Have（新增）

- VSCSPProjector 构造器接收 vscodeApi（ChatToolInvocationPart 等构造器）
- ToolInvocationSSP.render() 传完整数据（toolName, input, output, timing）
- VSCSPProjector.completeToolInvocation 创建完整 ChatToolInvocationPart
- Bridge 生成 subAgentInvocationId 并传播给子工具
- Bridge 检测并抑制外部编辑工具卡片
- 单一持久化路径（SerializableSessionStream callback）

---

## 7. 风险和缓解

### 7.1 VSCode Proposed API 可用性

**风险**: `ChatToolInvocationPart` 等 proposed API 在运行时可能不可用（取决于 VSCode 版本）。

**缓解**: VSCSPProjector 已有 capabilities 检测（`hasToolUI`, `vscodeApi?.ChatToolInvocationPart`）。当不可用时降级为 markdown emoji。这与旧 Bridge 行为一致。

### 7.2 持久化回归

**风险**: 移除 SSP serializer 后，如果 SerializableSessionStream.onEvent() 对某些事件类型处理不完整，可能导致数据丢失。

**缓解**: SerializableSessionStream.onEvent() 调用 `streamPartHandler.serializeEvent(event)` 处理所有 ACP 事件类型。Wave 1 验证时需确认所有事件类型都被正确序列化。

### 7.3 测试覆盖

**风险**: 现有 293 个测试只覆盖 SSP 数据结构，不覆盖 Projector 实际渲染输出。

**缓解**: Wave 2-T8 专门增加 VSCSPProjector 富渲染测试。测试策略：用 mock stream 记录所有 push() 调用，验证 ChatToolInvocationPart 的属性。

### 7.4 旧 Bridge 参考可用性

**风险**: 修复完成后旧 Bridge（git HEAD）可能被覆盖。

**缓解**: 旧 Bridge 代码可通过 `git show HEAD:src/backends/opencode/opencode-bridge.ts` 获取。所有移植的函数都标注来源行号。
