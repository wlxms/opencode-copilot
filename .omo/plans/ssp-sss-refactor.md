# SSP/SSS/Bridge 架构重构方案（最终版）

## 目标

将当前 "Bridge 直接操作 stream + callbacks.onEvent 并行持久化" 架构，
重构为 "SSS 拥有 stream，Bridge 只调 push/update" 架构。

### 核心变更

1. **SSS 拥有 VS Code stream** — Bridge 不再持有 stream 引用
2. **push / update 双 API** — append-only part 只能 push，mutable part 可以 push + update
3. **IMutableStreamPart 接口** — 类型层面标记哪些 part 可 update
4. **ExternalEditTracker 逻辑合并进 ExternalEditSSP** — 不再有独立 tracker
5. **三层文件分离** — session.jsonl（父会话）+ meta.jsonl（元数据）+ subsessions/（子会话）
6. **子会话独立文件** — 父会话不等待子会话，事件并发，文件分离避免交错
7. **序列化策略** — 写时不合并，读时合并（materializeRecords）。中断安全，纯 append
8. **中断检测** — 反序列化时检测未终止的 mutable part（pending/running），标记为 error

---

## 一、SSP 层

### 1.1 接口层次

```
SerializableStreamPart (abstract base)
  │
  ├── Append-only（不实现 IMutableStreamPart）
  │   ├── AssistantTextSSP      — push 携带 delta，render 调 markdown(delta)
  │   ├── ReasoningSSP           — push 携带 delta，render 调 thinkingProgress(delta)
  │   └── UserPromptSSP          — push 携带用户消息，render = no-op
  │
  └── Mutable（实现 IMutableStreamPart）
      ├── ToolInvocationSSP      — push 创建(pending)，update 变更(running/completed/error)
      │                            payload 携带 subAgentInvocationId（子会话关联）
      ├── QuestionSSP            — push 创建(asked, 带回调)，update 变更(replied/skipped)
      ├── ExternalEditSSP        — push 创建(lifecycle)，update 变更(baseline→complete)
      │                            实现 IMetadataProvider（异步 undoStopId 写 meta.jsonl）
      └── SessionLifecycleSSP    — push 创建，update 变更
```

### 1.2 基类

```typescript
abstract class SerializableStreamPart<TKind extends string, TPayload> {
  abstract readonly kind: TKind;
  readonly version = 1;
  readonly id: string;              // 每次构造生成唯一 id
  payload: TPayload;
  meta: SerializableStreamPartMeta;

  /** SSS 调用，传入 VS Code stream */
  abstract render(stream: SspStream): void;

  /** 序列化 */
  abstract toJSON(): StreamPartRecord<TKind, TPayload>;

  // ── 状态变更事件（仅用于 SSP 内部异步变更）────────────
  // SSS 驱动的 update 不触发此事件（避免双重 append）
  private listeners: Array<(ssp: this) => void> = [];
  onStateChange(cb: (ssp: this) => void): () => void {
    this.listeners.push(cb);
    return () => { this.listeners = this.listeners.filter(l => l !== cb); };
  }
  protected emitStateChange(): void {
    for (const cb of this.listeners) cb(this);
  }
}
```

**关键规则：** `IMutableStreamPart.update(data)` 只做 merge，**不调 emitStateChange**。
emitStateChange 只用于 SSP 内部异步变更（questionCarousel 回答、externalEdit undoStopId 到达）。

### 1.3 IMutableStreamPart 接口

```typescript
interface IMutableStreamPart<TPayload = unknown>
  extends SerializableStreamPart<string, TPayload> {
  update(data: Partial<TPayload>): void;  // 只 merge，不 emit
}

function isMutable(part: SerializableStreamPart): part is IMutableStreamPart {
  return typeof (part as IMutableStreamPart).update === 'function';
}
```

### 1.4 IMetadataProvider 接口（写入 meta.jsonl）

```typescript
interface IMetadataProvider {
  readonly metaId: string;   // 默认取 part.id（实例唯一，防同 partId 冲突）
  getMetadata(): Record<string, unknown> | undefined;
}
```

### 1.5 Append-only SSP

**AssistantTextSSP / ReasoningSSP：** 每个 delta 是独立实例，render 输出 delta，无 update。

**UserPromptSSP：** render = no-op（VS Code 原生显示）。由 handler 在 bridge.run() 之前 push。

### 1.6 Mutable SSP

**ToolInvocationSSP：**
- 构造时传入 `subAgentInvocationId`（可选，子会话关联）
- render 内部 `_progressivePushed` 防重复 push
- render 接收 stream 参数

**QuestionSSP：**
- render 有 `carouselShown` guard，只在首次 render + status='asked' 时启动 questionCarousel
- 结果通过构造回调回传 Bridge（onResult/onSkip），Bridge 负责格式映射
- 用户回答后 emitStateChange → SSS 写 meta.jsonl

**ExternalEditSSP（合并 tracker）：**
- render 有 `editStarted` guard，只在首次 render + status='pending' 时启动 stream.externalEdit
- update({status:'completed'}) → resolve deferred → VS Code 返回 undoStopId
- undoStopId 存入 `_undoStopId`，通过 IMetadataProvider.getMetadata() 暴露给 SSS
- emitStateChange → SSS syncMetadata → 写 meta.jsonl（不重写 session.jsonl）
- 快照逻辑从 ExternalEditTracker 搬入（captureBeforeSnapshots/captureAfterSnapshots）

---

## 二、SSS 层

### 2.1 SerializableSessionStream

```typescript
class SerializableSessionStream {
  private readonly stream: vscode.ChatResponseStream;
  private parts = new Map<string, SerializableStreamPart>();
  private subsessions = new Map<string, SubsessionStream>();
  private sessionPath: string | null = null;
  private metaPath: string | null = null;
  private writeQueue: Promise<void> = Promise.resolve();

  constructor(stream: vscode.ChatResponseStream, config: { ... }) {}

  // ── 父会话 API ────────────────────────────────────────

  push(ssp: SerializableStreamPart): void {
    this.parts.set(ssp.id, ssp);
    ssp.onStateChange((s) => this.syncMetadata(s));
    ssp.render(this.stream as unknown as SspStream);
    this.appendSession(ssp.toJSON());
    this.syncMetadata(ssp);
  }

  update(id: string, data: Record<string, unknown>): void {
    const ssp = this.parts.get(id);
    if (!ssp || !isMutable(ssp)) return;
    ssp.update(data);                                    // merge only, 不 emit
    ssp.render(this.stream as unknown as SspStream);
    this.appendSession(ssp.toJSON());
    this.syncMetadata(ssp);
  }

  // ── 子会话 API ────────────────────────────────────────

  subsession(subAgentInvocationId: string): SubsessionStream {
    let sub = this.subsessions.get(subAgentInvocationId);
    if (!sub) {
      sub = new SubsessionStream(this.sessionDir, subAgentInvocationId, this.stream);
      this.subsessions.set(subAgentInvocationId, sub);
    }
    return sub;
  }

  // ── 元数据 ────────────────────────────────────────────

  writeMeta(patch: Record<string, unknown>): void {
    this.appendMeta({ type: 'session', ...patch });
  }

  private syncMetadata(ssp: SerializableStreamPart): void {
    if (!isMetadataProvider(ssp)) return;
    const meta = ssp.getMetadata();
    if (!meta) return;
    this.appendMeta({ type: 'part-meta', id: ssp.metaId, ...meta });
  }

  // ── 快照 ──────────────────────────────────────────────

  serializeSnapshot(snapshot: FileSnapshotRecord): void { /* append to session.jsonl */ }

  // ── 生命周期 ──────────────────────────────────────────

  async initialize(): Promise<void> { /* version + turn-start */ }
  async flush(): Promise<void> { await this.writeQueue; }
  close(): void { /* turn-end */ }
  async drain(): Promise<void> {
    for (const sub of this.subsessions.values()) await sub.flush();
    await this.flush();
  }
}
```

### 2.2 SubsessionStream

```typescript
class SubsessionStream {
  private parts = new Map<string, SerializableStreamPart>();
  private filePath: string;

  constructor(sessionDir: string, subAgentInvocationId: string, stream: vscode.ChatResponseStream) {
    const subDir = path.join(sessionDir, 'subsessions', subAgentInvocationId);
    this.filePath = path.join(subDir, 'subsession.jsonl');
  }

  push(ssp: SerializableStreamPart): void {
    this.parts.set(ssp.id, ssp);
    ssp.render(this.stream as unknown as SspStream);
    this.append(ssp.toJSON());
  }

  update(id: string, data: Record<string, unknown>): void {
    const ssp = this.parts.get(id);
    if (!ssp || !isMutable(ssp)) return;
    ssp.update(data);
    ssp.render(this.stream as unknown as SspStream);
    this.append(ssp.toJSON());
  }

  async flush(): Promise<void> { /* await write queue */ }
  private append(record): void { /* append to subsession.jsonl */ }
}
```

### 2.3 文件结构

```
{workspaceRoot}/.acpilot/{backend}/{sessionId}/
├── meta.jsonl                        ← 父会话元数据
├── session.jsonl                     ← 父会话 stream parts
└── subsessions/
    └── {subAgentInvocationId}/
        ├── submeta.jsonl             ← 子会话元数据（可选）
        └── subsession.jsonl          ← 子会话 stream parts
            └── subsessions/          ← 嵌套子会话（递归）
```

**父子分离的原因：** OpenCode 父会话不等待子会话 — 两者事件并发到达。
混在一个文件会导致 materializeRecords 交错乱序。分离后各自有序，独立合并。

### 2.4 序列化策略

**写盘：** 零 buffer，每次 push/update 直接 append。中断安全。

**meta.jsonl 合并规则：** 按 id last-write-wins。

### 2.5 Turn 边界与用户消息

Handler 在 bridge.run() 之前 push UserPromptSSP。
turn-start/turn-end 由 SSS.initialize()/close() 写入 session.jsonl。

---

## 三、反序列化

### 3.1 materializeRecords（读时合并）

每个 JSONL 文件独立合并。连续同 id 记录合并：

```typescript
const MUTABLE_KINDS = new Set(['toolInvocation', 'question', 'externalEdit']);
function isMutableKind(kind: string): boolean { return MUTABLE_KINDS.has(kind); }

function materializeRecords(records: StreamPartRecord[]): StreamPartRecord[] {
  const result: StreamPartRecord[] = [];
  const mutableLatest = new Map<string, number>();  // id → result index

  for (const record of records) {
    if (isMutableKind(record.kind)) {
      // mutable: 全局按 id 聚合，取最新
      const idx = mutableLatest.get(record.id);
      if (idx !== undefined) {
        result[idx].payload = mergePayload(result[idx].payload, record.payload, record.kind);
      } else {
        mutableLatest.set(record.id, result.length);
        result.push({ ...record });
      }
    } else {
      // append-only: 连续同 id 合并
      const last = result[result.length - 1];
      if (last && last.id === record.id && !isMutableKind(last.kind)) {
        last.payload = mergePayload(last.payload, record.payload, record.kind);
      } else {
        result.push({ ...record });
      }
    }
  }
  return result;
}

function mergePayload(prev, curr, kind) {
  if (kind === 'toolInvocation') {
    return { ...curr, state: mergeToolState(prev.state, curr.state) };
  }
  // append-only: 拼接 delta
  // 其他 mutable: 取最新
  return curr;
}

function mergeToolState(prev, curr) {
  // error 是终态 — 一旦失败，不被后续状态覆盖
  if (prev?.status === 'error') {
    return { ...curr, status: 'error', error: prev.error ?? curr?.error };
  }
  return curr;
}
```

### 3.2 中断检测（finalizeIncompleteStates）

会话被中断时（崩溃、取消、断连），工具可能停在 pending/running。

```typescript
function finalizeIncompleteStates(
  records: StreamPartRecord[],
  sessionStatus: string,  // 'completed' | 'inProgress' | 'failed'
): StreamPartRecord[] {
  // 进行中的会话有 pending 工具是正常的
  if (sessionStatus === 'inProgress') return records;

  return records.map(record => {
    if (record.kind === 'toolInvocation') {
      const status = record.payload?.state?.status;
      if (status === 'pending' || status === 'running') {
        return {
          ...record,
          payload: {
            ...record.payload,
            state: {
              ...record.payload.state,
              status: 'error',
              error: 'Interrupted — session ended before completion',
            },
          },
        };
      }
    }
    // QuestionSSP: asked → skipped
    if (record.kind === 'question' && record.payload?.status === 'asked') {
      return { ...record, payload: { ...record.payload, status: 'skipped' } };
    }
    return record;
  });
}
```

### 3.3 辅助函数规格

```typescript
/** 按 kind 分发创建 SSP 实例（回放用，无回调） */
function createSSPFromRecord(record: StreamPartRecord, metaIndex?: Map<string, unknown>): SerializableStreamPart {
  switch (record.kind) {
    case 'userPrompt':      return new UserPromptSSP(record.payload);
    case 'assistantText':   return new AssistantTextSSP(record.payload);
    case 'reasoning':       return new ReasoningSSP(record.payload);
    case 'toolInvocation':  return new ToolInvocationSSP(record.payload);
    case 'question':        return new QuestionSSP(record.payload, {});  // 回放无回调
    case 'externalEdit':    return new ExternalEditSSP(record.payload, {
      onBaselineCaptured: () => {}, onSnapshot: () => {},  // 回放 no-op
    });
    default:                return new RawAcpEventSSP(record.payload);
  }
}

/** 读 JSONL 所有 stream-part 行 */
function readAllStreamParts(filePath: string): StreamPartRecord[] {
  const content = fs.readFileSync(filePath, 'utf-8');
  return content.split('\n')
    .map(line => parseLine(line))
    .filter(l => l?.t === 'stream-part')
    .map(l => l.d as StreamPartRecord);
}

/** 读 meta.jsonl，按 id 分组取最后一条 */
function readMetaIndex(filePath: string): Map<string, Record<string, unknown>> {
  const index = new Map<string, Record<string, unknown>>();
  try {
    const content = fs.readFileSync(filePath, 'utf-8');
    for (const line of content.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      const parsed = JSON.parse(trimmed);
      const id = parsed.type === 'session' ? 'session' : parsed.id;
      const prev = index.get(id) ?? {};
      index.set(id, { ...prev, ...parsed });  // 浅合并，后写覆盖
    }
  } catch { /* 文件不存在 → 空索引 */ }
  return index;
}
```

### 3.4 回放流程（递归）

```typescript
async function restoreSession(sessionDir: string, stream: vscode.ChatResponseStream): Promise<ChatSessionHistory> {
  // 1. 读 meta.jsonl → 元数据索引 + session 状态
  const metaIndex = readMetaIndex(path.join(sessionDir, 'meta.jsonl'));
  const sessionStatus = metaIndex.get('session')?.status ?? 'completed';

  // 2. 读 session.jsonl → materializeRecords → 中断检测
  const rawRecords = readAllStreamParts(path.join(sessionDir, 'session.jsonl'));
  const materialized = materializeRecords(rawRecords);
  const finalized = finalizeIncompleteStates(materialized, sessionStatus);

  // 3. 创建 SSS + 逐个 push（递归读子会话）
  const sss = new SerializableSessionStream(stream, { ... });
  const processed = new Set<string>();

  for (const record of finalized) {
    sss.push(createSSPFromRecord(record, metaIndex));

    // 首次遇到 subAgentInvocationId → 读子会话
    const subId = record.payload?.subAgentInvocationId;
    if (subId && !processed.has(subId)) {
      processed.add(subId);
      const subDir = path.join(sessionDir, 'subsessions', subId);
      if (existsSync(subDir)) {
        await restoreSubsession(subDir, sss, subId, sessionStatus, processed);
      }
    }
  }

  return sss.buildHistory();
}

async function restoreSubsession(subDir: string, sss: SerializableSessionStream, invocationId: string, sessionStatus: string, processed: Set<string>) {
  const sub = sss.subsession(invocationId);
  const rawRecords = readAllStreamParts(path.join(subDir, 'subsession.jsonl'));
  const materialized = materializeRecords(rawRecords);
  const finalized = finalizeIncompleteStates(materialized, sessionStatus);

  for (const record of finalized) {
    sub.push(createSSPFromRecord(record));

    // 嵌套 subagent：递归（带去重）
    const nestedSubId = record.payload?.subAgentInvocationId;
    if (nestedSubId && !processed.has(nestedSubId)) {
      processed.add(nestedSubId);
      const nestedDir = path.join(subDir, 'subsessions', nestedSubId);
      if (existsSync(nestedDir)) {
        await restoreSubsession(nestedDir, sss, nestedSubId, sessionStatus, processed);
      }
    }
  }
}
```

**子会话插入时机：** 首次遇到 subAgentInvocationId 时，push 父记录后立即读子会话。
保证父卡片先于子事件存在。VS Code 按 subAgentInvocationId 分组，push 顺序不影响嵌套渲染。

### 3.4 Session List（不读 session.jsonl）

扫描每个会话的 meta.jsonl，取最后一条 type=session 行。

### 3.5 undoStopId 恢复

```
meta.jsonl: { type: "part-meta", id: "ssp-0-3", undoStopId: "vscode-xxx" }
     ↓ 合并到 ExternalEditSSP
toolIdEditMap: { "T1" → "vscode-xxx" }
     ↓
snapshots: after-snapshot 补 undoStopId → push TextEditPart
```

---

## 四、Bridge 层

### 4.1 AcpBridge 接口

```typescript
interface AcpBridge {
  setSSS(sss: SerializableSessionStream): void;
  run(events: AsyncIterable<AcpEvent>, token: CancellationToken): Promise<boolean>;
  getUserMessageId(): string | null;
  getSessionTitle(): string | null;
  getHadSubagentTasks(): boolean;
}
```

### 4.2 Bridge 实现

**SubagentManager 留在 bridge** — scope 追踪、子事件路由、延迟 idle、lazy binding。

```typescript
class OpenCodeBridge implements AcpBridge {
  private sss!: SerializableSessionStream;
  private partKinds = new Map<string, 'text' | 'reasoning' | 'tool'>();
  private userMessageId: string | null = null;
  private subagents = new SubagentManager();

  async run(events: AsyncIterable<AcpEvent>, token: CancellationToken): Promise<boolean> {
    for await (const event of events) {
      if (token.isCancellationRequested) break;
      this.handleEvent(event);
    }
    return !token.isCancellationRequested;
  }

  private handleEvent(event: AcpEvent): void {
    // 1. 检测子会话事件（eventSessionId !== this.sessionId）
    const eventSessionId = getEventSessionId(event);
    if (eventSessionId && eventSessionId !== this.sessionId) {
      this.handleChildSessionEvent(event, eventSessionId);
      return;
    }

    // 2. 父会话事件
    switch (event.type) {
      case 'part.updated':       this.handlePartUpdated(event); break;
      case 'part.delta':         this.handlePartDelta(event); break;
      case 'permission.asked':   this.handlePermissionAsked(event); break;
      case 'question.asked':     this.handleQuestionAsked(event); break;
      case 'session.updated':    this.sss.writeMeta({ title: event.title }); break;
      case 'session.idle':       this.handleSessionIdle(); break;
      case 'session.diff':       this.sss.writeMeta({ changeSummary: ... }); break;
    }
  }

  // ── 父会话事件 → sss.push / sss.update ────────────────

  private handlePartDelta(event: AcpPartDeltaEvent): void {
    const kind = this.partKinds.get(event.partId);
    if (kind === 'reasoning') {
      this.sss.push(new ReasoningSSP({ partId: event.partId, delta: event.delta }));
    } else {
      this.sss.push(new AssistantTextSSP({ partId: event.partId, delta: event.delta }));
    }
  }

  private handlePartUpdated(event: AcpPartUpdatedEvent): void {
    switch (event.part.type) {
      case 'text': {
        if (this.userMessageId === null && event.part.messageId) {
          this.userMessageId = event.part.messageId;
        }
        if (event.part.messageId === this.userMessageId) {
          this.partKinds.set(event.part.id, 'text');
          return;  // 跳过用户回显
        }
        this.sss.push(new AssistantTextSSP({ partId: event.part.id, delta: event.part.text }));
        this.partKinds.set(event.part.id, 'text');
        break;
      }
      case 'reasoning':
        this.sss.push(new ReasoningSSP({ partId: event.part.id, delta: event.part.text }));
        this.partKinds.set(event.part.id, 'reasoning');
        break;
      case 'tool':
        this.handleToolState(event.part);
        break;
    }
  }

  private handleToolState(part: AcpToolPart): void {
    const key = part.callId ?? part.id;
    const status = part.state.status;

    if (status === 'pending') {
      // task/subagent → 创建 SubagentScope
      if (part.toolName === 'task' || part.toolName === 'subagent') {
        const scope = this.subagents.startSubagent(key, { toolName: part.toolName, ... });
        this.sss.push(new ToolInvocationSSP({
          callId: key, partId: part.id, toolName: part.toolName, state: part.state,
          subAgentInvocationId: scope.subAgentInvocationId,
        }));
      } else {
        this.sss.push(new ToolInvocationSSP({
          callId: key, partId: part.id, toolName: part.toolName, state: part.state,
        }));
      }
    } else {
      this.sss.update(key, { state: part.state });
      // write/edit 完成 → 完成 ExternalEditSSP
      if ((status === 'completed' || status === 'error') && this.isWriteEditTool(part.toolName)) {
        this.sss.update(key, { status: 'completed' });
      }
      // task/subagent 完成 → 更新 scope
      if ((part.toolName === 'task' || part.toolName === 'subagent')) {
        this.subagents.completeSubagent(key, part.state.output);
      }
    }
  }

  // ── 子会话事件 → sss.subsession(id).push / update ─────

  private handleChildSessionEvent(event: AcpEvent, eventSessionId: string): void {
    const scope = this.subagents.findScopeForSession(eventSessionId);

    if (event.type === 'session.idle') {
      this.subagents.markChildIdle(scope?.callId);
      if (scope?.childIdle) {
        this.sss.update(scope.callId, {
          state: { status: 'completed', output: scope.output },
        });
      }
      return;
    }

    if (event.type === 'part.updated' && event.part?.type === 'tool') {
      const childCallId = event.part.callId ?? event.part.id;
      const childStatus = event.part.state?.status;
      const sub = this.sss.subsession(scope.subAgentInvocationId);

      if (childStatus === 'pending') {
        sub.push(new ToolInvocationSSP({
          callId: childCallId,
          partId: `subagent-child-${childCallId}`,
          toolName: event.part.toolName,
          state: event.part.state,
          subAgentInvocationId: scope.subAgentInvocationId,
        }));
      } else {
        sub.update(childCallId, { state: event.part.state });
      }

      // 更新父卡片进度
      this.subagents.recordChildToolCall(scope.callId, {
        name: event.part.toolName, status: childStatus,
      });
      this.sss.update(scope.callId, {
        state: { title: formatSubagentProgress(scope) },
      });
    }
  }

  // ── Permission / Question ─────────────────────────────

  private handlePermissionAsked(event): void {
    const callId = event.tool?.callId;
    if (!callId) return;
    const filePath = this.extractFilePath(event);
    if (!filePath) {
      this.backend.permissions.reply(event.sessionId, event.permissionId, 'once', this.directory);
      return;
    }
    this.sss.push(new ExternalEditSSP(
      { id: callId, toolCallId: callId, uris: [filePath], status: 'pending' },
      {
        onBaselineCaptured: () => {
          this.backend.permissions.reply(event.sessionId, event.permissionId, 'once', this.directory);
        },
        onSnapshot: (s) => { this.sss.serializeSnapshot(s); },
      },
    ));
  }

  private handleQuestionAsked(event): void {
    this.sss.push(new QuestionSSP(
      { id: event.questionId, questionId: event.questionId, questions: event.questions, status: 'asked' },
      {
        onResult: (vscodeRaw) => {
          const answers = this.mapQuestionAnswers(vscodeRaw, event.questions);
          this.backend.questions.reply(event.sessionId, event.questionId, answers, this.directory);
          this.sss.update(event.questionId, { status: 'replied' });   // ← 写入 session.jsonl
        },
        onSkip: () => {
          this.backend.questions.reject(event.sessionId, event.questionId, this.directory);
          this.sss.update(event.questionId, { status: 'skipped' });    // ← 写入 session.jsonl
        },
      },
    ));
  }

  // ── 延迟 idle ─────────────────────────────────────────

  private handleSessionIdle(): void {
    if (this.subagents.hasBusyDescendant()) {
      // 子会话还在运行 — 延迟 idle，等子完成
      return;
    }
    // 所有子会话 idle → 可以结束
  }

  // 辅助方法
  private mapQuestionAnswers(vscodeRaw: unknown, questions: AcpQuestionInfo[]): string[][] { ... }
  private extractFilePath(event): string | null { ... }
  private isWriteEditTool(toolName: string): boolean { ... }
}
```

### 4.3 移除的内容

| 移除项 | 原因 |
|--------|------|
| bridge.setStream/setCallbacks/setTracker | SSS 拥有 stream |
| StreamingBridgeCallbacks | SSS 内部处理 |
| ExternalEditTracker | 合并进 ExternalEditSSP |
| callbacks.onEvent/onExternalEdit | push/update + IMetadataProvider 替代 |
| drainExternalEditCompletions | SSS.drain() 统一 |
| Bridge 直接调 stream API（24 处）| 全部通过 SSP.render() |
| _meta.json + requestDetails | meta.jsonl + IMetadataProvider 替代 |

---

## 五、Handler 层

```typescript
const sss = new SerializableSessionStream(stream, { workspaceRoot, backendName, sessionId, turnIndex, requestId });
await sss.initialize();

sss.push(new UserPromptSSP({ text: request.prompt, command: request.command }));

const bridge = state.backend.createBridge(backendSessionId, directory);
bridge.setSSS(sss);

try {
  await bridge.run(events, token);
  await sss.flush();
} finally {
  await sss.drain();
  sss.close();
  await sss.flush();
}
```

---

## 六、文件变更清单

### 新增

| 文件 | 内容 |
|------|------|
| `src/ssp/impl/question.ts` | QuestionSSP |
| `src/ssp/impl/user-prompt.ts` | UserPromptSSP |
| `src/acp/streaming/subsession-stream.ts` | SubsessionStream |

### 重写

| 文件 | 变更 |
|------|------|
| `src/ssp/types.ts` | 基类改造 + IMutableStreamPart + IMetadataProvider |
| `src/ssp/impl/assistant-text.ts` | 构造携带 delta |
| `src/ssp/impl/reasoning.ts` | 同上 |
| `src/ssp/impl/tool-invocation.ts` | IMutableStreamPart，subAgentInvocationId 在 payload |
| `src/ssp/impl/external-edit.ts` | 合并 tracker + IMetadataProvider |
| `src/acp/streaming/session-stream.ts` | push/update + subsession() + 两文件 |
| `src/acp/backend.ts` | AcpBridge: setSSS |
| `src/backends/opencode/opencode-bridge.ts` | push/update + 子会话路由 |
| `src/backends/opencode/adapter.ts` | createBridge 签名 |
| `src/participant/handler.ts` | 装配 + UserPromptSSP |
| `src/surfaces/vscode/experimental-session.ts` | 递归回放 + materializeRecords + finalizeIncompleteStates |
| `src/acp/serializable/stream-parts.ts` | 适配新格式 |

### 无变更

| 文件 | 原因 |
|------|------|
| `src/acp/serializable/serializer.ts` | 纯 append-only |

### 删除

| 文件 | 原因 |
|------|------|
| `src/participant/external-edit-tracker.ts` | 合并进 ExternalEditSSP |

---

## 七、实施阶段

1. **Phase 1: SSP 层** — 基类 + 接口 + 所有 impl + UserPromptSSP + QuestionSSP + ExternalEditSSP
2. **Phase 2: SSS 层** — push/update + SubsessionStream + 两文件 + materializeRecords + finalizeIncompleteStates
3. **Phase 3: Bridge 层** — setSSS + push/update + 子会话路由 + SubagentManager
4. **Phase 4: Handler** — 装配 + 删除 ExternalEditTracker
5. **Phase 5: 回放** — 递归读取 + meta 合并 + 中断检测
6. **Phase 6: 清理 + 验证**

---

## 八、关键设计决策

| 决策 | 理由 |
|------|------|
| SSS 持有 stream | Bridge 不碰 VS Code API |
| push/update 双 API | 对齐 VS Code：append-only vs mutable |
| IMutableStreamPart | 类型层面防止误 update |
| session.jsonl 永不重写 | 中断安全 + 纯 append |
| 读时合并（materializeRecords） | 无 buffer，无随机写 |
| meta.jsonl 独立文件 | Session List 不解析大文件 |
| IMetadataProvider + metaId | 异步 metadata 不触发 session.jsonl 重写 |
| 子会话独立文件 | 父子并发，避免交错乱序 |
| SubsessionStream | 子会话 push/update 独立文件，递归嵌套 |
| 中断检测 | 未终止的 mutable part 标记为 error |
| error 终态保护 | materializeRecords 中 error 不被覆盖 |
| ExternalEditSSP 合并 tracker | 消除三套并行系统 |
| update 不调 emitStateChange | 防止双重 append |
| render guard | 防止重复启动生命周期 |
| SubagentManager 留 bridge | 编排逻辑，非 SSS/SSP 职责 |
| 回放不需要 SubagentManager | subAgentInvocationId 在 payload + 文件路径 |
