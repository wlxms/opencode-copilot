# Plan: SSP Direct-Stream Refactor (v3)

> 从 master 分支重新开始。移除 Projector 概念,SSP 直接与 VSCode Stream 通信。
> 这是对失败分支 `refactor/ssp-projector-bridge` 的彻底重做,规避其 7 个致命缺陷。

## TL;DR

将主干 Bridge 双通道架构(2201 行渲染状态机 + callback 持久化)重构为 **SSP-first 单向管线**。
SSP 升级为 abstract class,**同时承担序列化(toJSON)和渲染(render to stream)**。
Bridge 退化为纯路由 + ExternalEditTracker 协作 + 子代理层级管理。
**无 Projector 中间层** —— SSP 直接 `import` vscode 类型并持有 stream 引用。

### 核心架构定位(用户反馈修正)
- **SSP 独立于 ACP** —— 目录 `src/ssp/`,是贴近 vscode 和扩展本身的概念
- **ACP backend 的 bridge 只是"推送" SSP**(消费方),SSP 本身是独立的标准单元
- **SSP 可直接 import vscode 类型**(从 `src/types/vscode-proposed-additions.ts`),不受 ACP 层约束
- **ExternalEditSSP 使用 tracker**(类似 vscode externalEditStream 模式),SSP 内部驱动 tracker

- **Deliverables**: SSP 基类 + 8 concrete SSP(无 Factory)+ Bridge 瘦路由 + 完整测试链路
- **Estimated Effort**: XL
- **执行原则**: 实施阶段不开子代理(保持上下文一致);规划阶段已用 explore + Momus

---

## Context

### 用户原始需求
1. 切回主干,基于 SSP 文档重新重构 ✓(已在 master)
2. **移除 Projector 概念,SSP 直接与 VSCode Stream 通信**
3. SSP 作为序列化和渲染的标准单元而存在
4. 保证所有功能不丢失,所有路径有测试(mock vscode,完整链路跑通)
5. 工具渲染重点:read complete 后不能刷新 tense message;edit 必须走 asked 流程
6. 工具实现是核心,不能 no op
7. 执行时不开子代理,只在规划阶段用子代理

### 失败分支教训(v2-fix.md 揭示的 7 个致命缺陷)
| # | 缺陷 | 根因 | 本计划规避措施 |
|---|------|------|---------------|
| 1 | VSCSPProjector 没接收 vscodeApi → 工具卡片只有 emoji | Projector 构造只传 stream | **无 Projector**;SSP 直接 import vscode 类型 |
| 2 | SSP.render() 传给 Projector 数据太薄 | 接口设计太抽象 | ToolInvocationSSP 内化完整渲染逻辑,直接访问 stream |
| 3 | 三重持久化(serializer + callback) | 新旧路径并存 | **单一持久化路径**:SerializableSessionStream callback |
| 4 | 子代理渲染是 JSON dump stub | 未实现 | SubagentSSP + formatSubagentProgress 完整实现 |
| 5 | 外部编辑工具未抑制 | 缺检测 | Bridge 保留 isExternalEditToolCall + externalEditCallIds |
| 6 | pushToolSpecificData/tool-data.ts 死代码 | 拆分过早 | 工具映射内化到 ToolInvocationSSP,不单独提取 |
| 7 | SSPFactory 死代码(返回 StubSSP) | 未真正实现 | **无 Factory**;Bridge 直接 `new` 具体 SSP(规避死代码) |

### 关键行为契约(必须 100% 兼容,来自主干 opencode-bridge.ts)
- **契约 C1 — read 完成不刷新 tense**: `pushToolInvocation` L1267-L1269: read 工具 complete 后**只设 `invocationMessage`,不设 `pastTenseMessage`**;fallback 路径 L1335-L1337 直接 return
- **契约 C2 — edit 走 asked 流程**: `permission.asked` → `tracker.trackEdit()` → `externalEditCallIds.add()` → 后续 pending/running/completed 全部 `isExternalEditToolCall` 跳过渲染;未被 asked 拦截的 edit 才走正常卡片
- **契约 C3 — progressive 幂等**: 首次 running → `push(isComplete=false)` + `progressivePushed.add`;后续 running → `updateToolInvocation(invocationMessage)`;completed → `push(isComplete=true)` 新 part
- **契约 C4 — toolSpecificData 7 映射**: read/write/edit→undefined;bash→ChatTerminalToolInvocationData;list/grep/websearch/fetch/context→ChatSimpleToolResultData;task/subagent→ChatSubagentToolInvocationData;todo→ChatTodoToolInvocationData 或 simpleResult;其他→simpleResult
- **契约 C5 — presentation**: read/write/edit/internal/step-start/step-finish → `hiddenAfterComplete`;外部编辑隐藏 → `hidden`
- **契约 C6 — 初始化序列**: SessionStream → ExternalEditTracker(onSnapshot,getTurnIndex) → bridge.setStream/setCallbacks/setTracker;续写循环每轮新建 Bridge 实例,重用 SessionStream+Tracker

---

## 目标架构

### 事件管线(固定单向)
```
SDK SSE → normalizeStreamEvent() → AcpEvent
    │
    ▼ Bridge.processEvent(event)        [opencode-bridge.ts — 瘦路由]
    │   ├── part.updated → getOrCreateSSP(part.id) → ssp.update(part)
    │   ├── part.delta   → ssps.get(partId).applyDelta(delta)
    │   ├── permission.asked(edit) → ExternalEditSSP.beginEdit() (内部调 tracker.trackEdit) + auto-reply
    │   ├── permission.asked(other) → InteractionRequestSSP
    │   ├── tool completed(edit) → ExternalEditSSP.completeEdit() (内部调 tracker.completeEdit)
    │   ├── tool completed(other) → ToolInvocationSSP 渲染(检查 externalEditCallIds 抑制)
    │   ├── session.idle → deferred idle check → stream finalize
    │   └── default → RawAcpEventSSP
    │
    ▼ SSP.update(delta)                  [SSP 自身行为]
        ├── merge(delta)                 [状态累积]
        ├── persist via callback         [Bridge 触发 callbacks.onEvent]
        └── render()                     [SSP 直接调 stream API]
            ├── stream.markdown() / thinkingProgress()
            ├── stream.push(new vscode.ChatToolInvocationPart(...))  ← 直接 import vscode 类型
            └── stream.beginToolInvocation() / updateToolInvocation()
```

### 与 v2 的核心差异
| 维度 | v2(失败) | v3(本计划) |
|------|----------|------------|
| 渲染抽象 | SSP → Projector 接口 → VSCSPProjector → stream | **SSP → stream(直接)** |
| vscode 类型获取 | Projector 构造器(常被遗忘) | **SSP 直接 `import` vscode 类型** |
| SSP 归属 | src/ssp/(误归于 ACP) | **src/ssp/(独立模块,贴近 vscode)** |
| 持久化 | SSP 内部 serializer + callback(三重) | **单一 callback(SerializableSessionStream)** |
| 工具渲染逻辑 | 拆到 tool-data.ts(死代码) | **内化到 ToolInvocationSSP 私有方法** |
| 工具卡片抑制 | 缺失(缺陷 #5) | **Bridge 保留 isExternalEditToolCall** |
| ExternalEdit | ExternalEditTracker 独立于 SSP | **ExternalEditSSP 使用 tracker(SSP 内部驱动)** |

---

## 关键设计决策

### D1: SSP 独立于 ACP,直接 import vscode 类型(目录 src/ssp/)
**决策**: SSP 模块放在 `src/ssp/`(不是 `src/ssp/`)。SSP 是独立于 ACP 的概念,贴近 vscode 和扩展本身。ACP backend 的 bridge 只是"推送"SSP(消费方)。
SSP 直接 `import type { ChatToolInvocationPart, ... } from '../types/vscode-proposed-additions'` 获取类型,运行时通过 `import * as vscode from 'vscode'` 拿到构造器(测试时 vitest alias 自动 mock)。
**理由**: 
- SSP 不应被 ACP 层约束(如"不 import vscode")—— 它本身是贴近 vscode 的渲染标准单元
- 规避 v2 缺陷 #1(vscodeApi 未注入)—— 直接 import,编译期保证类型可用,无需运行时注入构造器
- stream 仍需运行时注入(每个会话有不同的 stream),通过 `attach(stream)` 传入
- 测试可行:主干 opencode-bridge.ts 就是直接 import vscode,测试通过 vitest.config.ts alias mock

```typescript
// src/ssp/types.ts
import type * as vscode from 'vscode';
import type { ChatToolInvocationPart } from '../types/vscode-proposed-additions';

abstract class SerializableStreamPart<TKind, TPayload> {
  // ... 序列化字段
  protected stream?: vscode.ChatResponseStream;  // 运行时注入,不参与序列化
  
  attach(stream: vscode.ChatResponseStream): void {
    this.stream = stream;
    this.render();
  }
}

// src/ssp/impl/tool-invocation.ts
import * as vscode from 'vscode';

class ToolInvocationSSP extends SerializableStreamPart<'toolInvocation', ...> {
  protected render(): void {
    const VS = vscode as typeof vscode & { ChatToolInvocationPart?: typeof ChatToolInvocationPart };
    if (!VS.ChatToolInvocationPart || !this.stream?.push) {
      this.renderFallback();  // 降级
      return;
    }
    const part = new VS.ChatToolInvocationPart(toolName, callId);
    // ... 设置属性
    this.stream.push(part);
  }
}
```

### D2: 单一持久化路径(SerializableSessionStream callback)
**决策**: 移除 SSP 内部 serializer 概念。持久化由 Bridge 在 `processEvent` 后调用 `callbacks.onEvent(event)` 触发,SerializableSessionStream 负责实际 JSONL 写入。
**理由**: v2 缺陷 #3(三重持久化)证明 SSP 自管理持久化是反模式。SerializableSessionStream 是验证过的完整系统(处理 turn 边界、快照、meta)。

### D3: ExternalEditSSP 使用 tracker(类似 vscode externalEditStream 模式)
**决策**: 保留 ExternalEditTracker(不删除),但 ExternalEditSSP **内部驱动** tracker。
- `ExternalEditTracker` 保留在 `src/participant/external-edit-tracker.ts`,处理 VSCode Promise-based deferred lifecycle 和 ExternalEditPart 快照
- `ExternalEditSSP` 持有 tracker 引用(通过构造器或 attach 传入),内部调用 `tracker.trackEdit()` / `tracker.completeEdit()`
- Bridge 把 `permission.asked(edit)` 事件路由到 `ExternalEditSSP.beginEdit()`,把 `tool:completed(edit)` 路由到 `ExternalEditSSP.completeEdit()`
- 工具卡片抑制(`externalEditCallIds`)仍由 Bridge 管理(Bridge 是事件路由器,有跨 SSP 协调上下文)
**理由**: 
- tracker 和 SSP 逻辑不冲突,可以共存
- 类似 vscode externalEditStream 的使用方式:SSP 作为上层抽象,tracker 作为底层工具
- edit 生命周期管理集中在 ExternalEditSSP(而非散落在 Bridge)
- tracker 的 Promise deferred 生命周期仍然由 tracker 自己管理(风险隔离)

### D4: 工具渲染辅助函数内化到 ToolInvocationSSP
**决策**: `formatInvocationMsg` / `formatPastTenseMsg` / `buildToolSpecificData` / `isTransientFileTool` 作为 ToolInvocationSSP 的私有方法或模块级私有函数(同文件),不单独提取到 tool-data.ts。
**理由**: v2 缺陷 #6(tool-data.ts 死代码)证明过早拆分是反模式。这些函数只服务工具渲染,内化后封装清晰,测试更直接。

### D5: 无 Factory,Bridge 直接构建 SSP
**决策**: 不创建 SSPFactory。Bridge 在 `processEvent` 的 switch/case 中直接 `new ToolInvocationSSP(...)` / `new AssistantTextSSP(...)` 等。
**理由**: 
- Bridge 的 switch/case 已经在做类型分发,再套 Factory 是重复逻辑
- v2 缺陷 #7 证明 Factory 在实践中会变成死代码(Bridge 绕过它直接 new)
- 恢复路径用主干现有 `projectStreamPartToAcpEvent → Bridge.processEvent`,不需要 fromJSON
- YAGNI:目前只有 Bridge 一个消费方,不需要工厂模式

### D6: 测试驱动验收(防 Oracle 审计漏判)
**决策**: 每个工具类型的验收测试必须**实际验证 stream.push 调用的 ChatToolInvocationPart 属性**(invocationMessage/pastTenseMessage/toolSpecificData/presentation/isComplete),而非仅验证"方法被调用"。
**理由**: v2 的 Oracle 审计 APPROVE 了 285 个测试通过,但实际工具卡片只有 emoji。测试必须深入断言 part 属性,不只看调用次数。

---

## 文件变更范围

### 新增文件
| 文件 | 职责 | 行数估算 |
|------|------|---------|
| `src/ssp/types.ts` | SSP 抽象基类(直接 import vscode 类型) | ~120 |
| `src/ssp/impl/assistant-text.ts` | AssistantTextSSP | ~60 |
| `src/ssp/impl/reasoning.ts` | ReasoningSSP | ~60 |
| `src/ssp/impl/tool-invocation.ts` | ToolInvocationSSP + format/build 私有函数 ⭐核心 | ~450 |
| `src/ssp/impl/external-edit.ts` | ExternalEditSSP(内部驱动 tracker) | ~150 |
| `src/ssp/impl/subagent.ts` | SubagentSSP + subAgentInvocationId | ~150 |
| `src/ssp/impl/session-lifecycle.ts` | SessionLifecycleSSP + SessionDiffSSP | ~80 |
| `src/ssp/impl/interaction.ts` | InteractionRequestSSP + InteractionResponseSSP | ~80 |
| `src/ssp/impl/raw-acp-event.ts` | RawAcpEventSSP 兜底 | ~40 |

> **无 SSPFactory** —— Bridge 的 switch/case 已做类型分发,直接 `new ToolInvocationSSP(...)` 更直接(规避 v2 缺陷 #7:Factory 死代码)。恢复路径用主干现有 `projectStreamPartToAcpEvent → processEvent`,不需要 fromJSON。

### 修改文件
| 文件 | 变更 |
|------|------|
| `src/backends/opencode/opencode-bridge.ts` | 2201 行 → ~400 行瘦路由;edit 逻辑路由到 ExternalEditSSP;保留 externalEditCallIds、deferred idle、isExternalEditToolCall、结果提取 |
| `src/participant/handler.ts` | Bridge 初始化改为 `bridge.attach(stream, tracker)`;移除 setStream/setCallbacks 分离调用 |
| `src/acp/backend.ts` | AcpBridge 接口:`setStream/setCallbacks/setTracker` → `attach(stream, tracker?)/setCallbacks` |

### 保留不变(兼容契约)
| 文件 | 说明 |
|------|------|
| `src/acp/serializable/types.ts` | JSONL 序列化合约(13 种 kind + payload 接口) |
| `src/acp/serializable/stream-parts.ts` | AcpEvent↔SSP 映射 + projectStreamPartToAcpEvent |
| `src/acp/serializable/serializer.ts` | JSONL v2 I/O |
| `src/acp/streaming/session-stream.ts` | SerializableSessionStream(唯一持久化路径) |
| `src/acp/streaming/collector-stream.ts` | CollectorStream(会话恢复) |
| `src/participant/external-edit-tracker.ts` | ExternalEditTracker(保留,Promise 生命周期;被 ExternalEditSSP 驱动) |
| `src/types/vscode-proposed-additions.ts` | vscode proposed API 类型(SSP 直接 import) |

### 删除文件
无(不删除任何主干文件,只新增 SSP 层和重写 Bridge)

---

## 实施波次

> 执行原则:实施阶段不开子代理,由 Sisyphus 自己实施。每完成一个 Task 立即跑测试验证。

### Wave 1: Foundation(无依赖)

#### T1: SSP 抽象基类
- **创建** `src/ssp/types.ts`
- `abstract class SerializableStreamPart<TKind, TPayload>`:
  - 字段:`kind`, `version: 1`, `id`, `payload`, `meta`(与 serializable/types.ts:90-99 兼容)
  - `protected stream?: vscode.ChatResponseStream`(运行时依赖,不参与序列化;直接 import vscode 类型)
  - `attach(stream: vscode.ChatResponseStream): void` — 注入 stream,调 `render()` 初始渲染
  - `update(delta): void` — `merge(delta)` → `meta.sequence++` → `if(stream) render()`(注:持久化由 Bridge callback 触发,不在 SSP 内)
  - `abstract protected merge(delta): void`
  - `abstract protected render(): void`
  - `optional applyDelta?(delta: string, field?: string): void`
  - `toJSON(): { kind, version, id, payload, meta }`
- **测试** `src/test/ssp/types.test.ts`:
  - toJSON() 形状匹配 SerializableStreamPart interface
  - update() 触发 merge + render(用 TestSSP 子类 + mock stream)
  - attach() 触发初始 render
- **验收**: `instanceof SerializableStreamPart` ✓;toJSON() 可赋值给 serializable interface ✓

> **无 SSPFactory 任务** —— Bridge 直接 `new` 具体 SSP(在 processEvent switch/case 中分发)。恢复路径用主干 `projectStreamPartToAcpEvent → processEvent`,不需要 fromJSON。

### Wave 2: SSP 实现(顺序实施,每完成一个立即测试)

> 顺序:先简单的(Text/Reasoning),再核心的(Tool/Edit),再辅助的(Subagent/Lifecycle/Interaction/Raw)

#### T2: AssistantTextSSP
- `src/ssp/impl/assistant-text.ts`
- `merge(delta)`: `Object.assign(payload, delta)`
- `applyDelta(delta)`: `payload.text += delta` → `ctx.stream.markdown(delta)`(token 流)
- `render()`: `ctx.stream.markdown(payload.text)`(恢复时完整渲染)
- **测试**: applyDelta 累积 + markdown 调用 + 序列化兼容

#### T3: ReasoningSSP
- `src/ssp/impl/reasoning.ts`
- 同 Text 模式,但 `render()` 调 `ctx.stream.thinkingProgress(text)`(检查 capabilities.hasThinkingProgress,降级 markdown)
- **测试**: thinkingProgress 调用 + capabilities 降级

#### T4: ToolInvocationSSP ⭐ 核心(最大风险)
- `src/ssp/impl/tool-invocation.ts`
- **内化函数**(从主干 opencode-bridge.ts 移植,带行号引用):
  - `formatInvocationMsg(toolName, input, title)` (L1479-L1553)
  - `formatPastTenseMsg(toolName, title, start, end, input)` (L1555-L1644)
  - `buildToolSpecificData(toolName, input, output)` (L1352-L1473)
  - `isTransientFileTool(toolName)` (L2136-L2143)
- **状态**:
  - `progressivePushed: Set<string>`(幂等控制,契约 C3)
  - 首次 render → push(isComplete=false) + add;后续 → updateToolInvocation;completed → push(isComplete=true)
- **render() 状态机**(严格按契约 C1-C5):
  ```
  pending:  ctx.stream.beginToolInvocation(callId, toolName) [或 progress 降级]
  running:  
    首次: push(ChatToolInvocationPart{isComplete:false, invocationMessage, presentation, enablePartialUpdate:true})
           + progressivePushed.add(callId)
    后续: ctx.stream.updateToolInvocation(callId, {invocationMessage})
  completed/error:
    push(ChatToolInvocationPart{
      isComplete: true,
      ★ if toolName === 'read': invocationMessage(现在时), 不设 pastTenseMessage  [契约 C1]
      ★ else: pastTenseMessage(过去时)  [契约 C1]
      toolSpecificData: buildToolSpecificData(...),
      presentation: isTransientFileTool ? 'hiddenAfterComplete' : undefined,
      isError: status === 'error'
    })
  ```
- **fallback 路径**(无 ChatToolInvocationPart):
  - read completed → 直接 return(契约 C1 fallback)
  - 其他 completed → updateToolInvocation(pastTenseMessage + invocationMessage)
- **测试** `src/test/ssp/tool-invocation.test.ts`(⭐ 防止 v2 缺陷 #1/#2):
  - **read 完成不设 pastTenseMessage**(契约 C1):断言 pushed part 无 pastTenseMessage 字段
  - **bash 完成设 pastTenseMessage**:断言 pastTenseMessage 含 "(Xs)"
  - **bash toolSpecificData 是 ChatTerminalToolInvocationData**(契约 C4):instanceof 断言
  - **read toolSpecificData 是 undefined**(契约 C4)
  - **progressive 幂等**(契约 C3):两次 running 只 push 一次,第二次是 update
  - **presentation: read/write/edit = hiddenAfterComplete**(契约 C5)
  - **fallback 路径**:无 ChatToolInvocationPart 时 read 完成不调任何 stream 方法
  - **subagent 工具**:toolName='task' 时 toolSpecificData 是 ChatSubagentToolInvocationData
  - **error 状态**:isError=true,pastTenseMessage 设置

#### T5: ExternalEditSSP(内部驱动 tracker)
- `src/ssp/impl/external-edit.ts`
- **设计**(类似 vscode externalEditStream 模式):
  - 持有 `tracker: ExternalEditTracker` 引用(构造器注入)
  - `beginEdit(toolCallId, filePath, stream)`:调用 `tracker.trackEdit(toolCallId, [fileUri], stream)` → tracker 捕获 before 快照 + 创建 ExternalEditPart(start=true)
  - `completeEdit(toolCallId)`:调用 `tracker.completeEdit(toolCallId)` → tracker 解决 deferred + 捕获 after 快照 + 返回 undoStopId
  - 记录 edit 生命周期状态到 payload(用于序列化/恢复)
- **Bridge 协作**:
  - Bridge 持有 `externalEditCallIds: Set<string>`(抑制卡片)
  - `permission.asked(edit)` → 创建 ExternalEditSSP + 调 beginEdit + auto-reply + `externalEditCallIds.add(callId)`
  - `tool:completed` 且 `externalEditCallIds.has(callId)` → 调 completeEdit + 从 Set 删除
- **测试** `src/test/ssp/external-edit.test.ts`:
  - beginEdit 调用 tracker.trackEdit(mock tracker)
  - completeEdit 调用 tracker.completeEdit
  - 序列化记录 toolCallId/editId/uri
  - 恢复时不重复调 tracker(已持久化)

#### T6: SubagentSSP
- `src/ssp/impl/subagent.ts`
- 追踪子代理会话:`startSubagent(sessionId, scope)` / `updateProgress` / `completeSubagent`
- `hasBusyDescendant()`:未完成子代理检测(deferred idle 用)
- `subAgentInvocationId` 生成 + 传播给子 ToolInvocationSSP
- `render()`:push ChatToolInvocationPart(subagent 卡片)+ formatSubagentProgress(从 participant/subagent.ts 复用)
- **测试**: 多子代理并行 + busy 检测 + subAgentInvocationId 传播

#### T7: SessionLifecycleSSP + SessionDiffSSP
- `src/ssp/impl/session-lifecycle.ts` + `session-diff.ts`
- SessionLifecycle:记录 session.created/idle/error 等,render 为 progress 消息
- SessionDiff:累积 diffs,render 为 no-op(仅持久化)
- **测试**: 状态记录 + diff 累积

#### T8: InteractionSSP
- `src/ssp/impl/interaction.ts`
- InteractionRequestSSP:permission.asked/question.asked 记录
- InteractionResponseSSP:replied/rejected 记录
- render():轻量(progress 或 no-op)
- **测试**: 持久化 + 恢复

#### T9: RawAcpEventSSP
- `src/ssp/impl/raw-acp-event.ts`
- 兜底所有未识别事件,无损存储
- render(): no-op
- **测试**: 任意 event 可序列化和恢复

### Wave 3: Bridge 重写(依赖 Wave 1+2)

#### T10: Bridge 瘦路由
- **重写** `src/backends/opencode/opencode-bridge.ts`(2201 → ~400 行)
- **保留逻辑**:
  - `ssps: Map<string, SerializableStreamPart>` SSP 注册表
  - `processEvent(event)` switch/case 路由
  - `permission.asked(edit)` → `tracker.trackEdit()` + `externalEditCallIds.add()` + `hideProgressiveExternalEditTool()` + auto-reply(契约 C2)
  - `tool completed` → `tracker.completeEdit()` + 条件渲染
  - `isExternalEditToolCall(toolName, callId)` 检测(契约 C2)
  - `deferred idle`(子代理忙检测,120s 超时)
  - `activeSubagentScopes` + `subAgentInvocationId` 生成
  - `getUserMessageId()` / `getSessionTitle()` / `getHadSubagentTasks()` 从 SSP Map 查询
  - 续写循环兼容(每轮新建 Bridge 实例)
- **移除逻辑**(迁到 SSP):
  - 所有 `stream.markdown/thinkingProgress/beginToolInvocation` 直接调用
  - `partKinds` / `toolMetas` / `progressivePushed`(移到 SSP 内部)
  - `formatInvocationMsg` / `formatPastTenseMsg` / `buildToolSpecificData`(移到 ToolInvocationSSP)
- **新增**:
  - `attach(stream, tracker?)`:接收 stream 和可选 tracker(用于 ExternalEditSSP);vscode 类型由 SSP 自己 import
  - `getOrCreateSSP(part)`:从 Map 取或按 part.type 直接 `new` + attach(stream)
- **测试** `src/test/opencode-bridge.test.ts`(独立文件,⭐ 不嵌入 streaming.test.ts):
  - 事件路由:part.updated → ToolInvocationSSP 创建 + update
  - edit asked 流程(契约 C2):permission.asked → tracker.trackEdit + externalEditCallIds.add + 后续工具事件跳过
  - deferred idle:子代理活跃时 session.idle 不停止
  - Bridge 无直接 stream.markdown/thinkingProgress 调用(除错误降级)

#### T11: Handler 适配
- **修改** `src/participant/handler.ts`(L848-853 区域)
- 旧:
  ```typescript
  bridge.setStream(stream);
  bridge.setCallbacks(sessionStream);
  bridge.setTracker(tracker);
  ```
- 新:
  ```typescript
  // SSP 直接 import vscode 类型,只需注入 stream + tracker
  bridge.attach(stream, tracker);
  bridge.setCallbacks(sessionStream);
  ```
- **保留**:续写循环、tracker dispose、sessionStream flush、标题生成
- **测试**:更新 handler.test.ts 相关用例

### Wave 4: 测试强化(依赖 Wave 3)

#### T12: 行为契约专项测试(防回归)
- **创建** `src/test/ssp/behavior-contracts.test.ts`
- **契约 C1 专项**:read 完成 pastTenseMessage 必须为 undefined;bash 完成 pastTenseMessage 必须含时间
- **契约 C2 专项**:edit asked 后,该 callId 的 ToolInvocationSSP 永不 render;未 asked 的 edit 正常 render
- **契约 C3 专项**:progressivePushed 幂等 — 3 次 running 事件只 push 1 次 + update 2 次
- **契约 C4 专项**:7 种工具的 toolSpecificData instanceof 断言
- **契约 C5 专项**:presentation 断言

#### T13: 端到端链路测试
- 更新 `src/test/streaming/e2e-backend-serialize.test.ts`
- 完整链路:AcpEvent 序列 → Bridge.processEvent → SSP 渲染 → CollectorStream 捕获 → buildTurn() → 验证 ChatResponseTurn parts
- **关键场景**:read 工具完整 turn、edit asked 完整 turn、子代理嵌套 turn、多轮续写

#### T14: 更新现有测试
- `src/test/streaming.test.ts`:适配新 Bridge API(attach),保留所有现有断言
- `src/test/streaming/handler-restore-integration.test.ts`:适配 SSP replay
- `src/test/streaming/event-replay-integration.test.ts`:适配

### Wave 5: 清理与验证

#### T15: 类型检查 + 全量测试
- `npx tsc --noEmit` 零错误
- `npm test` 所有测试通过(含更新的现有测试)
- 无 vi.mocked/vi.waitFor 兼容性问题(主干已验证可用)

#### T16: 手动 QA 场景
- read 工具:卡片显示 "Read [file]",完成后折叠,不显示时间戳
- edit 工具(正常):卡片显示 "Editing [file]",完成后 "Edited [file] (Xs)",折叠
- edit 工具(asked 流程):permission 弹出 → auto-approve → 无工具卡片(被抑制)→ ExternalEditPart 创建 undo stop
- bash 工具:终端样式卡片,显示命令 + exitCode + 耗时
- 子代理:可展开卡片,显示子工具摘要
- 文本流:token-by-token 实时显示
- 推理流:thinkingProgress 实时显示(有 proposed API 时)
- 多轮续写:子代理完成后自动发送空 prompt 继续

---

## 验收标准(Definition of Done)

### 功能验收(零行为回归)
- [ ] **契约 C1**: read complete 的 pushed part `pastTenseMessage === undefined`(测试 T12)
- [ ] **契约 C2**: edit asked 后该 callId 无任何 ToolInvocationSSP render(测试 T12)
- [ ] **契约 C3**: progressive 幂等 — 多次 running 只 push 1 次(测试 T12)
- [ ] **契约 C4**: 7 种工具 toolSpecificData instanceof 正确(测试 T12)
- [ ] **契约 C5**: presentation 正确(测试 T12)
- [ ] **契约 C6**: 初始化序列 + 续写循环正确(测试 T10)

### 工程验收
- [ ] `npx tsc --noEmit` 零错误
- [ ] `npm test` 全部通过(含现有 307 测试更新后)
- [ ] 每个 concrete SSP 有独立单元测试(instanceof 断言)
- [ ] Bridge 无直接 `stream.markdown/thinkingProgress/beginToolInvocation`(除错误降级)
- [ ] 无死代码(所有 SSP 方法被测试覆盖;Bridge switch/case 直接 new 具体 SSP)

### 规避 v2 缺陷验收
- [ ] **无缺陷 #1**: SSP 直接 import vscode,`vscode.ChatToolInvocationPart` 非 undefined(测试断言)
- [ ] **无缺陷 #2**: ToolInvocationSSP.render 传完整数据(toolName/input/output/timing)
- [ ] **无缺陷 #3**: 单一持久化路径(grep 无 SSP 内部 serializer.append)
- [ ] **无缺陷 #4**: 子代理卡片含 formatSubagentProgress 输出(非 JSON dump)
- [ ] **无缺陷 #5**: isExternalEditToolCall 存在且被调用(测试)
- [ ] **无缺陷 #6**: 无独立 tool-data.ts(逻辑在 ToolInvocationSSP 内)
- [ ] **无缺陷 #7**: 无 SSPFactory(Bridge switch/case 直接 new 具体 SSP,grep 无 factory 引用)

---

## 风险与缓解

| 风险 | 概率 | 缓解 |
|------|------|------|
| 工具渲染逻辑移植遗漏细节 | 中 | T12 行为契约专项测试 + 主干代码行号引用 |
| ExternalEditTracker 协作破坏 | 中 | 保留 tracker;ExternalEditSSP 内部驱动;T10 保留 tracker 创建/注入点 |
| 续写循环 Bridge 实例化问题 | 低 | T10 明确保留每轮新建 Bridge;T13 多轮测试 |
| vscode 类型运行时不可用 | 低 | SSP 直接 import,vitest alias mock 测试;capabilities 降级路径保留 |
| 测试假阳性(Oracle 审计漏判) | 高 | T12 深入断言 part 属性,不只看调用次数 |
| 上下文窗口压力 | 中 | 实施阶段不开子代理;按 Wave 顺序小步提交 |

---

## 不变性(Guardrails)

### Must NOT
- 不变更 JSONL v2 格式(`{"v":2,"t":"<type>","d":<data>}`)
- 不删除 `src/acp/serializable/types.ts`(序列化合约)
- 不删除 `src/participant/external-edit-tracker.ts`(保留 tracker,被 ExternalEditSSP 驱动)
- 不删除 `src/acp/streaming/session-stream.ts`(唯一持久化路径)
- 不引入 Projector 接口或任何中间渲染抽象
- 不创建 `src/acp/serializer/` 或 `src/ssp/serializer/` 目录(无 SSP 内部 serializer)
- 不把 SSP 放在 `src/acp/` 下(SSP 独立于 ACP)

### Must Have
- SSP 模块在 `src/ssp/`(独立于 ACP)
- SSP 直接 import vscode 类型(规避 v2 缺陷 #1)
- ExternalEditSSP 内部驱动 tracker(类似 vscode externalEditStream 模式)
- ToolInvocationSSP 内化 formatInvocationMsg/formatPastTenseMsg/buildToolSpecificData
- 无 SSPFactory(Bridge 直接 new 具体 SSP,switch/case 分发)
- 单一持久化路径(SerializableSessionStream callback)
- 行为契约专项测试(T12)
