# SSP Architecture v2 — 设计文档

## TL;DR

将当前架构从"Bridge 双通道（渲染 + callback 持久化）"重构为"SSP-first 固定单向管线"。SSP 从纯数据接口升级为带行为的运行时实体，Bridge 从 800 行状态机退化为 50 行路由。Edit 同步生命周期下沉到 Backend/Bridge 内部闭环。

---

## 1. 当前架构问题

### 1.1 脆弱性：callback 驱动的持久化

```
当前管线:
AcpEvent → Bridge.run() ──┬──► stream.markdown/thinkingProgress/... (VSCode 渲染)
                           └──► callbacks.onEvent(event)  ──► SSP JSONL 持久化
```

**问题**：`callbacks.onEvent()` 是 Bridge 内部的**手动调用**。如果 backend 实现者忘记调、调错顺序、或调得不够频繁，SSP 持久化静默断裂。Bridge 承担了双重职责（渲染 + 触发持久化），这不是它应该知道的。

### 1.2 状态机膨胀

`OpenCodeBridge`（`src/backends/opencode/opencode-bridge.ts`）包含 ~800 行跨事件关联状态：

| 状态 | 用途 |
|------|------|
| `partKinds: Map<partId, type>` | 跨 part.updated/part.delta 关联 |
| `toolMetas: Map<callId, ToolMeta>` | 工具 pending→running→completed 累积 |
| `progressivePushed: Set<callId>` | 幂等性控制 |
| `activeSubagentScopes: Map<sessionId, Scope>` | 子代理层级过滤 |
| `externalEditCallIds: Set<callId>` | 外部编辑追踪 |
| `deferredIdle` + 超时计时器 | 子代理延迟 idle |
| `hadSubagentTasks` / `sessionTitle` / `userMessageId` | 跨事件结果提取 |

这些状态属于**SSP 本身的生命周期**，不是 Bridge 的职责。Bridge 不应该关心"这个 tool call 是不是第一次 push"，那是 Tool SSP 自己的事。

### 1.3 Edit 同步碎片化

当前 edit 同步散落在四个地方：

| 位置 | 职责 |
|------|------|
| `extension.ts` / `server.ts` | 写 `opencode.json` 设置 `permission.edit="ask"` |
| `handler.ts` (L830-858) | 创建 `ExternalEditTracker`，注入 Bridge |
| `opencode-bridge.ts` | 处理 `permission.asked` 事件 + external edit lifecycle |
| `external-edit-tracker.ts` | 捕获文件快照 → SSP `onSnapshot()` |

这导致 edit 同步逻辑**无法复用** — 换一个 backend 需要重写全部。

### 1.4 Projector 存在于文档中，不存在于代码中

`docs/serializable-stream-part-architecture.md` 描述了 Projector 模式：

```
SerializableSession → SerializableTurnRecord → SerializableStreamPart
                                                                  │
                                            ┌─────────────────────┼──────────────┐
                                            ▼                     ▼              ▼
                                       Live Projector       Restore Projector  Debug Projector
```

但代码中没有实现。当前渲染逻辑硬编码在 Bridge 中，无法在不同 surface 间复用。

---

## 2. 设计目标

1. **固定单向管线**：`RawEvent → AcpEvent → SSP → VSCSP`（VSCode Streaming Part），无回调、无副通道
2. **SSP 即运行时实体**：SSP 从纯 `interface` 升级为带行为的 `class`，自己管理状态累积、投影和持久化
3. **Projector 实现化**：把文档中的 Projector 模式落地为代码，Bridge 不再做渲染
4. **Edit 同步闭环**：permission 初始化 + edit 同步全部由 Backend/Bridge 自管理，在 SSP Edit Part 中完成

---

## 3. 目标架构

### 3.1 事件管线

```
SDK SSE 原始事件 (OpenCodeStreamEvent)
    │
    ▼ normalizeStreamEvent()              [events.ts]
AcpEvent
    │
    ▼ Bridge.processEvent(event)           [opencode-bridge.ts — 瘦身后]
SSP (已存在或新建, 从 Map 中取出)
    │
    ├── ssp.update(delta)                 [SSP 自身行为]
    │   ├── merge(delta)                  [状态累积]
    │   ├── persist()                     [JSONL append]
    │   └── project(projector)            [VSCode 投影]
    │       ├── stream.markdown()
    │       ├── stream.beginToolInvocation()
    │       └── ...
    │
    ▼
JSONL (.acpilot/{sessionId}/turns.jsonl)   — 持久化
+ VSCode ChatResponseStream                — 实时渲染
```

**关键变化**：
- 持久化由 SSP 自己触发（`merge` → `persist`），不再依赖 Bridge 的 callback
- VSCode 渲染由 SSP 通过 Projector 触发，不再在 Bridge 中硬编码
- Bridge 职责缩减为：接收 AcpEvent → 路由到对应 SSP → 调用 `update()`

### 3.2 Bridge 瘦身

```
当前 Bridge (~800行):          瘦身后 Bridge (~50行):
┌──────────────────────┐       ┌──────────────────────────┐
│ 渲染逻辑 (markdown,   │       │ SSP Map<String, SSP>     │
│   thinkingProgress,   │       │                          │
│   beginToolInvocation,│  →    │ processEvent(event) {    │
│   toolSpecificData)   │       │   ssp = map.get(id)     │
│                       │       │     ?? factory.create()  │
│ Callback 触发         │       │   ssp.update(delta)      │
│                       │       │ }                        │
│ 状态机 (partKinds,    │       │                          │
│   toolMetas,          │       │ permission.asked →       │
│   progressivePushed)  │       │   auto-approve           │
│                       │       │   create EditSSP         │
│ 子代理过滤            │       └──────────────────────────┘
│                       │
│ ExternalEdit 追踪     │
│                       │
│ 结果提取 (userMsgId,  │
│   sessionTitle)       │
└──────────────────────┘
```

Bridge 只保留：
- SSP Map（按 partId 索引）
- `processEvent()` — 事件路由（switch/case）
- `permission.asked` → auto-approve + 创建 EditSSP
- 结果提取代理（`getUserMessageId()` / `getSessionTitle()` — 从 SSP Map 中查询）

---

## 4. 详细设计

### 4.1 SSP 基类

SSP 从纯 `interface` 升级为 `abstract class`。字段不变，JSONL 兼容。

```typescript
abstract class SerializableStreamPart<
  TKind extends SerializableStreamPartKind = SerializableStreamPartKind,
  TPayload = unknown,
> {
  // ── 原有字段（与当前 interface 完全一致）──
  abstract readonly kind: TKind;
  readonly version: number = 1;
  readonly id: string;
  payload: TPayload;
  meta: SerializableStreamPartMeta;

  // ── 运行时依赖（不参与序列化）──
  protected projector?: Projector;
  protected serializer?: SessionSerializer;

  // ── 构造 ──
  constructor(initialPayload: TPayload, meta: Partial<SerializableStreamPartMeta> = {}) {
    this.id = crypto.randomUUID();
    this.payload = initialPayload;
    this.meta = {
      turnIndex: 0,
      requestId: '',
      sequence: 0,
      createdAt: new Date().toISOString(),
      source: 'acp-event',
      ...meta,
    };
  }

  // ── 生命周期 ──

  /** 挂载到 Projector 和 Serializer（由 Bridge 在创建/路由时调用） */
  attach(projector: Projector, serializer: SessionSerializer): void {
    this.projector = projector;
    this.serializer = serializer;
    this.render(projector);  // 初始渲染
  }

  /** 增量更新：合并状态 → 持久化 → 投影 */
  update(delta: Partial<TPayload>): void {
    this.merge(delta);
    this.meta.sequence++;  // 单调递增
    this.serializer?.append(this);
    if (this.projector) {
      this.render(this.projector);
    }
  }

  // ── 子类必须实现 ──

  /** 将 delta 合并到 this.payload 中 */
  protected abstract merge(delta: Partial<TPayload>): void;

  /** 将当前 this.payload 投影到 VSCode ChatResponseStream */
  protected abstract render(projector: Projector): void;

  // ── 可选：文本增量（token-by-token）──
  applyDelta?(delta: string, field?: string): void;

  // ── 序列化兼容 ──
  toJSON(): { kind: TKind; version: number; id: string; payload: TPayload; meta: SerializableStreamPartMeta } {
    return { kind: this.kind, version: this.version, id: this.id, payload: this.payload, meta: this.meta };
  }
}
```

**为什么 `class` 而不是 `interface`？**

当前 `interface SerializableStreamPart` 是纯数据合约，没有任何行为。结果所有状态管理都在 Bridge 里做，持久化靠 callback。升级为 `class` 后：
- SSP 自己知道如何 merge delta
- SSP 自己触发持久化（不依赖 Bridge 的 callback）
- SSP 自己驱动渲染（通过 Projector）
- JSONL 格式完全不变（`toJSON()` 产出同样的结构）

### 4.2 具体 SSP 类型

#### ToolInvocationSSP

处理工具调用从 `pending → running → completed → error` 的完整生命周期。

```typescript
class ToolInvocationSSP extends SerializableStreamPart<'toolInvocation', ToolInvocationStreamPartPayload> {
  readonly kind = 'toolInvocation';

  protected merge(delta: Partial<ToolInvocationStreamPartPayload>): void {
    // 状态累积：新状态覆盖旧状态
    this.payload = { ...this.payload, ...delta };
  }

  protected render(p: Projector): void {
    const { callId, toolName, state } = this.payload;
    const status = state.status;
    const isFirstRender = this.payload.callId && !this._renderedCallIds.has(this.payload.callId);

    switch (status) {
      case 'pending':
      case 'running':
        if (isFirstRender) {
          p.beginToolInvocation(callId!, toolName, { status, input: state.input });
          this._renderedCallIds.add(callId!);
        } else {
          p.updateToolInvocation(callId!, { status, input: state.input });
        }
        break;
      case 'completed':
        p.completeToolInvocation(callId!, { output: state.output, endTime: state.endTime });
        break;
      case 'error':
        p.errorToolInvocation(callId!, state.error ?? 'Unknown error');
        break;
    }
  }
}
```

#### AssistantTextSSP

处理 AI 文本输出，支持 `update`（完整替换）和 `applyDelta`（增量追加）。

```typescript
class AssistantTextSSP extends SerializableStreamPart<'assistantText', AssistantTextStreamPartPayload> {
  readonly kind = 'assistantText';

  protected merge(delta: Partial<AssistantTextStreamPartPayload>): void {
    Object.assign(this.payload, delta);
  }

  applyDelta(delta: string, _field?: string): void {
    this.payload.text += delta;
    this.projector?.markdown(delta);  // token-by-token
    this.meta.sequence++;
    this.serializer?.append(this);
  }

  protected render(p: Projector): void {
    // 恢复时：渲染完整文本
    p.markdown(this.payload.text);
  }
}
```

#### ReasoningSSP

类似 AssistantTextSSP，处理 `thinkingProgress()` 投影。

```typescript
class ReasoningSSP extends SerializableStreamPart<'reasoning', ReasoningStreamPartPayload> {
  readonly kind = 'reasoning';

  protected merge(delta: Partial<ReasoningStreamPartPayload>): void {
    Object.assign(this.payload, delta);
  }

  applyDelta(delta: string, _field?: string): void {
    this.payload.text += delta;
    this.projector?.thinkingProgress(delta);
    this.meta.sequence++;
    this.serializer?.append(this);
  }

  protected render(p: Projector): void {
    p.thinkingProgress(this.payload.text);
  }
}
```

#### ExternalEditSSP（核心：edit 同步）

封装完整的 edit 生命周期：permission → pre-edit snapshot → edit → post-edit undoStop。

```typescript
class ExternalEditSSP extends SerializableStreamPart<'externalEdit', ExternalEditStreamPartPayload> {
  readonly kind = 'externalEdit';
  private phase: 'init' | 'pre-edit' | 'post-edit' = 'init';

  /** permission.asked 到达时调用 */
  beginEdit(toolCallId: string, filePath: string): void {
    this.phase = 'pre-edit';
    this.update({ toolCallId, editId: undefined } as any);

    // 在文件被修改前推送 ExternalEditPart(start=true)
    this.projector?.beginExternalEdit(toolCallId);
  }

  /** file.edited 到达时调用 */
  completeEdit(editId: string, filePath: string): void {
    this.phase = 'post-edit';
    this.update({ editId, uri: filePath } as any);

    // 在文件修改后推送 ExternalEditPart(start=false) → 创建 undo stop
    this.projector?.endExternalEdit(this.payload.toolCallId!, editId);
  }

  protected merge(delta: Partial<ExternalEditStreamPartPayload>): void {
    Object.assign(this.payload, delta);
  }

  protected render(p: Projector): void {
    // EditSSP 不通过 render 控制生命周期
    // 生命周期由 beginEdit/completeEdit 显式管理
  }
}
```

#### SessionLifecycleSSP / SessionDiffSSP / InteractionRequestSSP / InteractionResponseSSP

处理会话生命周期、文件 diff、权限/问题交互。这些是相对简单的状态记录，不需要复杂的增量投影。

#### UserPromptSSP / AssistantTextDeltaSSP / ReasoningDeltaSSP

文本增量专用 SSP，Delta 类负责 token-by-token 累积。

#### RawAcpEventSSP（无损兜底）

未识别的事件类型全部走此兜底，确保不丢失任何数据。

### 4.3 Projector 接口

```typescript
interface Projector {
  // 文本
  markdown(content: string): void;

  // 推理
  thinkingProgress(content: string): void;

  // 工具
  beginToolInvocation(callId: string, toolName: string, data: ToolStreamData): void;
  updateToolInvocation(callId: string, data: Partial<ToolStreamData>): void;
  completeToolInvocation(callId: string, result: ToolResultData): void;
  errorToolInvocation(callId: string, error: string): void;

  // 外部编辑
  beginExternalEdit(callId: string): void;
  endExternalEdit(callId: string, editId: string): void;

  // 会话/其他
  progress(message: string): void;
  reference(uri: Uri): void;

  // 会话结束
  finalize(): void;
}
```

**VSCSPProjector** — 唯一实现，内部处理 capabilities 降级：

```typescript
class VSCSPProjector implements Projector {
  constructor(
    private stream: vscode.ChatResponseStream,
    private caps: Capabilities,
  ) {}

  markdown(content: string): void {
    this.stream.markdown(content);
  }

  thinkingProgress(content: string): void {
    if (this.caps.hasThinkingProgress) {
      (this.stream as any).thinkingProgress?.({ text: content });
    } else {
      this.stream.markdown(`_${content}_`);
    }
  }

  beginToolInvocation(callId: string, toolName: string, data: ToolStreamData): void {
    if (this.caps.hasToolUI) {
      (this.stream as any).beginToolInvocation?.(callId, toolName, data);
    } else {
      this.stream.markdown(`**${toolName}**...`);
    }
  }
  // ...
}
```

**为什么 Projector 是接口而不是 SSP 内部硬编码？**

切换 Projector 实现即可切换渲染目标：
- `VSCSPProjector` → 实时 VSCode ChatResponseStream
- `CollectorProjector` → 恢复时捕获 parts 到数组
- `DebugProjector` → 测试断言

### 4.4 Bridge 瘦身后的样子

```typescript
class OpenCodeBridge implements AcpBridge {
  private ssps = new Map<string, SerializableStreamPart>();
  private projector: Projector;
  private serializer: SessionSerializer;
  private permissions: AcpPermissionOperations;

  // ── 事件路由 ──

  processEvent(event: AcpEvent): void {
    switch (event.type) {
      case 'part.updated': {
        const part = event.part;
        let ssp = this.ssps.get(part.id);
        if (!ssp) {
          ssp = SSPFactory.create(part);
          ssp.attach(this.projector, this.serializer);
          this.ssps.set(part.id, ssp);
        }
        ssp.update(part);
        break;
      }

      case 'part.delta': {
        const ssp = this.ssps.get(event.partId);
        ssp?.applyDelta?.(event.delta, event.field);
        break;
      }

      case 'permission.asked': {
        if (event.permission === 'edit' && event.tool) {
          // ── 核心：edit 同步闭环 ──
          const editSSP = new ExternalEditSSP({ toolCallId: event.tool.callId } as any);
          editSSP.attach(this.projector, this.serializer);
          editSSP.beginEdit(event.tool.callId, event.patterns?.[0] ?? '');
          this.ssps.set(`edit-${event.tool.callId}`, editSSP);

          // auto-approve：不阻塞用户
          this.permissions.reply(event.sessionId, event.permissionId, 'once');
        }
        break;
      }

      case 'file.edited': {
        // 查找对应 edit SSP 完成追踪
        const editSSP = this.findEditSSPByFile(event.file);
        editSSP?.completeEdit(event.file, /* editId from VS Code */ '');
        break;
      }

      case 'session.diff': {
        // 关联 session.diff 到对应 edit SSP
        for (const diff of event.diffs) {
          const editSSP = this.findEditSSPByFile(diff.file);
          editSSP?.update({ patch: diff.patch } as any);
        }
        break;
      }

      case 'session.idle':
        this.projector.finalize();
        break;

      // session.created/updated/deleted/error → SessionLifecycleSSP
      // question.asked/replied → InteractionSSP
      // ...
    }
  }

  // ── 结果提取（从 SSP Map 查询）──

  getUserMessageId(): string | null {
    for (const ssp of this.ssps.values()) {
      if (ssp instanceof AssistantTextSSP && ssp.payload.messageId) {
        return ssp.payload.messageId;
      }
    }
    return null;
  }
}
```

**关键点**：Bridge 不再做任何渲染决策（`stream.markdown` / `stream.thinkingProgress` 等），也不直接调持久化。这些都由 SSP 自己在 `update()` 内完成。

### 4.5 SSP Factory

```typescript
class SSPFactory {
  static create(part: AcpStreamPart): SerializableStreamPart {
    switch (part.type) {
      case 'tool':
        return new ToolInvocationSSP({
          partId: part.id,
          toolName: part.toolName,
          callId: part.callId,
          state: part.state,
          messageId: part.messageId,
          sessionId: part.sessionId,
        });
      case 'text':
        return new AssistantTextSSP({ partId: part.id, text: part.text, messageId: part.messageId });
      case 'reasoning':
        return new ReasoningSSP({ partId: part.id, text: part.text, messageId: part.messageId });
      case 'step-start':
      case 'step-finish':
        return new SessionLifecycleSSP({ eventType: `step-${part.type}` } as any);
      default:
        return new RawAcpEventSSP({ event: part } as any);
    }
  }

  /** 从 JSONL 反序列化恢复 */
  static fromJSON(record: { kind: SerializableStreamPartKind; version: number; id: string; payload: unknown; meta: SerializableStreamPartMeta }): SerializableStreamPart {
    switch (record.kind) {
      case 'toolInvocation':
        return new ToolInvocationSSP(record.payload as any, record.meta, record.id);
      case 'assistantText':
        return new AssistantTextSSP(record.payload as any, record.meta, record.id);
      case 'reasoning':
        return new ReasoningSSP(record.payload as any, record.meta, record.id);
      case 'externalEdit':
        return new ExternalEditSSP(record.payload as any, record.meta, record.id);
      // ...
      default:
        return new RawAcpEventSSP(record.payload as any, record.meta, record.id);
    }
  }
}
```

### 4.6 SessionSerializer

```typescript
interface SessionSerializer {
  append(ssp: SerializableStreamPart): void;
  flush(): Promise<void>;
}

// 实现：JSONL append
class JSONLSessionSerializer implements SessionSerializer {
  constructor(private filePath: string) {}

  append(ssp: SerializableStreamPart): void {
    const line = JSON.stringify({ v: 2, t: 'stream-part', d: ssp.toJSON() }) + '\n';
    this.writeQueue = this.writeQueue.then(() => fs.appendFile(this.filePath, line));
  }
}
```

**注意**：Serializer 只负责写。反序列化（恢复）在 `SSPFactory.fromJSON()` / `SerializableSessionReader` 中。

---

## 5. Edit 同步流程（完整闭环）

```
┌─ 初始化阶段 ────────────────────────────────────────────────────┐
│                                                                  │
│  Bridge.setup(): void {                                          │
│    // Backend 自管理 permission 初始化                            │
│    // 对 OpenCode：确保 opencode.json 有 permission.edit="ask"    │
│    // 未来可替换为 PermissionV2 agent-level ruleset               │
│    this.permissions.initializeEditSync(this.sessionId);          │
│  }                                                               │
└──────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─ 运行时：AI 触发 edit 工具 ──────────────────────────────────────┐
│                                                                  │
│  ① permission.asked (edit)                                       │
│     │  Bridge 收到                                               │
│     ├─► new ExternalEditSSP({ toolCallId: event.tool.callId })   │
│     ├─► editSSP.attach(projector, serializer)                    │
│     ├─► editSSP.beginEdit(toolCallId, filePath)                  │
│     │     └─► projector.beginExternalEdit(toolCallId)            │
│     │           └─► VSCode: push ExternalEditPart(start=true)    │
│     │                捕获文件基线快照                              │
│     │                                                            │
│     └─► permissions.reply(sessionId, permissionId, 'once')      │
│           └─► 服务端继续执行 edit → 写磁盘                        │
│                                                                  │
│  ② file.edited (编辑完成)                                        │
│     │  Bridge 收到                                               │
│     ├─► editSSP = findEditSSPByFile(event.file)                 │
│     └─► editSSP.completeEdit(event.file, /*editId*/)            │
│           └─► projector.endExternalEdit(toolCallId, editId)     │
│                 └─► VSCode: push ExternalEditPart(start=false)   │
│                      创建 undo stop                              │
│                                                                  │
│  ③ session.diff (diff 详情)                                      │
│     │  Bridge 收到                                               │
│     └─► editSSP.update({ patch: diff.patch })                   │
│           └─► SSP 持久化完整的 diff 细节                          │
└──────────────────────────────────────────────────────────────────┘
```

**为什么这样做？**

- Edit 同步完全不依赖 `extension.ts` / `handler.ts` 的外部逻辑
- 换一个 Backend 只需要实现 `initializeEditSync()` 和对接 `permission.asked` 事件
- 恢复时，从 JSONL 读取 ExternalEditSSP 记录即可重建 undo stop
- 不需要 `external-edit-tracker.ts`（其功能内化到 ExternalEditSSP）

---

## 6. 持久化设计

### 6.1 写入格式（不变）

```
{v: 2, t: "stream-part", d: {
  kind: "toolInvocation",
  version: 1,
  id: "ssp-uuid-123",
  payload: { partId, toolName, callId, state: { status, input, output } },
  meta: { turnIndex, sequence, createdAt, source, sourcePartId }
}}
```

同一个 SSP（相同 `id`）的多次 `update()` 会产生产生**多条 JSONL 记录**（sequence 递增），形成完整审计轨迹。

### 6.2 恢复流程

```
JSONL 文件 (.acpilot/{sessionId}/turns.jsonl)
    │
    ▼ SessionSerializer 读取所有行
SSP[] (所有历史记录)
    │
    ▼ 按 id 分组，取 sequence 最大的（最终状态）
SSP[] (最终状态)
    │
    ├──► 挂载 CollectorProjector
    ├──► ssp.attach(collectorProjector, nullSerializer)
    ├──► ssp.render(collectorProjector) → 捕获 VSCode chat parts
    │
    ▼
ChatRequestTurn[] / ChatResponseTurn[]
```

恢复时不需要 Bridge，不需要 ACP event 流。纯粹从 JSONL → SSP → CollectorProjector。

---

## 7. 文件变更范围

### 7.1 新增文件

| 文件 | 职责 |
|------|------|
| `src/acp/ssp/types.ts` | SSP 基类定义 |
| `src/acp/ssp/impl/tool-invocation.ts` | ToolInvocationSSP |
| `src/acp/ssp/impl/assistant-text.ts` | AssistantTextSSP |
| `src/acp/ssp/impl/reasoning.ts` | ReasoningSSP |
| `src/acp/ssp/impl/external-edit.ts` | ExternalEditSSP |
| `src/acp/ssp/impl/session-lifecycle.ts` | SessionLifecycleSSP |
| `src/acp/ssp/impl/session-diff.ts` | SessionDiffSSP |
| `src/acp/ssp/impl/interaction.ts` | InteractionRequestSSP / InteractionResponseSSP |
| `src/acp/ssp/impl/raw-acp-event.ts` | RawAcpEventSSP (兜底) |
| `src/acp/ssp/factory.ts` | SSPFactory.create() + fromJSON() |
| `src/acp/projector/types.ts` | Projector 接口 |
| `src/acp/projector/vscsp.ts` | VSCSPProjector（实时渲染） |
| `src/acp/projector/collector.ts` | CollectorProjector（恢复用） |
| `src/acp/serializer/session-serializer.ts` | SessionSerializer 接口 + JSONL 实现 |

### 7.2 修改文件

| 文件 | 变更 |
|------|------|
| `src/acp/backend.ts` | AcpBridge 接口瘦身；新增 `initializeEditSync()` 到 permission 子接口 |
| `src/acp/serializable/*` | 保留现有 types（作为序列化合约），新增 SSP 运行时引用 |
| `src/backends/opencode/opencode-bridge.ts` | 完全重写为纯路由（~50 行） |
| `src/backends/opencode/adapter.ts` | 对接新的 Bridge + SSP 管线 |
| `src/participant/handler.ts` | 移除 ExternalEditTracker、SessionStream 相关代码 |
| `src/participant/external-edit-tracker.ts` | 删除（功能内化到 ExternalEditSSP） |
| `src/extension.ts` | 移除 opencode.json 写入逻辑（下沉到 Bridge） |
| `src/backends/opencode/server.ts` | 移除 ensureOpencodeConfig() 调用（下沉到 Bridge） |

### 7.3 兼容保留

| 文件 | 说明 |
|------|------|
| `src/acp/serializable/types.ts` | 保留为序列化合约（JSONL 格式定义） |
| `src/acp/serializable/serializer.ts` | 保留 JSONL I/O 工具函数 |
| `src/acp/serializable/stream-parts.ts` | 保留 SerializableStreamPartEventHandler（从 JSONL 恢复用） |
| `src/acp/streaming/session-stream.ts` | 替换为 SSP + SessionSerializer，旧文件可移除或标记 deprecated |
| `src/acp/streaming/collector-stream.ts` | 保留，作为 CollectorProjector 的底层 |

---

## 8. 设计决策记录

### 8.1 为什么 SSP 改为 class 而不是 interface？

**决策**：SSP 从 `interface` 升级为 `abstract class`。

**理由**：
- 当前 `interface` 导致所有行为（merge、persist、render）必须在外部实现（Bridge、callback），造成逻辑碎片化
- `class` 让 SSP 自包含：它知道如何累积状态、如何投影、何时持久化
- 序列化兼容：`toJSON()` 产出与当前 JSONL 格式完全相同的结构
- 反序列化：`SSPFactory.fromJSON()` 重建带行为的 SSP 实例

### 8.2 为什么 Projector 是接口？

**决策**：Projector 定义为接口，由 VSCSPProjector 实现。

**理由**：
- 切换 Projector 实现即可切换渲染目标（实时 VSCode / 恢复 Collector / 测试 Debug）
- capabilities 降级（proposed API 检测）封装在 VSCSPProjector 内部
- SSP 不感知 VSCode API 细节

### 8.3 为什么 Edit 同步下沉到 Bridge？

**决策**：permission 初始化和 edit 同步全部由 Bridge 内部闭环。

**理由**：
- 当前散落在 `extension.ts`、`handler.ts`、`external-edit-tracker.ts`、`opencode-bridge.ts` 四处
- 换一个 Backend 需要改 4 个文件
- 下沉后：Backend 实现 `initializeEditSync()` + 对接 `permission.asked` 事件即可
- ExternalEditSSP 封装完整的 edit 生命周期，恢复时从 JSONL 重建

### 8.4 为什么保留 SerializableStreamPart 类型（serializable/types.ts）？

**决策**：保留现有 `interface SerializableStreamPart` 作为序列化合约，不删除。

**理由**：
- JSONL 格式是持久化契约，不应随意变更
- 新的 `class SerializableStreamPart` 的 `toJSON()` 产出与此合约完全一致
- `SSPFactory.fromJSON()` 读取此合约重建运行时实例
- 两者共存不冲突：interface 定义序列化形状，class 提供运行时行为

### 8.5 为什么不保留 ExternalEditTracker？

**决策**：删除 `src/participant/external-edit-tracker.ts`。

**理由**：
- ExternalEditSSP 已经完全包含其功能（pre-edit snapshot → edit → post-edit undoStop）
- ExternalEditTracker 与 VS Code API（`ChatResponseExternalEditPart`）耦合，不适合放在 ACP 层
- 内化到 ExternalEditSSP 后，通过 Projector 抽象 VS Code API 依赖

---

## 9. 风险与缓解

| 风险 | 缓解 |
|------|------|
| OpenCodeBridge 渲染逻辑迁移到 SSP 时遗漏细节 | 分阶段迁移：先迁简单 SSP（Text/Reasoning），再迁 Tool/Edit |
| capabilities 降级逻辑需要在 Projector 中重建 | VSCSPProjector 从现有 `capabilities.ts` 复用检测逻辑 |
| 恢复流程需要从 JSONL 重建 SSP 实例 | SSPFactory.fromJSON() 按 kind 分发，不丢失任何记录 |
| JSONL 格式变更导致历史数据不可读 | 保持 v2 格式不变，`toJSON()` 产出完全一致的 shape |
