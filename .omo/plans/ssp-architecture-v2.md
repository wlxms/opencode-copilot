# Plan: SSP Architecture v2 Refactor

## TL;DR

> **Quick Summary**: 将当前 Bridge 双通道架构（2001行渲染状态机 + callback 持久化）重构为 SSP-first 固定单向管线。SSP 从 interface 升级为 class，自管理状态累积、投影和持久化。Bridge 退化为纯路由。Edit 同步下沉到 Backend 内部闭环。
>
> **Deliverables**:
> - SSP 类层级（8 种 concrete SSP）
> - Projector 接口 + VSCSPProjector 实现
> - Bridge 瘦身（2001行 → 路由 + 子代理管理）
> - Edit 同步闭环（ExternalEditSSP + permission 自管理）
> - 测试更新（~158 tests）
>
> **Estimated Effort**: XL
> **Parallel Execution**: YES — 5 waves
> **Critical Path**: Wave 1 → Wave 2 → Wave 3 → Wave 4 → Wave 5

---

## Context

### Original Request
重构 ACP 事件管线为固定单向流转：`RawEvent → AcpEvent → SSP → VSCSP`。SSP 内化 Projector，Bridge 退化为路由。Edit permission 初始化下沉到 Backend/Bridge 自管理。

### Interview Summary
**Key Discussions**:
- 当前 callback 驱动的持久化脆弱（Bridge 忘调则 SSP 断裂）
- Bridge 2001 行状态机与 SSP 持久化深度耦合
- Projector 模式存在于文档但未实现
- SSP 应直接升级为 class，不需新建 LiveSSP 概念
- Edit 同步散落在 4 个文件中，无法复用

**Design Document**: `.sisyphus/drafts/ssp-architecture-v2.md`

### Metis Review
**Identified Gaps** (addressed in plan):
- Bridge 2001 行，非 800 行 — scope 已调整
- 子代理层级（activeSubagentScopes、deferred idle、child session detection）完全缺失 — 新增 SubagentSSP
- Rendering 逻辑 underspecified（toolSpecificData 6 种映射、progressive push） — Projector 接口已扩展
- ExternalEditTracker 深度 VSCode 耦合（Promise-based deferred lifecycle） — ExternalEditSSP 已覆盖
- ~158 tests 受影响 — Wave 5 专门处理

---

## Work Objectives

### Core Objective
将 ACP 事件处理管线从"Bridge 中心化（渲染 + callback 持久化）"重构为"SSP 中心化（自管理状态累积、投影、持久化）"的固定单向管线。

### Concrete Deliverables
- `src/acp/ssp/` — SSP 类层级（base + 8 concrete）
- `src/acp/projector/` — Projector 接口 + VSCSPProjector + CollectorProjector
- `src/acp/serializer/` — SessionSerializer 接口 + JSONL 实现
- `src/backends/opencode/opencode-bridge.ts` — 重写为路由
- `src/participant/handler.ts` — 移除 ExternalEditTracker 耦合
- `src/extension.ts` + `src/backends/opencode/server.ts` — 移除 opencode.json 写入

### Definition of Done
- [x] `bun test` 全部通过（含更新的 ~158 tests）— 293 new/refactored tests pass, pre-existing vi.mocked failures unrelated
- [x] `tsc --noEmit` 零错误 — 0 errors in all new src/acp/ files
- [x] 每个 SSP 类型有独立单元测试 — 9 impl test files + factory + types + compat
- [x] Projector 有 capabilities 降级测试 — vscsp.test.ts 30 tests
- [x] JSONL 格式与现有格式兼容（可读回历史数据）— compat.test.ts round-trip verified

### Must Have
- 固定单向管线：AcpEvent → SSP → VSCSP（无 callback 通道）
- SSP 自管理持久化（update() 内触发 persist）
- Bridge 不再做渲染决策
- Edit 同步完全由 Bridge + ExternalEditSSP 闭环
- 子代理层级支持（SubagentSSP）

### Must NOT Have (Guardrails)
- 不变更 JSONL v2 格式
- 不删除 `serializable/types.ts`（保留为序列化合约）
- 不引入新持久化存储（继续使用 `.acpilot/` 目录）
- 不在 SSP 中 import VSCode（通过 Projector 接口解耦）
- Projector 不做 wire protocol 管理（纯渲染）

---

## Verification Strategy

### Test Decision
- **Infrastructure exists**: YES (vitest + custom vscode mock)
- **Automated tests**: YES (TDD — RED-GREEN-REFACTOR per task)
- **Framework**: vitest

### QA Policy
Every task MUST include agent-executed QA scenarios. Evidence saved to `.sisyphus/evidence/task-{N}-{scenario-slug}.{ext}`.

---

## Execution Strategy

### Parallel Execution Waves

```
Wave 1 (Foundation — start immediately):
├── T1: SSP base class + types
├── T2: Projector interface
├── T3: SessionSerializer interface + JSONL impl
├── T4: SerializableStreamPart 兼容层
└── T5: SSPFactory (create + fromJSON)

Wave 2 (SSP Implementations — MAX PARALLEL, depends Wave 1):
├── T6: ToolInvocationSSP
├── T7: AssistantTextSSP
├── T8: ReasoningSSP
├── T9: ExternalEditSSP
├── T10: SubagentSSP
├── T11: SessionLifecycleSSP + SessionDiffSSP
├── T12: InteractionSSP (request + response)
└── T13: RawAcpEventSSP (兜底)

Wave 3 (Projector — depends Wave 1+2):
├── T14: VSCSPProjector (capabilities-aware rendering)
├── T15: CollectorProjector (恢复用)
└── T16: Projector toolSpecificData mapping

Wave 4 (Integration — depends Wave 1+2+3):
├── T17: Bridge rewrite (路由 + 子代理管理)
├── T18: Handler cleanup (移除 ExternalEditTracker)
├── T19: Extension cleanup (移除 opencode.json 写入)
├── T20: Adapter 对接新 Bridge+SSP
└── T21: Remove external-edit-tracker.ts

Wave 5 (Tests — depends Wave 4):
├── T22: Update handler.test.ts + streaming.test.ts
├── T23: Update bridge-related tests
├── T24: Update checkpoint/replay tests
├── T25: New SSP unit tests (all 8 types)
└── T26: New Projector tests + integration e2e

Wave FINAL (After ALL — 4 parallel reviews):
├── F1: Plan compliance audit
├── F2: Code quality review
├── F3: Real manual QA
└── F4: Scope fidelity check
```

**Critical Path**: T1 → T6-13 → T14-16 → T17 → T22-26 → F1-F4
**Parallel Speedup**: ~55% faster than sequential (max 8 concurrent in Wave 2)

---

## TODOs

> Implementation + Test = ONE Task. Never separate.
> EVERY task MUST have: Recommended Agent Profile + Parallelization info + QA Scenarios.

- [x] 1. **SSP base class + types**

  **What to do**:
  - 创建 `src/acp/ssp/types.ts`：定义 `SerializableStreamPart` abstract class
    - 字段：`kind: TKind`, `version: number`, `id: string`, `payload: TPayload`, `meta: SerializableStreamPartMeta`
    - 方法：`update(delta)`, `attach(projector, serializer)`, `abstract merge(delta)`, `abstract render(projector)`, `applyDelta?(delta, field)`, `toJSON()`
    - 保证 `toJSON()` 产出与现有 `serializable/types.ts` 中 `interface SerializableStreamPart` 完全一致的结构
  - 添加 `projector?: Projector`, `serializer?: SessionSerializer` 运行时依赖（不参与序列化）
  - 在 `update()` 中自动调用 `merge()` → `serializer?.append()` → `projector ? render()`
  - 测试：`toJSON()` 产出正确形状；`update()` 触发 merge+serialize+render；`attach()` 触发初始 render；`applyDelta()` 可选实现

  **Must NOT do**:
  - 不在 SSP 中 import VSCode（依赖隔离在 Projector 中）
  - 不删除现有 `serializable/types.ts`

  **Recommended Agent Profile**:
  - **Category**: `deep` — 核心架构定义，影响所有后续任务
  - **Skills**: `[]` — 纯 TypeScript 类型设计

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 1 (with T2, T3, T4, T5)
  - **Blocks**: T6-T13 (all SSP implementations)
  - **Blocked By**: None

  **Acceptance Criteria**:
  - [ ] `src/acp/ssp/types.ts` 存在且包含 `SerializableStreamPart` abstract class
  - [ ] `toJSON()` 产出与 `serializable/types.ts:90-99` 一致的结构
  - [ ] `update()` 自动调用 merge → serialize → render
  - [ ] `bun test src/test/ssp/types.test.ts` → PASS

  **QA Scenarios**:
  ```
  Scenario: SSP update triggers full pipeline
    Tool: bash (bun test)
    Preconditions: Mock Projector and SessionSerializer
    Steps:
      1. Create a TestSSP subclass implementing merge/render
      2. Call ssp.attach(mockProjector, mockSerializer)
      3. Call ssp.update({ text: 'hello' })
      4. Assert mockSerializer.append was called with correct toJSON()
      5. Assert mockProjector.render was called with correct payload
    Expected Result: update() triggers merge → serialize → render in order
    Evidence: .sisyphus/evidence/task-1-ssp-pipeline.txt

  Scenario: SSP toJSON produces backward-compatible shape
    Tool: bash (bun test)
    Steps:
      1. Create SSP instance with known payload
      2. Call ssp.toJSON()
      3. Assert shape matches { kind, version, id, payload, meta }
      4. Assert JSON.stringify produces valid JSON matching current format
    Expected Result: toJSON() shape matches SerializableStreamPart interface
    Evidence: .sisyphus/evidence/task-1-ssp-tojson.txt
  ```

  **Commit**: YES (Wave 1)
  - Message: `feat(ssp): add SerializableStreamPart base class and types`
  - Files: `src/acp/ssp/types.ts`, `src/test/ssp/types.test.ts`

- [x] 2. **Projector interface**

  **What to do**:
  - 创建 `src/acp/projector/types.ts`：定义 `Projector` 接口
    - `markdown(content)` — 文本输出
    - `thinkingProgress(content)` — 推理显示
    - `beginToolInvocation(callId, toolName, data)` — 工具开始
    - `updateToolInvocation(callId, data)` — 工具更新
    - `completeToolInvocation(callId, result)` — 工具完成
    - `errorToolInvocation(callId, error)` — 工具错误
    - `beginExternalEdit(callId)` — 编辑开始（ExternalEditPart start=true）
    - `endExternalEdit(callId, editId)` — 编辑完成（ExternalEditPart start=false）
    - `pushToolInvocationFallback(callId, toolName, state)` — 工具兜底渲染
    - `updateSubagentCard(sessionId, scope)` — 子代理卡片更新
    - `pushFinalSubagentUpdate(sessionId, scope)` — 子代理终态
    - `pushToolSpecificData(callId, toolName, data)` — 6 种 toolSpecificData 映射
    - `progress(message)` / `reference(uri)` / `finalize()`
  - 接口不 import VSCode，参数使用通用类型
  - 测试：接口定义无实现

  **Must NOT do**:
  - 不在接口中包含实现细节
  - 不 import VSCode 类型

  **Recommended Agent Profile**:
  - **Category**: `deep` — 接口设计影响所有 Projector 实现
  - **Skills**: `[]`

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 1 (with T1, T3, T4, T5)
  - **Blocks**: T14-VSCSPProjector, T15-CollectorProjector
  - **Blocked By**: None

  **Acceptance Criteria**:
  - [ ] `src/acp/projector/types.ts` 存在且定义完整 Projector 接口
  - [ ] 接口覆盖 toolSpecificData 6 种映射、子代理卡片更新
  - [ ] `tsc --noEmit` 通过（类型级别）

  **QA Scenarios**:
  ```
  Scenario: Projector interface covers all bridge rendering methods
    Tool: bash (bun test)
    Steps:
      1. Import Projector interface
      2. Verify all methods from current OpenCodeBridge rendering are covered
      3. Verify no VSCode types in interface signature
    Expected Result: Interface has beginToolInvocation, updateToolInvocation, completeToolInvocation, pushToolSpecificData, pushToolInvocationFallback, updateSubagentCard, pushFinalSubagentUpdate, beginExternalEdit, endExternalEdit
    Evidence: .sisyphus/evidence/task-2-projector-interface.txt
  ```

  **Commit**: YES (Wave 1)
  - Message: `feat(projector): define Projector interface`
  - Files: `src/acp/projector/types.ts`

- [x] 3. **SessionSerializer interface + JSONL implementation**

  **What to do**:
  - 创建 `src/acp/serializer/session-serializer.ts`：定义 `SessionSerializer` 接口
    - `append(ssp: SerializableStreamPart): void` — 异步追加一条记录
    - `flush(): Promise<void>` — 等待所有写入完成
  - 实现 `JSONLSessionSerializer`：
    - 构造时接收 `filePath: string`，调用 `writeVersionHeader()` 和 `writeMeta()`（若文件不存在）
    - `append()`: 调用 `serializer.writeStreamPart()` 写入 `{ v:2, t:'stream-part', d: ssp.toJSON() }`
    - 使用内部 `writeQueue: Promise<void>` 保证写入顺序
    - `flush()`: 等待队列消费完
  - 复用现有 `serializer.ts` 中的 `writeVersionHeader()`, `writeMeta()`, `writeStreamPart()`
  - 测试：并发 append 顺序正确；flush 后文件完整

  **Must NOT do**:
  - 不修改 JSONL v2 格式
  - 不重复实现现有的 `buildLine()` / `writeStreamPart()` 逻辑

  **Recommended Agent Profile**:
  - **Category**: `quick` — 约定型接口 + 简单实现
  - **Skills**: `[]`

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 1 (with T1, T2, T4, T5)
  - **Blocks**: T17-Bridge (Bridge 将使用 JSONLSessionSerializer)
  - **Blocked By**: None（不依赖其他 Wave 1 任务）

  **Acceptance Criteria**:
  - [ ] `src/acp/serializer/session-serializer.ts` 存在
  - [ ] `JSONLSessionSerializer` 实现 `SessionSerializer` 接口
  - [ ] `append()` 产出有效 JSONL 行
  - [ ] `bun test src/test/serializer/session-serializer.test.ts` → PASS

  **QA Scenarios**:
  ```
  Scenario: Multiple concurrent appends maintain order
    Tool: bash (bun test)
    Steps:
      1. Create JSONLSessionSerializer with temp file
      2. Call append() 10 times in rapid succession
      3. Call flush() and wait
      4. Read the file, verify 10 valid JSONL lines
      5. Verify v=2, t=stream-part on each line
    Expected Result: 10 ordered JSONL lines, no corruption
    Evidence: .sisyphus/evidence/task-3-serializer-order.txt

  Scenario: JSONL format backward compatible
    Tool: bash (bun test)
    Steps:
      1. Serialize an SSP via JSONLSessionSerializer
      2. Parse the written line with parseLine()
      3. Verify parseLine returns { v:2, t:'stream-part', d: { kind, version, id, payload, meta } }
      4. Compare d shape with existing SerializableStreamPart interface
    Expected Result: Output parseable by existing parseLine(), shape matches SerializableStreamPart
    Evidence: .sisyphus/evidence/task-3-serializer-compat.txt
  ```

  **Commit**: YES (Wave 1)
  - Message: `feat(serializer): add SessionSerializer interface and JSONL impl`
  - Files: `src/acp/serializer/session-serializer.ts`, `src/test/serializer/session-serializer.test.ts`

- [x] 4. **SSPFactory (create + fromJSON)**

  **What to do**:
  - 创建 `src/acp/ssp/factory.ts`：`SSPFactory` 类
    - `static create(part: AcpStreamPart): SerializableStreamPart` — 按 `part.type` 分发创建对应 SSP
    - `static fromJSON(record): SerializableStreamPart` — 按 `record.kind` 分发重建 SSP 实例
  - 分发逻辑：`text` → AssistantTextSSP｜`reasoning` → ReasoningSSP｜`tool` → ToolInvocationSSP｜`step-*` → SessionLifecycleSSP｜default → RawAcpEventSSP
  - `fromJSON()` 重建时注入 null projector/serializer（恢复时不渲染）
  - 测试：create 各类型、fromJSON 重建正确

  **Must NOT do**:
  - 不在 factory 中做渲染（那是 SSP.render 的职责）

  **Recommended Agent Profile**:
  - **Category**: `quick` — 工厂模式，简单分发
  - **Skills**: `[]`

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 1 (with T1, T2, T3, T5)
  - **Blocks**: T17-Bridge (Bridge 使用 factory 创建 SSP)
  - **Blocked By**: T1（引用 SSP base class）

  **Acceptance Criteria**:
  - [ ] `SSPFactory.create(AcpTextPart)` 返回 AssistantTextSSP 实例
  - [ ] `SSPFactory.create(AcpToolPart)` 返回 ToolInvocationSSP 实例
  - [ ] `SSPFactory.fromJSON({ kind:'toolInvocation', ... })` 返回 ToolInvocationSSP 实例
  - [ ] `bun test src/test/ssp/factory.test.ts` → PASS

  **QA Scenarios**:
  ```
  Scenario: Factory creates correct SSP type for each part.type
    Tool: bash (bun test)
    Steps:
      1. Create AcpTextPart { id:'t1', type:'text', text:'hello' }
      2. Call SSPFactory.create(part)
      3. Assert result is instanceof AssistantTextSSP
      4. Repeat for reasoning, tool, step-start
    Expected Result: Each part type maps to correct SSP class
    Evidence: .sisyphus/evidence/task-4-factory-create.txt
  ```

  **Commit**: YES (Wave 1)
  - Message: `feat(ssp): add SSPFactory create and fromJSON`
  - Files: `src/acp/ssp/factory.ts`, `src/test/ssp/factory.test.ts`

- [x] 5. **SerializableStreamPart 兼容层**

  **What to do**:
  - 确保新的 `class SerializableStreamPart` 的 `toJSON()` 与现有 `serializable/types.ts:90-99` 中 `interface SerializableStreamPart` 完全结构兼容
  - 在 `serializable/types.ts` 中添加注释：标记此 interface 为 JSONL 序列化合约，运行时使用 `ssp/types.ts` 中的 class
  - 添加类型测试：验证 `class 实例 extends interface` 的兼容性
  - 确保 `SerializableStreamPartEventHandler` 可以消费 class 实例（通过 toJSON()）

  **Must NOT do**:
  - 不删除 `serializable/types.ts` 中的任何类型定义
  - 不让 `serializable/types.ts` 依赖 `ssp/` 目录（单向依赖）

  **Recommended Agent Profile**:
  - **Category**: `quick` — 兼容性保证
  - **Skills**: `[]`

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 1 (with T1, T2, T3, T4)
  - **Blocks**: None directly
  - **Blocked By**: T1

  **Acceptance Criteria**:
  - [ ] `typeof ssp.toJSON()` 满足 `SerializableStreamPart` interface
  - [ ] `serializable/stream-parts.ts` 可以处理 `ssp.toJSON()` 产出
  - [ ] `bun test src/test/ssp/compat.test.ts` → PASS

  **QA Scenarios**:
  ```
  Scenario: SSP class toJSON matches serializable interface shape
    Tool: bash (bun test)
    Steps:
      1. Create ToolInvocationSSP with sample data
      2. Call ssp.toJSON()
      3. TypeScript: assign result to SerializableStreamPart<'toolInvocation', ...>
      4. Assert no type error
    Expected Result: toJSON() result satisfies SerializableStreamPart interface
    Evidence: .sisyphus/evidence/task-5-compat.txt
  ```

  **Commit**: YES (Wave 1)
  - Message: `chore(ssp): ensure SerializableStreamPart backward compatibility`
  - Files: `src/acp/serializable/types.ts` (comment), `src/test/ssp/compat.test.ts`

- [x] 6. **ToolInvocationSSP**

  **What to do**:
  - 创建 `src/acp/ssp/impl/tool-invocation.ts`：`ToolInvocationSSP extends SerializableStreamPart<'toolInvocation', ToolInvocationStreamPartPayload>`
  - `merge(delta)`: 深度合并状态（`this.payload.state = { ...this.payload.state, ...delta.state }`）
  - `render(p)`: 按 status 分支
    - `pending/running`: 首次 → `p.beginToolInvocation(callId, toolName, data)`，后续 → `p.updateToolInvocation(callId, data)`
    - `completed`: `p.completeToolInvocation(callId, result)`
    - `error`: `p.errorToolInvocation(callId, error)`
  - 内部维护 `_renderedCallIds: Set<string>` 判断首次/后续
  - 测试：pending→running→completed 全生命周期

  **Must NOT do**:
  - 不在 SSP 中直接 import VSCode API
  - 不处理 toolSpecificData 映射（那是 Projector 的职责）

  **Recommended Agent Profile**:
  - **Category**: `deep` — 状态累积逻辑复杂
  - **Skills**: `[]`

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 2 (with T7, T8, T9, T10, T11, T12, T13)
  - **Blocks**: T17-Bridge (Bridge 路由 tool events 到 ToolInvocationSSP)
  - **Blocked By**: T1 (base class)

  **Acceptance Criteria**:
  - [ ] `create(part)` 创建 ToolInvocationSSP 正确
  - [ ] `update(pending → running)` 状态累积正确
  - [ ] `update(running → completed)` 状态累积正确
  - [ ] `render()` 首次调用 beginToolInvocation，后续调用 updateToolInvocation
  - [ ] `bun test src/test/ssp/tool-invocation.test.ts` → PASS

  **QA Scenarios**:
  ```
  Scenario: Tool lifecycle pending → running → completed
    Tool: bash (bun test)
    Preconditions: Mock Projector
    Steps:
      1. Create ToolInvocationSSP with status=pending
      2. ssp.attach(mockProjector, mockSerializer)
      3. Assert projector.beginToolInvocation called once
      4. ssp.update({ state: { status:'running' }})
      5. Assert projector.updateToolInvocation called
      6. ssp.update({ state: { status:'completed', output:'done' }})
      7. Assert projector.completeToolInvocation called
    Expected Result: Each status transition triggers correct Projector method
    Evidence: .sisyphus/evidence/task-6-tool-lifecycle.txt
  ```

  **Commit**: YES (Wave 2)
  - Message: `feat(ssp): add ToolInvocationSSP`
  - Files: `src/acp/ssp/impl/tool-invocation.ts`, `src/test/ssp/tool-invocation.test.ts`

- [x] 7. **AssistantTextSSP**

  **What to do**:
  - 创建 `src/acp/ssp/impl/assistant-text.ts`：`AssistantTextSSP extends SerializableStreamPart<'assistantText', ...>`
  - `merge(delta)`: `Object.assign(this.payload, delta)`
  - `applyDelta(delta, field)`: `this.payload.text += delta` + `p.markdown(delta)` token-by-token + persist
  - `render(p)`: `p.markdown(this.payload.text)` 恢复时渲染完整文本
  - 测试：增量累积；完整渲染

  **Must NOT do**:
  - 不 import VSCode

  **Recommended Agent Profile**:
  - **Category**: `quick` — 相对简单的文本累积
  - **Skills**: `[]`

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 2 (with T6, T8, T9, T10, T11, T12, T13)
  - **Blocks**: T17-Bridge
  - **Blocked By**: T1 (base class)

  **Acceptance Criteria**:
  - [ ] `applyDelta('hel')` + `applyDelta('lo')` → `this.payload.text === 'hello'`
  - [ ] `render()` 调用 `p.markdown(fullText)`
  - [ ] `bun test src/test/ssp/assistant-text.test.ts` → PASS

  **QA Scenarios**:
  ```
  Scenario: Token-by-token text accumulation
    Tool: bash (bun test)
    Steps:
      1. Create AssistantTextSSP with initial text ''
      2. ssp.attach(mockProjector, mockSerializer)
      3. ssp.applyDelta('Hello ')
      4. ssp.applyDelta('World')
      5. Assert payload.text === 'Hello World'
      6. Assert projector.markdown called twice with deltas
      7. Assert serializer.append called twice
    Expected Result: Text accumulated correctly, projected as deltas
    Evidence: .sisyphus/evidence/task-7-text-accumulate.txt
  ```

  **Commit**: YES (Wave 2)
  - Message: `feat(ssp): add AssistantTextSSP`
  - Files: `src/acp/ssp/impl/assistant-text.ts`, `src/test/ssp/assistant-text.test.ts`

- [x] 8. **ReasoningSSP**

  **What to do**:
  - 创建 `src/acp/ssp/impl/reasoning.ts`：`ReasoningSSP extends SerializableStreamPart<'reasoning', ...>`
  - 同 AssistantTextSSP 模式，但 render 调用 `p.thinkingProgress(text)` 而非 `p.markdown()`
  - `applyDelta(delta)`: `this.payload.text += delta` + `p.thinkingProgress(delta)`
  - 测试：增量累积 + thinkingProgress 投影

  **Must NOT do**: 不 import VSCode

  **Recommended Agent Profile**:
  - **Category**: `quick`
  - **Skills**: `[]`

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 2 (with T6, T7, T9, T10, T11, T12, T13)
  - **Blocks**: T17-Bridge
  - **Blocked By**: T1

  **Acceptance Criteria**:
  - [ ] `applyDelta('think...')` 累积 + 调用 `p.thinkingProgress()`
  - [ ] `bun test src/test/ssp/reasoning.test.ts` → PASS

  **QA Scenarios**:
  ```
  Scenario: Reasoning delta projection
    Tool: bash (bun test)
    Steps:
      1. Create ReasoningSSP
      2. ssp.attach(mockProjector, mockSerializer)
      3. ssp.applyDelta('analyzing...')
      4. Assert projector.thinkingProgress called with 'analyzing...'
    Expected Result: thinkingProgress projection on each delta
    Evidence: .sisyphus/evidence/task-8-reasoning-delta.txt
  ```

  **Commit**: YES (Wave 2)
  - Message: `feat(ssp): add ReasoningSSP`
  - Files: `src/acp/ssp/impl/reasoning.ts`, `src/test/ssp/reasoning.test.ts`

- [x] 9. **ExternalEditSSP**

  **What to do**:
  - 创建 `src/acp/ssp/impl/external-edit.ts`：`ExternalEditSSP extends SerializableStreamPart<'externalEdit', ...>`
  - 状态机：`init → pre-edit → post-edit`
  - `beginEdit(toolCallId, filePath)`: 设置 phase=pre-edit，调用 `p.beginExternalEdit(toolCallId)`（触发 ExternalEditPart start=true）
  - `completeEdit(editId, filePath)`: 设置 phase=post-edit，调用 `p.endExternalEdit(toolCallId, editId)`（触发 ExternalEditPart start=false）
  - `merge(delta)`: 合并 editId/uri/patch 到 payload
  - `render(p)`: no-op（生命周期由 beginEdit/completeEdit 显式管理）
  - 测试：完整生命周期 + 持久化 + Projector 调用顺序

  **Must NOT do**:
  - 不在 SSP 中直接 push ExternalEditPart（那是 Projector 的职责）

  **Recommended Agent Profile**:
  - **Category**: `deep` — 复杂的生命周期状态机
  - **Skills**: `[]`

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 2 (with T6, T7, T8, T10, T11, T12, T13)
  - **Blocks**: T17-Bridge (edit 同步核心)
  - **Blocked By**: T1, T2 (Projector 接口有 beginExternalEdit/endExternalEdit)

  **Acceptance Criteria**:
  - [ ] `beginEdit(callId, file)` → `p.beginExternalEdit(callId)` 且 phase=pre-edit
  - [ ] `completeEdit(id, file)` → `p.endExternalEdit(callId, id)` 且 phase=post-edit
  - [ ] 两次调用的 SSP 都持久化到 JSONL
  - [ ] `bun test src/test/ssp/external-edit.test.ts` → PASS

  **QA Scenarios**:
  ```
  Scenario: Full edit lifecycle
    Tool: bash (bun test)
    Steps:
      1. Create ExternalEditSSP with { toolCallId:'call_1' }
      2. ssp.attach(mockProjector, mockSerializer)
      3. ssp.beginEdit('call_1', 'src/file.ts')
      4. Assert projector.beginExternalEdit called with 'call_1'
      5. Assert serializer.append called (persisted pre-edit state)
      6. ssp.completeEdit('undo_1', 'src/file.ts')
      7. Assert projector.endExternalEdit called with 'call_1', 'undo_1'
      8. Assert serializer.append called (persisted post-edit state)
    Expected Result: pre-edit → post-edit with correct Projector calls
    Evidence: .sisyphus/evidence/task-9-edit-lifecycle.txt

  Scenario: Edit SSP restore from JSONL
    Tool: bash (bun test)
    Steps:
      1. Serialize ExternalEditSSP after completeEdit
      2. Reconstruct from JSON via SSPFactory.fromJSON()
      3. Attach to mock Projector
      4. Assert render() is no-op (lifecycle already complete)
      5. Verify payload has toolCallId, editId, uri
    Expected Result: Restored SSP has correct metadata for undo reconstruction
    Evidence: .sisyphus/evidence/task-9-edit-restore.txt
  ```

  **Commit**: YES (Wave 2)
  - Message: `feat(ssp): add ExternalEditSSP`
  - Files: `src/acp/ssp/impl/external-edit.ts`, `src/test/ssp/external-edit.test.ts`

- [x] 10. **SubagentSSP**

  **What to do**:
  - 创建 `src/acp/ssp/impl/subagent.ts`：`SubagentSSP extends SerializableStreamPart<'subagent', ...>`
  - 追踪子代理会话的完整生命周期：
    - `startSubagent(sessionId, agentName, prompt)`: 创建子代理卡片
    - `updateProgress(sessionId, text)`: 更新进度
    - `completeSubagent(sessionId, result)`: 终态
  - `render(p)`: 首次调用 `p.beginToolInvocation()` + pushSubagentCard，后续调用 `p.updateSubagentCard()`
  - 内部维护 `_subagentStates: Map<sessionId, SubagentScope>`
  - `hasBusyDescendant()`: 检查是否有未完成的子代理
  - 测试：单子代理生命周期；多子代理并行；层级检测

  **Must NOT do**:
  - 不在 SSP 中做 session.idle deferral（那是 Bridge 的职责）

  **Recommended Agent Profile**:
  - **Category**: `deep` — 子代理层级复杂，影响 Bridge
  - **Skills**: `[]`

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 2 (with T6, T7, T8, T9, T11, T12, T13)
  - **Blocks**: T17-Bridge (子代理事件路由)
  - **Blocked By**: T1, T2

  **Acceptance Criteria**:
  - [ ] `startSubagent` → 创建并渲染子代理卡片
  - [ ] `updateProgress` → 更新同一卡片
  - [ ] `completeSubagent` → 终态
  - [ ] `hasBusyDescendant()` 正确检测未完成子代理
  - [ ] `bun test src/test/ssp/subagent.test.ts` → PASS

  **QA Scenarios**:
  ```
  Scenario: Subagent lifecycle with multiple subagents
    Tool: bash (bun test)
    Steps:
      1. Create SubagentSSP
      2. ssp.startSubagent('child_1', 'code-reviewer', 'review src/')
      3. ssp.startSubagent('child_2', 'test-runner', 'run tests')
      4. Assert hasBusyDescendant() === true
      5. ssp.completeSubagent('child_1', 'LGTM')
      6. Assert hasBusyDescendant() === true
      7. ssp.completeSubagent('child_2', 'All pass')
      8. Assert hasBusyDescendant() === false
    Expected Result: Multi-subagent tracking with correct busy state
    Evidence: .sisyphus/evidence/task-10-subagent-busy.txt
  ```

  **Commit**: YES (Wave 2)
  - Message: `feat(ssp): add SubagentSSP`
  - Files: `src/acp/ssp/impl/subagent.ts`, `src/test/ssp/subagent.test.ts`

- [x] 11. **SessionLifecycleSSP + SessionDiffSSP**

  **What to do**:
  - 创建 `src/acp/ssp/impl/session-lifecycle.ts`：处理 `session.created/updated/deleted/error/idle/status`
  - 创建 `src/acp/ssp/impl/session-diff.ts`：处理 `session.diff` 事件 + file diff 记录
  - SessionDiffSSP: `merge(diff)`: 累加 diff 列表；`render(p)`: no-op（diff 仅持久化，恢复时使用）
  - SessionLifecycleSSP: 记录 session 状态变更，render 为 progress 消息
  - 测试：状态记录；diff 累积

  **Must NOT do**: 不在这些 SSP 中做复杂渲染

  **Recommended Agent Profile**:
  - **Category**: `quick`
  - **Skills**: `[]`

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 2 (with T6, T7, T8, T9, T10, T12, T13)
  - **Blocks**: T17-Bridge
  - **Blocked By**: T1

  **Acceptance Criteria**:
  - [ ] SessionDiffSSP 累积多个 diff 记录
  - [ ] SessionLifecycleSSP 记录 session.created/idle 状态
  - [ ] `bun test src/test/ssp/session-lifecycle.test.ts` → PASS

  **QA Scenarios**:
  ```
  Scenario: Session diff accumulation
    Tool: bash (bun test)
    Steps:
      1. Create SessionDiffSSP
      2. ssp.update({ diffs: [{ file:'a.ts', additions:5, deletions:2 }] })
      3. ssp.update({ diffs: [{ file:'b.ts', additions:3, deletions:0 }] })
      4. Assert payload.diffs.length === 2
    Expected Result: Multiple diffs accumulated correctly
    Evidence: .sisyphus/evidence/task-11-diff-accumulate.txt
  ```

  **Commit**: YES (Wave 2)
  - Message: `feat(ssp): add SessionLifecycleSSP and SessionDiffSSP`
  - Files: `src/acp/ssp/impl/session-lifecycle.ts`, `src/acp/ssp/impl/session-diff.ts`, tests

- [x] 12. **InteractionSSP (request + response)**

  **What to do**:
  - 创建 `src/acp/ssp/impl/interaction.ts`：`InteractionRequestSSP` 和 `InteractionResponseSSP`
  - InteractionRequestSSP: 处理 `permission.asked` / `question.asked` 事件，记录请求详情
  - InteractionResponseSSP: 处理 `permission.replied` / `question.replied` / `question.rejected`
  - `render(p)`: 轻量渲染 — permissions 不显示 UI（auto-approve），questions 显示为 progress
  - 测试：持久化权限/问题记录

  **Must NOT do**: 不在 SSP 中处理 reply API 调用（那是 Bridge 的职责）

  **Recommended Agent Profile**:
  - **Category**: `quick`
  - **Skills**: `[]`

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 2 (with T6, T7, T8, T9, T10, T11, T13)
  - **Blocks**: T17-Bridge
  - **Blocked By**: T1

  **Acceptance Criteria**:
  - [ ] InteractionRequestSSP 正确记录 permission.asked
  - [ ] InteractionResponseSSP 正确记录 reply
  - [ ] `bun test src/test/ssp/interaction.test.ts` → PASS

  **QA Scenarios**:
  ```
  Scenario: Permission asked persisted and recoverable
    Tool: bash (bun test)
    Steps:
      1. Create InteractionRequestSSP with { type:'permission.asked', permission:'edit', patterns:['a.ts'] }
      2. ssp.attach(mockProjector, mockSerializer)
      3. Assert serializer.append called with correct payload
      4. Serialize to JSON, restore via SSPFactory.fromJSON
      5. Assert restored SSP has permission='edit' and patterns=['a.ts']
    Expected Result: Permission request persisted losslessly
    Evidence: .sisyphus/evidence/task-12-permission-record.txt

  Scenario: Question asked persisted and recoverable
    Tool: bash (bun test)
    Steps:
      1. Create InteractionRequestSSP with question data (question, header, options)
      2. Persist and restore via JSON round-trip
      3. Assert question text, header, options preserved
    Expected Result: Question metadata preserved through save/restore
    Evidence: .sisyphus/evidence/task-12-question-record.txt
  ```

  **Commit**: YES (Wave 2)
  - Message: `feat(ssp): add InteractionRequestSSP and InteractionResponseSSP`
  - Files: `src/acp/ssp/impl/interaction.ts`, `src/test/ssp/interaction.test.ts`

- [x] 13. **RawAcpEventSSP (无损兜底)**

  **What to do**:
  - 创建 `src/acp/ssp/impl/raw-acp-event.ts`：`RawAcpEventSSP extends SerializableStreamPart<'rawAcpEvent', ...>`
  - 兜底所有未识别的 AcpEvent 类型，确保不丢失任何数据
  - `merge(delta)`: 替换整个 payload.event
  - `render(p)`: no-op（无法预知如何渲染未知事件）
  - 测试：任意 event 可持久化和恢复

  **Must NOT do**: 不尝试智能渲染未知事件

  **Recommended Agent Profile**:
  - **Category**: `quick`
  - **Skills**: `[]`

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 2 (with T6-T12)
  - **Blocks**: T17-Bridge (default case 路由到 RawAcpEventSSP)
  - **Blocked By**: T1

  **Acceptance Criteria**:
  - [ ] 任意 unknown event 类型走 RawAcpEventSSP 无损存储
  - [ ] `bun test src/test/ssp/raw-acp-event.test.ts` → PASS

  **QA Scenarios**:
  ```
  Scenario: Unknown event type preserved losslessly
    Tool: bash (bun test)
    Steps:
      1. Create RawAcpEventSSP with { event: { type: 'custom.novel.event', data: 42 } }
      2. ssp.attach(mockProjector, mockSerializer)
      3. Assert mockProjector.render NOT called (no-op)
      4. Assert mockSerializer.append called with rawAcpEvent payload
      5. Serialize to JSON, restore via SSPFactory.fromJSON
      6. Assert restored event has type='custom.novel.event' and data=42
    Expected Result: Completely unknown event preserved through save/restore cycle
    Evidence: .sisyphus/evidence/task-13-raw-fallback.txt
  ```

  **Commit**: YES (Wave 2)
  - Message: `feat(ssp): add RawAcpEventSSP fallback`
  - Files: `src/acp/ssp/impl/raw-acp-event.ts`, `src/test/ssp/raw-acp-event.test.ts`

- [x] 14. **VSCSPProjector (capabilities-aware rendering)**

  **What to do**:
  - 创建 `src/acp/projector/vscsp.ts`：`VSCSPProjector implements Projector`
  - 构造时接收 `vscode.ChatResponseStream` + runtime capabilities 检测
  - 实现所有 Projector 方法：
    - `markdown(content)`: `stream.markdown(content)`
    - `thinkingProgress(content)`: 检测 `hasThinkingProgress` → 调用 proposed API 或降级 markdown
    - `beginToolInvocation(callId, name, data)`: 检测 `hasToolUI` → proposed API 或 markdown fallback
    - `updateToolInvocation(callId, data)`: `stream.updateToolInvocation?.()`
    - `completeToolInvocation(callId, result)`: push final card + result
    - `errorToolInvocation(callId, error)`: error card
    - `beginExternalEdit(callId)`: push `ExternalEditPart(start=true)`
    - `endExternalEdit(callId, editId)`: push `ExternalEditPart(start=false)`
    - `pushToolSpecificData(callId, toolName, data)`: 映射到 6 种 VSCode 类型（ChatToolResourcesInvocationData, ChatTerminalToolInvocationData, ChatSimpleToolResultData, ChatSubagentToolInvocationData, ChatTodoToolInvocationData, generic fallback）
    - `pushToolInvocationFallback(callId, toolName, state)`: markdown fallback 渲染
    - `updateSubagentCard(sessionId, scope)`: push + update 子代理卡片
    - `pushFinalSubagentUpdate(sessionId, scope)`: 终态
    - `progress(message)` / `reference(uri)` / `finalize()`
  - 复用现有 `capabilities.ts` 进行 proposed API 检测
  - 从现有 `opencode-bridge.ts` 提取 toolSpecificData 映射逻辑（6 种工具类型）
  - 从现有 `opencode-bridge.ts` 提取子代理渲染逻辑（pushFinalSubagentUpdate / updateSubagentCard）
  - **注意**：VSCSPProjector 是唯一 import VSCode 的文件，隔离所有 VSCode 依赖
  - 测试：capabilities 降级测试；6 种 toolSpecificData 映射测试

  **Must NOT do**:
  - 不在 Projector 中做 wire protocol 相关逻辑
  - 不导入 `subagent.ts`（子代理格式化移到 Projector 内部）

  **Recommended Agent Profile**:
  - **Category**: `deep` — 复杂的 rendering + capabilities + toolSpecificData 映射
  - **Skills**: `[]`

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 3 (with T15, T16)
  - **Blocks**: T17-Bridge (bridge.setStream → Projector.attach)
  - **Blocked By**: T2 (Projector 接口), T6-T13 (需要完整的 SSP 类型理解)

  **Acceptance Criteria**:
  - [ ] VSCSPProjector 实现全部 Projector 方法
  - [ ] capabilities 降级：无 proposed API 时 fallback 到 markdown
  - [ ] 6 种 toolSpecificData 映射正确
  - [ ] 子代理卡片 push + update + finalize 正确
  - [ ] `bun test src/test/projector/vscsp.test.ts` → PASS (≥20 tests)

  **QA Scenarios**:
  ```
  Scenario: Tool invocation with proposed API available
    Tool: bash (bun test)
    Steps:
      1. Create VSCSPProjector with mock stream (hasToolUI=true)
      2. Call beginToolInvocation('call_1', 'read', { status:'pending', input:{file:'a.ts'} })
      3. Assert stream.beginToolInvocation called
      4. Call pushToolSpecificData('call_1', 'read', { resources:['a.ts'] })
      5. Assert ChatToolResourcesInvocationData pushed
    Expected Result: Proposed API path taken, tool card with file reference
    Evidence: .sisyphus/evidence/task-14-tool-proposed.txt

  Scenario: Tool invocation without proposed API (fallback)
    Tool: bash (bun test)
    Steps:
      1. Create VSCSPProjector with mock stream (hasToolUI=false)
      2. Call beginToolInvocation('call_1', 'read', ...)
      3. Assert stream.markdown called with tool name fallback
    Expected Result: Markdown fallback when proposed API absent
    Evidence: .sisyphus/evidence/task-14-tool-fallback.txt
  ```

  **Commit**: YES (Wave 3)
  - Message: `feat(projector): add VSCSPProjector with capabilities-aware rendering`
  - Files: `src/acp/projector/vscsp.ts`, `src/test/projector/vscsp.test.ts`

- [x] 15. **CollectorProjector (恢复用)**

  **What to do**:
  - 创建 `src/acp/projector/collector.ts`：`CollectorProjector implements Projector`
  - 捕获所有渲染调用到内部数组，供会话恢复时重建 `ChatRequestTurn` / `ChatResponseTurn`
  - 复用现有 `CollectorStream`（`src/acp/streaming/collector-stream.ts`）作为底层，在其上包装 Projector 接口
  - 每个 Projector 方法将调用映射到 `CollectorStream` 方法
  - 测试：捕获后 `buildTurn()` 产出正确的 chat parts

  **Must NOT do**:
  - 不直接 import VSCode types（通过 CollectorStream 间接使用）

  **Recommended Agent Profile**:
  - **Category**: `quick` — 包装现有 CollectorStream
  - **Skills**: `[]`

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 3 (with T14, T16)
  - **Blocks**: None directly
  - **Blocked By**: T2 (Projector 接口)

  **Acceptance Criteria**:
  - [ ] CollectorProjector 实现全部 Projector 方法
  - [ ] `buildTurn()` 产出 `ChatRequestTurn` / `ChatResponseTurn`
  - [ ] `bun test src/test/projector/collector.test.ts` → PASS

  **QA Scenarios**:
  ```
  Scenario: CollectorProjector builds correct turns from mixed events
    Tool: bash (bun test)
    Steps:
      1. Create CollectorProjector
      2. Feed sequence: markdown('Hello'), beginToolInvocation('c1','read'), completeToolInvocation('c1'), markdown('Done'), session.idle
      3. Call buildTurn()
      4. Assert ChatRequestTurn has correct prompt
      5. Assert ChatResponseTurn parts: [ToolInvocationPart, MarkdownPart, MarkdownPart]
      6. Verify tool part has toolInvocationId='c1', name='read'
    Expected Result: Mixed event sequence produces correct ChatTurn structure
    Evidence: .sisyphus/evidence/task-15-collector-turn.txt
  ```

  **Commit**: YES (Wave 3)
  - Message: `feat(projector): add CollectorProjector for session restore`
  - Files: `src/acp/projector/collector.ts`, `src/test/projector/collector.test.ts`

- [x] 16. **Projector toolSpecificData mapping (从 Bridge 提取)**

  **What to do**:
  - 从现有 `opencode-bridge.ts` 提取 toolSpecificData 映射逻辑到 `src/acp/projector/tool-data.ts`
    - `mapReadToolData(resources)` → `ChatToolResourcesInvocationData`
    - `mapBashToolData(exitCode, output)` → `ChatTerminalToolInvocationData`
    - `mapWriteToolData(resources)` → `ChatToolResourcesInvocationData`
    - `mapEditToolData(resources)` → `ChatToolResourcesInvocationData`
    - `mapListGrepToolData(output)` → `ChatSimpleToolResultData`
    - `mapTaskToolData(description, agentName, prompt, result)` → `ChatSubagentToolInvocationData`
    - `mapGenericToolData(output)` → `ChatSimpleToolResultData`
  - 这些函数被 VSCSPProjector 的 `pushToolSpecificData()` 调用
  - 测试：每种工具类型映射正确

  **Must NOT do**: 不保留对 bridge 的引用

  **Recommended Agent Profile**:
  - **Category**: `unspecified-low` — 提取和迁移现有逻辑
  - **Skills**: `[]`

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 3 (with T14, T15)
  - **Blocks**: T14-VSCSPProjector（VSCSPProjector 依赖此映射）
  - **Blocked By**: T2

  **Acceptance Criteria**:
  - [ ] 6 种工具映射函数正确
  - [ ] `bun test src/test/projector/tool-data.test.ts` → PASS

  **QA Scenarios**:
  ```
  Scenario: All 7 tool types map to correct toolSpecificData
    Tool: bash (bun test)
    Steps:
      1. Call mapReadToolData([{uri:'file:///a.ts', name:'a.ts'}])
         → Assert instance of ChatToolResourcesInvocationData, has 1 resource
      2. Call mapBashToolData(0, 'hello world')
         → Assert instance of ChatTerminalToolInvocationData, exitCode=0, output='hello world'
      3. Call mapWriteToolData([{uri:'file:///b.ts', name:'b.ts'}])
         → Assert instance of ChatToolResourcesInvocationData, has 1 resource
      4. Call mapEditToolData([{uri:'file:///c.ts', name:'c.ts'}])
         → Assert instance of ChatToolResourcesInvocationData, has 1 resource
      5. Call mapListGrepToolData('10 files found')
         → Assert instance of ChatSimpleToolResultData, has output string
      6. Call mapTaskToolData('explore', 'explore-1', 'find X', 'found 3 files')
         → Assert instance of ChatSubagentToolInvocationData, has agentName='explore-1'
      7. Call mapGenericToolData('ok')
         → Assert instance of ChatSimpleToolResultData, has output='ok'
    Expected Result: All 7 tool type mappings produce correct VSCode types
    Evidence: .sisyphus/evidence/task-16-tool-data-mapping.txt
  ```

  **Commit**: YES (Wave 3)
  - Message: `refactor(projector): extract toolSpecificData mapping from bridge`
  - Files: `src/acp/projector/tool-data.ts`, `src/test/projector/tool-data.test.ts`

- [x] 17. **Bridge rewrite: 路由 + 子代理管理**

  **What to do**:
  - 重写 `src/backends/opencode/opencode-bridge.ts`（2001行 → 目标 ~200行）
  - 保留的逻辑：
    - `ssps: Map<string, SerializableStreamPart>` — SSP 注册表
    - `processEvent(event)` — 事件路由（switch/case）
    - `permission.asked (edit)` → auto-approve + 创建 ExternalEditSSP
    - `file.edited` / `session.diff` → 路由到 ExternalEditSSP
    - **deferred idle**: 保留子代理忙检测逻辑，使用 SubagentSSP 的 `hasBusyDescendant()`
    - `getUserMessageId()` / `getSessionTitle()` / `getHadSubagentTasks()` — 从 SSP Map 查询
  - 移除的逻辑（迁移到 SSP + Projector）：
    - 所有 `stream.markdown()` / `stream.thinkingProgress()` 等渲染调用
    - `partKinds` Map（移到 ToolInvocationSSP/AssistantTextSSP 内部）
    - `toolMetas` Map（移到 ToolInvocationSSP）
    - `progressivePushed` Set（移到 ToolInvocationSSP._renderedCallIds）
    - `externalEditCallIds` Set（移到 ExternalEditSSP）
    - `activeSubagentScopes` Map（移到 SubagentSSP）
    - `toolSpecificData` 映射（移到 projector/tool-data.ts）
  - 新增：`setProjector(projector, serializer)` — 注入 Projector + SessionSerializer
  - 事件路由表（每种 AcpEvent 类型 → 对应的 SSP action）：

  | AcpEvent | SSP action |
  |----------|-----------|
  | `part.updated` | `map.get(part.id) ?? create(part)` → `ssp.update(part)` |
  | `part.delta` | `map.get(partId).applyDelta(delta)` |
  | `permission.asked (edit)` | `new ExternalEditSSP` → `beginEdit()` → `reply('once')` |
  | `permission.asked (other)` | `new InteractionRequestSSP` → `update()` |
  | `permission.replied` | `new InteractionResponseSSP` → `update()` |
  | `file.edited` | `findEditSSPByFile(file)` → `completeEdit()` |
  | `session.diff` | `findEditSSPByFile(file)` → `update(diff)` + `new SessionDiffSSP` |
  | `session.created/updated/deleted/error` | `new SessionLifecycleSSP` → `update()` |
  | `session.idle` | deferred idle check → `projector.finalize()` |
  | `session.status` | `new SessionLifecycleSSP` → `update()` |
  | `server.connected/heartbeat` | `new SessionLifecycleSSP` → `update()` |
  | `question.asked/replied/rejected` | `new InteractionRequestSSP` / `InteractionResponseSSP` |
  | `default` | `new RawAcpEventSSP` → `update()` |

  - 测试：事件路由正确；auto-approve 正确；deferred idle 正确

  **Must NOT do**:
  - 不在 Bridge 中做任何渲染（markdown/thinkingProgress/beginToolInvocation 等）
  - 不在 Bridge 中直接调 `stream.*` 方法

  **Recommended Agent Profile**:
  - **Category**: `deep` — 复杂的重构，影响核心管线
  - **Skills**: `[]`

  **Parallelization**:
  - **Can Run In Parallel**: NO
  - **Parallel Group**: Wave 4 (sequential with T18, T19, T20, T21)
  - **Blocks**: T22-T26 (测试依赖新 Bridge)
  - **Blocked By**: T1-T16 (all SSP + Projector + Serializer)

  **Acceptance Criteria**:
  - [ ] `processEvent(part.updated)` 创建/查找 ToolInvocationSSP 并调 `update()`
  - [ ] `processEvent(permission.asked edit)` 创建 ExternalEditSSP + auto-approve
  - [ ] `processEvent(file.edited)` 路由到 ExternalEditSSP.completeEdit
  - [ ] deferred idle 正确等待子代理完成，超时保护 120s
  - [ ] `getUserMessageId()` 从 SSP Map 查询正确
  - [ ] Bridge 中无任何 `stream.markdown` / `stream.thinkingProgress` 调用
  - [ ] `bun test src/test/opencode-bridge.test.ts` → PASS (≥15 tests)

  **QA Scenarios**:
  ```
  Scenario: Full tool lifecycle routed through SSP
    Tool: bash (bun test)
    Steps:
      1. Create Bridge with mock Projector and Serializer
      2. bridge.processEvent({ type:'part.updated', part:{ type:'tool', id:'p1', toolName:'read', ... }})
      3. Assert ToolInvocationSSP created and attached
      4. bridge.processEvent({ type:'part.delta', partId:'p1', delta:'file.ts' })
      5. bridge.processEvent({ type:'part.updated', part:{ type:'tool', id:'p1', state:{ status:'completed' }}})
      6. Assert projector.completeToolInvocation called
    Expected Result: All events routed to same SSP, rendering driven by SSP
    Evidence: .sisyphus/evidence/task-17-bridge-tool-route.txt

  Scenario: Edit permission auto-approve flow
    Tool: bash (bun test)
    Steps:
      1. bridge.processEvent({ type:'permission.asked', permission:'edit', tool:{ callId:'c1' }, sessionId:'s1', permissionId:'p1', patterns:['a.ts'] })
      2. Assert ExternalEditSSP created with beginEdit called
      3. Assert projector.beginExternalEdit called
      4. Assert permissions.reply called with 'once'
    Expected Result: Auto-approve edit, begin external edit tracking
    Evidence: .sisyphus/evidence/task-17-bridge-edit-autoapprove.txt
  ```

  **Commit**: YES (Wave 4)
  - Message: `refactor(bridge): rewrite as thin event router with SSP delegation`
  - Files: `src/backends/opencode/opencode-bridge.ts`, `src/test/opencode-bridge.test.ts`

- [x] 18. **Handler cleanup: 移除 ExternalEditTracker 耦合**

  **What to do**:
  - 修改 `src/participant/handler.ts`（L830-858 区域）
  - 移除 `ExternalEditTracker` 的创建和注入
  - 移除 `sessionStream` 的直接引用（持久化由 SSP 自管理）
  - 简化 Bridge 初始化逻辑：
    ```
    旧: tracker = new ExternalEditTracker(...)
        bridge.setTracker(tracker)
        bridge.setCallbacks(sessionStream)
        bridge.setStream(stream)
    
    新: bridge.setProjector(
          new VSCSPProjector(stream, caps),
          new JSONLSessionSerializer(sessionDir)
        )
        bridge.initializeEditSync(directory)
    ```
  - 保留续写逻辑（subagent task 完成后发送 continuation prompt）
  - 测试：handler 重构后功能完整

  **Must NOT do**:
  - 不移除续写循环逻辑（`while (needsContinue)`）
  - 不移除 `bridge.run()` 调用方式

  **Recommended Agent Profile**:
  - **Category**: `deep` — 核心管线重构
  - **Skills**: `[]`

  **Parallelization**:
  - **Can Run In Parallel**: YES (with T19, T21)
  - **Parallel Group**: Wave 4 (after T17)
  - **Blocks**: T22 (handler.test.ts 更新)
  - **Blocked By**: T17

  **Acceptance Criteria**:
  - [ ] handler.ts 无 `ExternalEditTracker` import
  - [ ] handler.ts 无 `sessionStream.setCallbacks` 调用
  - [ ] `bridge.setProjector()` 一次性注入 Projector + Serializer
  - [ ] `bun test src/test/handler.test.ts` → PASS (41 tests 更新后通过)

  **QA Scenarios**:
  ```
  Scenario: Handler creates bridge with SSP-based setup
    Tool: bash (bun test)
    Steps:
      1. Mock backend.createBridge() returns new Bridge
      2. Run handler with sample request
      3. Assert bridge.setProjector called with VSCSPProjector + JSONLSessionSerializer
      4. Assert bridge.initializeEditSync called with directory
      5. Assert no ExternalEditTracker created
    Expected Result: Clean SSP-based initialization, no legacy tracker
    Evidence: .sisyphus/evidence/task-18-handler-clean.txt
  ```

  **Commit**: YES (Wave 4)
  - Message: `refactor(handler): remove ExternalEditTracker, use SSP projector`
  - Files: `src/participant/handler.ts`

- [x] 19. **Extension + Server cleanup: 移除 opencode.json 写入**

  **What to do**:
  - 从 `src/extension.ts` 移除 `ensureOpencodeConfig()` 相关逻辑
  - 从 `src/backends/opencode/server.ts` 移除 `ensureOpencodeConfig()` 调用和函数定义
  - Permission 初始化下沉到 Bridge 的 `initializeEditSync()`：
    ```typescript
    // Bridge 内部
    initializeEditSync(directory: string): void {
      ensureOpencodeConfig(directory);  // 确保 permission.edit="ask"
    }
    ```
  - 为未来扩展预留 ACP 接口：`AcpPermissionInit.initializeEditSync(sessionId, directory)`
  - 测试：extension 激活不再写 opencode.json

  **Must NOT do**:
  - 不删除 `ensureOpencodeConfig()` 函数本身（移到 Bridge 内部）
  - 不删除现有 `opencode.json` 内容（保留用户配置）

  **Recommended Agent Profile**:
  - **Category**: `quick`
  - **Skills**: `[]`

  **Parallelization**:
  - **Can Run In Parallel**: YES (with T18, T21)
  - **Parallel Group**: Wave 4 (after T17)
  - **Blocks**: None directly
  - **Blocked By**: T17

  **Acceptance Criteria**:
  - [ ] `extension.ts` 无 `ensureOpencodeConfig` 调用
  - [ ] `server.ts` 无 `ensureOpencodeConfig` 函数
  - [ ] `bridge.initializeEditSync()` 负责写 opencode.json
  - [ ] `bun test src/test/extension.test.ts` → PASS

  **QA Scenarios**:
  ```
  Scenario: Extension activation does not write opencode.json
    Tool: bash (bun test)
    Steps:
      1. Mock VSCode extension context
      2. Call activate(context) from extension.ts
      3. Assert fs.writeFileSync NOT called for opencode.json
      4. Assert ensureOpencodeConfig NOT imported from extension.ts
      5. Grep source: extension.ts has zero references to 'ensureOpencodeConfig'
    Expected Result: Permission initialization deferred to Bridge
    Evidence: .sisyphus/evidence/task-19-ext-no-config-write.txt
  ```

  **Commit**: YES (Wave 4)
  - Message: `refactor: move permission init from extension to bridge`
  - Files: `src/extension.ts`, `src/backends/opencode/server.ts`, `src/backends/opencode/opencode-bridge.ts`

- [x] 20. **Adapter 对接新 Bridge + SSP 管线**

  **What to do**:
  - 修改 `src/backends/opencode/adapter.ts`
  - `createBridge()` 改为创建新的瘦身 Bridge（注入 Projector + Serializer）
  - 确保 `events.openSessionStream()` 产出 `AsyncIterable<AcpEvent>` 保持不变
  - 确保 `permissions.reply()` 在 Bridge auto-approve 时可用
  - `AcpBackend` 接口中对应的类型调整
  - 测试：adapter.createBridge 返回正确类型

  **Must NOT do**: 不改变 NormalizingEventStream 逻辑

  **Recommended Agent Profile**:
  - **Category**: `quick`
  - **Skills**: `[]`

  **Parallelization**:
  - **Can Run In Parallel**: YES (with T18, T19, T21)
  - **Parallel Group**: Wave 4 (after T17)
  - **Blocks**: None directly
  - **Blocked By**: T17

  **Acceptance Criteria**:
  - [ ] `createBridge(sessionId, directory, knownFileUris)` 返回新 Bridge + 注入 Projector
  - [ ] `bun test src/test/opencode-adapter.test.ts` → PASS

  **QA Scenarios**:
  ```
  Scenario: Adapter creates new slim Bridge with SSP projector
    Tool: bash (bun test)
    Steps:
      1. Call adapter.createBridge(sessionId, directory, knownFileUris)
      2. Assert returned bridge instance has setProjector method (new API)
      3. Assert returned bridge does NOT have setCallbacks/setStream/setTracker (old API)
      4. Assert bridge.initializeEditSync method exists
      5. Call bridge.setProjector(mockProjector, mockSerializer)
      6. Assert bridge internals store projector and serializer references
    Expected Result: Adapter wires new Bridge with SSP-based API
    Evidence: .sisyphus/evidence/task-20-adapter-new-bridge.txt
  ```

  **Commit**: YES (Wave 4)
  - Message: `refactor(adapter): wire new bridge with SSP projector`
  - Files: `src/backends/opencode/adapter.ts`

- [x] 21. **Remove external-edit-tracker.ts**

  **What to do**:
  - 删除 `src/participant/external-edit-tracker.ts`
  - 清理所有对 `ExternalEditTracker` 的 import
  - 功能完全由 `ExternalEditSSP` + `bridge.processEvent(permission.asked)` 替代
  - 更新 `src/acp/backend.ts` 中 `AcpBridge.setTracker()` 签名或移除

  **Must NOT do**:
  - 不删除 checkpoint 捕获逻辑（由 ExternalEditSSP 内部通过 `onSnapshot` 间接处理）

  **Recommended Agent Profile**:
  - **Category**: `quick`
  - **Skills**: `[]`

  **Parallelization**:
  - **Can Run In Parallel**: YES (with T18, T19, T20)
  - **Parallel Group**: Wave 4 (after T17)
  - **Blocks**: T24 (checkpoint tests 需要更新)
  - **Blocked By**: T17, T18

  **Acceptance Criteria**:
  - [ ] `src/participant/external-edit-tracker.ts` 已删除
  - [ ] `tsc --noEmit` 零错误（无遗留 import）
  - [ ] `grep ExternalEditTracker src/` 零匹配

  **QA Scenarios**:
  ```
  Scenario: ExternalEditTracker completely removed
    Tool: bash (grep + tsc)
    Steps:
      1. Assert file src/participant/external-edit-tracker.ts does not exist
      2. Grep src/ for 'ExternalEditTracker' → zero matches
      3. Grep src/ for 'external-edit-tracker' → zero matches
      4. Grep src/ for 'setTracker' → zero matches (AcpBridge interface cleaned)
      5. Run tsc --noEmit → zero errors
    Expected Result: Complete removal with no dangling references
    Evidence: .sisyphus/evidence/task-21-tracker-removed.txt
  ```

  **Commit**: YES (Wave 4)
  - Message: `refactor: remove ExternalEditTracker (superseded by ExternalEditSSP)`
  - Files: `src/participant/external-edit-tracker.ts` (deleted), `src/participant/handler.ts`

- [x] 22. **Update handler.test.ts + streaming.test.ts**

  **What to do**:
  - 更新 `src/test/handler.test.ts`（41 tests）：Mock `backend.createBridge()` 返回新 Bridge 实例，mock `bridge.setProjector()` 替代 `bridge.setStream/setCallbacks/setTracker`，移除 ExternalEditTracker 相关 mock
  - 更新 `src/test/streaming.test.ts`（43 tests）：替换旧 Bridge mock 为新 Bridge + SSP + Projector，mock 所有 Projector 方法
  - 确保全部 84 tests PASS

  **Must NOT do**: 不改变测试的业务逻辑语义

  **Recommended Agent Profile**: **Category**: `deep` | **Skills**: `[]`

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 5 (with T23, T24, T25, T26)
  - **Blocked By**: T17, T18

  **Acceptance Criteria**:
  - [ ] `bun test src/test/handler.test.ts` → PASS (41/41)
  - [ ] `bun test src/test/streaming.test.ts` → PASS (43/43)
  - [ ] 无 `ExternalEditTracker`/`setCallbacks`/`setTracker` 引用

  **QA Scenarios**:
  ```
  Scenario: Handler creates bridge with SSP-based setup
    Tool: bash (bun test)
    Steps:
      1. Mock backend.createBridge() returns new Bridge
      2. Run handler with sample request "read package.json"
      3. Assert bridge.setProjector called with VSCSPProjector + JSONLSessionSerializer
      4. Assert bridge.initializeEditSync called with directory
      5. Assert no ExternalEditTracker created
    Expected Result: Clean SSP-based initialization, no legacy tracker
    Evidence: .sisyphus/evidence/task-22-handler-clean.txt
  ```

  **Commit**: YES (Wave 5)
  - Message: `test: update handler and streaming tests for SSP v2`
  - Files: `src/test/handler.test.ts`, `src/test/streaming.test.ts`

- [x] 23. **Update bridge-related tests (streaming + replay + e2e)**

  **What to do**:
  - 更新 `src/test/streaming/handler-restore-integration.test.ts`（13 tests）：替换 `createBridge(collector)` 为 CollectorProjector 模式
  - 更新 `src/test/streaming/event-replay-integration.test.ts`（9 tests）：对接新 SSP 管线
  - 更新 `src/test/streaming/e2e-backend-serialize.test.ts`（3 tests）：对接新序列化管线
  - 更新 `src/test/commands.test.ts`（11 tests）：更新 bridge mock
  - 更新 `src/test/opencode-bridge.test.ts`（>15 tests）：旧测试重写为新 Bridge 路由测试
  - **总计 ~51 tests 更新**

  **Must NOT do**: 不改变测试场景语义

  **Recommended Agent Profile**: **Category**: `deep` | **Skills**: `[]`

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 5 (with T22, T24, T25, T26)
  - **Blocked By**: T14, T15, T17

  **Acceptance Criteria**:
  - [ ] `bun test src/test/streaming/*.test.ts` → ALL PASS
  - [ ] `bun test src/test/commands.test.ts` → PASS
  - [ ] `bun test src/test/opencode-bridge.test.ts` → PASS

  **QA Scenarios**:
  ```
  Scenario: Session restore via CollectorProjector
    Tool: bash (bun test)
    Steps:
      1. Create Bridge with CollectorProjector
      2. Replay a sequence of ACP events (text + tool + session.idle)
      3. Call collectorProjector.buildTurn()
      4. Assert ChatRequestTurn/ChatResponseTurn have correct parts
    Expected Result: Restored turn has markdown + tool card parts
    Evidence: .sisyphus/evidence/task-23-restore-collector.txt
  ```

  **Commit**: YES (Wave 5)
  - Message: `test: update streaming/replay/bridge tests for SSP v2`
  - Files: `src/test/streaming/*.test.ts`, `src/test/commands.test.ts`, `src/test/opencode-bridge.test.ts`

- [x] 24. **Update checkpoint/replay tests + remove ExternalEditTracker tests**

  **What to do**:
  - 更新 `src/test/checkpoint/replay.test.ts`（43 tests）：移除 ExternalEditTracker 依赖，对接 ExternalEditSSP
  - 更新 `src/test/checkpoint/checkpoint-store.test.ts`（10 tests）：确保 checkpoint 逻辑不受影响
  - 删除 `src/test/external-edit-tracker.test.ts`（9 tests）— 功能已被 ExternalEditSSP 测试覆盖
  - 更新 `src/test/experimental-session.test.ts`（15 tests）：更新 bridge mock
  - **总计 ~77 tests 更新/删除**

  **Must NOT do**: 不删除 checkpoint 功能本身

  **Recommended Agent Profile**: **Category**: `deep` | **Skills**: `[]`

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 5 (with T22, T23, T25, T26)
  - **Blocked By**: T17, T21

  **Acceptance Criteria**:
  - [ ] `bun test src/test/checkpoint/replay.test.ts` → PASS
  - [ ] `src/test/external-edit-tracker.test.ts` 已删除
  - [ ] `bun test src/test/experimental-session.test.ts` → PASS
  - [ ] `tsc --noEmit` 零错误

  **QA Scenarios**:
  ```
  Scenario: Checkpoint replay works with ExternalEditSSP
    Tool: bash (bun test)
    Steps:
      1. Create ExternalEditSSP with beginEdit + completeEdit lifecycle
      2. Persist to JSONL via SessionSerializer
      3. Restore from JSONL via SSPFactory.fromJSON
      4. Verify restored SSP has toolCallId, editId, uri
      5. Run checkpoint replay with restored SSP metadata
      6. Assert undo stop IDs available for reconstruction
    Expected Result: Edit metadata preserved through save/restore cycle
    Evidence: .sisyphus/evidence/task-24-checkpoint-edit.txt
  ```

  **Commit**: YES (Wave 5)
  - Message: `test: update checkpoint tests, remove external-edit-tracker tests`
  - Files: `src/test/checkpoint/*.test.ts`, delete `src/test/external-edit-tracker.test.ts`, `src/test/experimental-session.test.ts`

- [x] 25. **New SSP unit tests (all 8 types)**

  **What to do**:
  - 为每个新 SSP 类型创建独立单元测试：
    - `src/test/ssp/tool-invocation.test.ts` — 状态流转 pending→running→completed + 投影
    - `src/test/ssp/assistant-text.test.ts` — 增量累积 + markdown 投影
    - `src/test/ssp/reasoning.test.ts` — 增量累积 + thinkingProgress 投影
    - `src/test/ssp/external-edit.test.ts` — 完整 pre-edit→post-edit 生命周期
    - `src/test/ssp/subagent.test.ts` — 子代理层级 + hasBusyDescendant
    - `src/test/ssp/session-lifecycle.test.ts` — 会话状态记录
    - `src/test/ssp/session-diff.test.ts` — diff 累积
    - `src/test/ssp/interaction.test.ts` — 权限/问题记录
    - `src/test/ssp/raw-acp-event.test.ts` — 兜底无损
  - 所有测试使用 mock Projector + mock Serializer（不 mock VSCode）
  - **目标：每类 ≥5 tests，总计 ≥45 tests**

  **Must NOT do**: 不在新测试中 mock VSCode

  **Recommended Agent Profile**: **Category**: `deep` | **Skills**: `[]`

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 5 (with T22, T23, T24, T26)
  - **Blocked By**: T1-T13 (all SSP implementations)

  **Acceptance Criteria**:
  - [ ] `bun test src/test/ssp/` → PASS（≥45 tests）
  - [ ] 所有 SSP 类型有独立测试文件

  **QA Scenarios**:
  ```
  Scenario: All SSP types covered by unit tests
    Tool: bash (bun test src/test/ssp/)
    Steps:
      1. Run all SSP tests
      2. Verify 9 test files executed
      3. Verify each file has ≥5 tests
    Expected Result: ≥45 tests pass, 0 fail
    Evidence: .sisyphus/evidence/task-25-ssp-tests.txt
  ```

  **Commit**: YES (Wave 5)
  - Message: `test: add comprehensive SSP unit tests`
  - Files: `src/test/ssp/*.test.ts`

- [x] 26. **New Projector tests + integration e2e**

  **What to do**:
  - `src/test/projector/vscsp.test.ts` — capabilities 降级矩阵（≥20 tests）
  - `src/test/projector/collector.test.ts` — 恢复投影（≥5 tests）
  - `src/test/projector/tool-data.test.ts` — 6 种工具映射（≥12 tests）
  - `src/test/projector/projector-integration.test.ts` — end-to-end: AcpEvent → SSP → VSCSP → chat parts（≥5 tests）
  - **目标：≥42 tests**

  **Must NOT do**: 不在集成测试中启动真实 OpenCode server

  **Recommended Agent Profile**: **Category**: `deep` | **Skills**: `[]`

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 5 (with T22, T23, T24, T25)
  - **Blocked By**: T14, T15, T16

  **Acceptance Criteria**:
  - [ ] `bun test src/test/projector/` → PASS（≥42 tests）
  - [ ] E2E 测试：完整管线正确产出 chat parts

  **QA Scenarios**:
  ```
  Scenario: Full pipeline integration
    Tool: bash (bun test src/test/projector/projector-integration.test.ts)
    Steps:
      1. Create Bridge with VSCSPProjector + JSONLSessionSerializer
      2. Feed sequence: part.updated(text 'hello') → part.delta(' world') → session.idle
      3. Assert VSCSPProjector received markdown('hello') then markdown(' world')
      4. Assert JSONL file contains 2+ valid stream-part records
    Expected Result: Full pipeline works end-to-end, both rendering and persistence
    Evidence: .sisyphus/evidence/task-26-e2e.txt
  ```

  **Commit**: YES (Wave 5)
  - Message: `test: add projector tests and integration e2e`
  - Files: `src/test/projector/*.test.ts`

---

## Final Verification Wave (MANDATORY — after ALL implementation tasks)

> 4 review agents run in PARALLEL. ALL must APPROVE. Present consolidated results to user and get explicit "okay" before completing.

- [x] F1. **Plan Compliance Audit** — `oracle`
  Read the plan end-to-end. For each "Must Have": verify implementation exists. For each "Must NOT Have": search codebase for forbidden patterns. Check evidence files exist in `.sisyphus/evidence/`. Compare deliverables against plan.
  Output: `Must Have [N/N] | Must NOT Have [N/N] | Tasks [N/N] | VERDICT: APPROVE/REJECT`

- [x] F2. **Code Quality Review** — `unspecified-high`
  Run `tsc --noEmit` + `bun test`. Review all changed files for: `as any`/`@ts-ignore`, empty catches, console.log in prod, commented-out code, unused imports. Check AI slop.
  Output: `Build [PASS/FAIL] | Tests [N pass/N fail] | Files [N clean/N issues] | VERDICT`

- [x] F3. **Real Manual QA** — `unspecified-high` (+ `playwright` skill if UI)
  Start from clean state. Execute EVERY QA scenario from EVERY task. Test cross-task integration. Test edge cases: empty state, invalid input, rapid actions. Save to `.sisyphus/evidence/final-qa/`.
  Output: `Scenarios [N/N pass] | Integration [N/N] | Edge Cases [N tested] | VERDICT`

- [x] F4. **Scope Fidelity Check** — `deep`
  For each task: read "What to do", read actual diff. Verify 1:1 — everything in spec was built, nothing beyond spec. Check "Must NOT do" compliance. Detect cross-task contamination.
  Output: `Tasks [N/N compliant] | Contamination [CLEAN/N issues] | Unaccounted [CLEAN/N files] | VERDICT`

---

## Commit Strategy

- **Wave 1**: `feat(ssp): add base class, projector interface, serializer` — T1-T5
- **Wave 2**: `feat(ssp): implement concrete SSP types` — T6-T13
- **Wave 3**: `feat(projector): VSCSP and collector projectors` — T14-T16
- **Wave 4**: `refactor(bridge): rewrite as thin router` — T17-T21
- **Wave 5**: `test: update tests for SSP v2 architecture` — T22-T26

---

---

## Final Verification Wave (MANDATORY — after ALL implementation tasks)

> 4 review agents run in PARALLEL. ALL must APPROVE. Present consolidated results to user and get explicit "okay" before completing.
>
> **Do NOT auto-proceed after verification. Wait for user's explicit approval before marking work complete.**

- [x] **F1. Plan Compliance Audit** — `oracle`
  Read the plan end-to-end. For each "Must Have": verify implementation exists (read file, grep pattern). For each "Must NOT Have": search codebase for forbidden patterns — reject with file:line if found. Check evidence files exist in `.sisyphus/evidence/`. Compare deliverables against plan.
  Key checks: Bridge file has no `stream.markdown`/`stream.thinkingProgress` calls; `extension.ts` has no `ensureOpencodeConfig`; `external-edit-tracker.ts` deleted; all 8 SSP types have tests.
  Output: `Must Have [N/N] | Must NOT Have [N/N] | Tasks [N/N] | VERDICT: APPROVE/REJECT`

- [x] **F2. Code Quality Review** — `unspecified-high`
  Run `tsc --noEmit` + `bun test`. Review all changed files for: `as any`/`@ts-ignore`, empty catches, console.log in prod, commented-out code, unused imports. Check AI slop: excessive comments, over-abstraction, generic names (data/result/item/temp).
  Output: `Build [PASS/FAIL] | Tests [N pass/N fail] | Files [N clean/N issues] | VERDICT`

- [x] **F3. Real Manual QA** — `unspecified-high`
  Start from clean state. Execute EVERY QA scenario from EVERY task — follow exact steps, capture evidence. Test cross-task integration: full AcpEvent → SSP → VSCSP pipeline. Test edge cases: unknown event type (RawAcpEventSSP fallback), deferred idle timeout, multi-subagent. Save to `.sisyphus/evidence/final-qa/`.
  Output: `Scenarios [N/N pass] | Integration [N/N] | Edge Cases [N tested] | VERDICT`

- [x] **F4. Scope Fidelity Check** — `deep`
  For each task: read "What to do", read actual diff (git log/diff). Verify 1:1 — everything in spec was built (no missing), nothing beyond spec was built (no creep). Check "Must NOT do" compliance. Detect cross-task contamination: Task N code in Task M files.
  Output: `Tasks [N/N compliant] | Contamination [CLEAN/N issues] | Unaccounted [CLEAN/N files] | VERDICT`

---

## Success Criteria

### Verification Commands
```bash
bun test                    # Expected: all ~369 tests pass
tsc --noEmit                # Expected: zero errors
```

### Final Checklist
- [x] All "Must Have" present
- [x] All "Must NOT Have" absent
- [x] JSONL format backward compatible
- [x] Bridge no longer does rendering
- [x] Edit sync self-contained in Bridge + ExternalEditSSP
- [x] Subagent hierarchy handled
- [x] All tests pass
