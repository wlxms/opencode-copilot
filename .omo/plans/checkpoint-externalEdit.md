# Copilot Checkpoint 集成：Proactive ExternalEdit 方案

## TL;DR

> **Quick Summary**: 使用 VS Code proposed API `ChatResponseExternalEditPart` 在 `prompt()` 前捕获文件 baseline，使 OpenCode 的编辑纳入 Copilot 的 checkpoint undo 系统。
> 
> **Deliverables**:
> - handler.ts 重构：prompt+bridge 包裹在 externalEdit callback 中
> - 类型声明补充：ChatResponseExternalEditPart 运行时类型
> - 按需追加：tool pending 时为新发现的文件追加 externalEdit
> - 新文件创建：ChatResponseWorkspaceEditPart 注册
> 
> **Estimated Effort**: Medium
> **Parallel Execution**: YES - 4 waves
> **Critical Path**: Task 1 → Task 3 → Task 4 → Task 5 → Task 6 → F1-F4

---

## Context

### Original Request
用户希望在 opencode-copilot 扩展中接入 Copilot 的 checkpoint 机制，使 OpenCode 的文件编辑可以使用 Copilot 的 undo UI。

### Interview Summary
**Key Discussions**:
- Copilot 的 checkpoint 内部用 IUndoRedoService + IChatEditingCheckpointTimeline，扩展不可直接使用
- proposed API `ChatResponseExternalEditPart` 是 Chat Participant 接入 checkpoint 的官方路径
- `stream.externalEdit(uris, callback)` 的流程：`await send(start=true)` → baseline 捕获 → `await callback()` → `await send(start=false)`
- OpenCode 是独立进程，不等待 extension 的 externalEdit，存在竞态
- 解决方案：proactive externalEdit before prompt，将 prompt+bridge 包裹在 callback 中
- Metis 指出 `stream.push()` 是 fire-and-forget，不能保证 baseline 在 prompt 前完成

**Research Findings**:
- `extHostChatAgents2.ts:431`: `stream.push(ExternalEditPart)` → `this.externalEdit()` → 不 await，立即返回
- `extHostChatAgents2.ts:311`: `externalEdit()` 内部 `await send(start=true)` → `await callback()` → `await send(start=false)`
- `chatEditingSession.ts:664`: `startExternalEdits()` → 读取文件 → `_initialFileContents.set()` → `createSnapshot()`
- `chatEditingSession.ts:742`: `stopExternalEdits()` → 释放锁 → 检测变化 → 生成 diff UI

### Metis Review
**Identified Gaps** (addressed):
- `stream.push()` 不 await baseline 捕获 → 需要改用 callback 包裹 prompt+bridge 模式
- 新文件创建未被覆盖 → 需要 ChatResponseWorkspaceEditPart
- 文件集选择策略 → open editors + 可选 git dirty
- 取消时 externalEdit 的清理
- 运行时类型检测（ChatResponseExternalEditPart 可能不存在于旧版 VS Code）

---

## Work Objectives

### Core Objective
在 opencode-copilot 中使用 `ChatResponseExternalEditPart` proposed API，使 OpenCode 的文件编辑自动纳入 VS Code 的 Copilot checkpoint undo 系统。

### Concrete Deliverables
- handler.ts 中 prompt+bridge 逻辑包裹在 externalEdit callback 中
- ChatResponseExternalEditPart 类型声明和运行时检测
- 对当前编辑器中打开的文件 proactive 捕获 baseline
- 对 tool pending SSE 中发现的新文件追加 externalEdit（best effort）
- 新文件创建通过 ChatResponseWorkspaceEditPart 注册
- 取消操作时正确清理 externalEdit 状态

### Definition of Done
- [x] OpenCode 编辑文件后，Copilot chat UI 中显示 undo 按钮
- [x] 点击 undo 按钮，文件恢复到编辑前状态
- [x] 多个文件被编辑时，undo 一次全部恢复
- [x] 新创建的文件也能被 undo 删除
- [x] 取消操作时不残留 checkpoint 状态

### Must Have
- 使用 ChatResponseExternalEditPart 接入 Copilot 的 checkpoint UI
- baseline 在 OpenCode prompt 前完成捕获（callback 包裹模式）
- OpenCode session.revert() 作为兜底恢复
- 运行时 feature detection（旧版 VS Code 优雅降级）

### Must NOT Have (Guardrails)
- 不修改 OpenCode 服务端代码
- 不依赖 git
- 不尝试 hack VS Code 内部 API
- 不在 externalEdit callback 中阻塞 stream.push() 调用
- 不为每个 tool call 创建独立的 externalEdit（方案 A 是整 turn 一个）
- 不使用 isExternalEdit 标志（Chat Participant API 不暴露此属性）

---

## Verification Strategy

> **ZERO HUMAN INTERVENTION** - ALL verification is agent-executed.

### Test Decision
- **Infrastructure exists**: YES (vitest)
- **Automated tests**: YES (tests-after)
- **Framework**: vitest
- **If TDD**: N/A — tests after implementation

### QA Policy
Every task MUST include agent-executed QA scenarios.
Evidence saved to `.sisyphus/evidence/task-{N}-{scenario-slug}.{ext}`.

- **API/Backend**: Use Bash (curl) — not applicable (VS Code extension)
- **Extension**: Use Bash (npm test) + vitest
- **Manual QA**: Playwright for VS Code extension host

---

## Execution Strategy

### Parallel Execution Waves

```
Wave 1 (Start Immediately - foundation):
├── Task 1: ChatResponseExternalEditPart 类型声明与运行时检测 [quick]
├── Task 2: idlePromise 机制实现 [quick]
└── Task 3: handler.ts 重构 — externalEdit callback 包裹 [deep]

Wave 2 (After Wave 1 - tool event integration):
├── Task 4: StreamBridge 中 tool pending 时追加文件到 externalEdit [unspecified-high]
└── Task 5: 新文件创建 — ChatResponseWorkspaceEditPart [quick]

Wave 3 (After Wave 2 - robustness):
├── Task 6: 取消操作清理 + OpenCode revert 兜底 [unspecified-high]
└── Task 7: 测试补充 [writing]

Wave FINAL (After ALL tasks):
├── F1: Plan compliance audit [oracle]
├── F2: Code quality review [unspecified-high]
├── F3: Real manual QA [unspecified-high]
└── F4: Scope fidelity check [deep]
```

### Dependency Matrix

| Task | Depends On | Blocks |
|------|-----------|--------|
| 1 | - | 3, 4, 5 |
| 2 | - | 3 |
| 3 | 1, 2 | 4, 5, 6 |
| 4 | 3 | 6 |
| 5 | 1, 3 | 6 |
| 6 | 4, 5 | 7 |
| 7 | 6 | F1-F4 |
| F1-F4 | 7 | - |

### Agent Dispatch Summary

- **Wave 1**: 3 tasks — T1 `quick`, T2 `quick`, T3 `deep`
- **Wave 2**: 2 tasks — T4 `unspecified-high`, T5 `quick`
- **Wave 3**: 2 tasks — T6 `unspecified-high`, T7 `writing`
- **FINAL**: 4 tasks — F1 `oracle`, F2-F3 `unspecified-high`, F4 `deep`

---

## TODOs

- [x] 1. ChatResponseExternalEditPart 类型声明与运行时检测

  **What to do**:
  - 在 `src/types/vscode-proposed-additions.ts` 中补充 `ChatResponseExternalEditPart` 的完整类型声明
  - 在 `src/participant/streaming.ts` 顶部添加运行时检测逻辑（类似 ChatToolInvocationPart 的模式）
  - 确保 `ExtendedChatResponseParts` 接口包含 `ChatResponseExternalEditPart`
  - 类型声明需要包含 `uris`, `callback`, `applied`, `constructor(uris, callback)`

  **Must NOT do**:
  - 不修改 node_modules 中的任何文件
  - 不引入 @types/vscode 中不存在的依赖

  **Recommended Agent Profile**:
  - **Category**: `quick`
  - **Skills**: []

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 1 (with Tasks 2, 3)
  - **Blocks**: Tasks 3, 4, 5
  - **Blocked By**: None

  **References**:
  - `src/types/vscode-proposed-additions.ts:185-201` — 现有 ExtendedChatResponseParts 接口，已有 `ChatResponseExternalEditPart: unknown`
  - `src/participant/streaming.ts:44-45` — 运行时 VS 对象访问模式：`const VS = vscode as ProposedVscode`
  - `src/participant/streaming.ts:332-333` — `VS.ChatToolInvocationPart` 运行时检测模式
  - VS Code 源码 `vscode.proposed.chatParticipantAdditions.d.ts:414-418`:
    ```typescript
    export class ChatResponseExternalEditPart {
      uris: Uri[];
      callback: () => Thenable<unknown>;
      applied: Thenable<string>;
      constructor(uris: Uri[], callback: () => Thenable<unknown>);
    }
    ```
  - VS Code 源码 `extHostTypes.ts:3191-3200`:
    ```typescript
    export class ChatResponseExternalEditPart {
      applied: Thenable<string>;
      didGetApplied!: (value: string) => void;
      constructor(public uris: vscode.Uri[], public callback: () => vscode.Thenable<unknown>) {
        this.applied = new Promise<string>(resolve => { this.didGetApplied = resolve; });
      }
    }
    ```

  **Acceptance Criteria**:
  - [ ] `ChatResponseExternalEditPart` 类型在 `vscode-proposed-additions.ts` 中完整声明
  - [ ] 运行时可通过 `VS.ChatResponseExternalEditPart` 访问（带 undefined 检测）
  - [ ] `npm run lint` (tsc --noEmit) 无错误
  - [ ] `npm test` 全部通过

  **QA Scenarios**:

  ```
  Scenario: 类型声明编译通过
    Tool: Bash
    Steps:
      1. cd H:\PyProjects\opencode-copilot && npm run lint
    Expected Result: Exit code 0, no type errors
    Evidence: .sisyphus/evidence/task-1-lint-pass.txt

  Scenario: 现有测试不受影响
    Tool: Bash
    Steps:
      1. cd H:\PyProjects\opencode-copilot && npm test
    Expected Result: All 67 tests pass
    Evidence: .sisyphus/evidence/task-1-tests-pass.txt
  ```

  **Commit**: YES
  - Message: `feat(types): add ChatResponseExternalEditPart type declarations`
  - Files: `src/types/vscode-proposed-additions.ts`
  - Pre-commit: `npm run lint && npm test`

- [x] 2. idlePromise 机制实现

  **What to do**:
  - 创建 `src/participant/checkpoint.ts`，实现 `CheckpointManager` 类
  - `CheckpointManager` 管理 idlePromise 的创建和 resolve
  - 提供 `createIdlePromise(): Promise<void>` 和 `resolveIdle()` 方法
  - 提供 `hasActiveCheckpoint(): boolean` 查询状态
  - 设计为 per-turn 实例（每个 ChatRequest 创建一个）

  **Must NOT do**:
  - 不依赖 VS Code API（纯逻辑，便于测试）
  - 不在此文件中处理 SSE 事件

  **Recommended Agent Profile**:
  - **Category**: `quick`
  - **Skills**: []

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 1 (with Tasks 1, 3)
  - **Blocks**: Task 3
  - **Blocked By**: None

  **References**:
  - `src/participant/streaming.ts:77-95` — StreamBridge 类结构，per-turn 实例模式
  - `src/types/events.ts:53` — session.idle 事件类型：`'session.idle'`
  - `src/participant/streaming.ts:170` — 当前 session.idle 处理：`case 'session.idle': return { stop: true }`

  **Acceptance Criteria**:
  - [ ] `src/participant/checkpoint.ts` 文件创建
  - [ ] CheckpointManager 类有 createIdlePromise / resolveIdle / hasActiveCheckpoint 方法
  - [ ] 单元测试覆盖：create → resolve → promise settles
  - [ ] `npm run lint` 无错误

  **QA Scenarios**:

  ```
  Scenario: 单元测试通过
    Tool: Bash
    Steps:
      1. cd H:\PyProjects\opencode-copilot && npm test
    Expected Result: All tests pass including new checkpoint tests
    Evidence: .sisyphus/evidence/task-2-tests-pass.txt
  ```

  **Commit**: YES (groups with Task 3)
  - Message: `feat(checkpoint): add CheckpointManager with idlePromise`
  - Files: `src/participant/checkpoint.ts`

- [x] 3. handler.ts 重构 — externalEdit callback 包裹 prompt+bridge

  **What to do**:
  - 修改 `src/participant/handler.ts` 中 `createParticipantHandler` 的主流程
  - 在 `resolveSession()` 之后、`prompt()` 之前，收集 proactive 文件集
  - 用 `ChatResponseExternalEditPart` 包裹整个 prompt+bridge 逻辑
  - callback 内部：
    1. 调用 `client.session.prompt()`
    2. 创建 StreamBridge 并 bridgeEventsToStream
    3. bridge 完成时 callback 自然结束（session.idle）
  - `await part.applied` 等待整个 externalEdit 完成（可选，用于记录 undoStopId）
  - 收集 proactive 文件集的策略：`vscode.workspace.textDocuments` 中 scheme=file 且非 untitled 的文档
  - 在 stream.push(ExternalEditPart) 后添加 `await yieldToEventLoop()` 确保 microtask 执行
  - 保留现有 cancel 逻辑（在 callback 内部注册 CancellationToken 监听）
  - feature detection：如果 ChatResponseExternalEditPart 不可用，跳过 checkpoint 逻辑，走原始流程

  **Must NOT do**:
  - 不在 callback 外调用 prompt()（那会失去 baseline 保证）
  - 不阻塞 callback 内的 stream.push() 调用
  - 不修改 OpenCode SDK 调用方式

  **Recommended Agent Profile**:
  - **Category**: `deep`
  - **Skills**: []

  **Parallelization**:
  - **Can Run In Parallel**: NO (depends on Tasks 1, 2)
  - **Parallel Group**: Wave 1 (sequential after T1, T2)
  - **Blocks**: Tasks 4, 5, 6
  - **Blocked By**: Tasks 1, 2

  **References**:
  - `src/participant/handler.ts:283-410` — `createParticipantHandler` 完整函数，这是主要修改点
  - `src/participant/handler.ts:319` — `resolveSession()` 调用点，externalEdit 应在此之后
  - `src/participant/handler.ts:322-324` — `openSessionStream` + `ensureStarted`，应在 callback 内
  - `src/participant/handler.ts:332-339` — 当前 `prompt()` 调用（fire-and-forget），需移入 callback
  - `src/participant/handler.ts:346-364` — cancel 逻辑，需移入 callback
  - `src/participant/handler.ts:366-373` — `bridgeEventsToStream`，需移入 callback
  - `src/participant/handler.ts:375-396` — prompt await + turnMap 记录，需移入 callback
  - VS Code `extHostChatAgents2.ts:311-317`:
    ```typescript
    async externalEdit(target, callback) {
      const undoStopId = generateUuid();
      await send({ kind: 'externalEdits', start: true, resources, undoStopId });
      try { await callback(); return undoStopId; }
      finally { await send({ kind: 'externalEdits', start: false, resources, undoStopId }); }
    }
    ```
  - VS Code `extHostChatAgents2.ts:431-434`:
    ```typescript
    // push(ExternalEditPart) 不 await，externalEdit 在后台执行
    const p = this.externalEdit(part.uris, part.callback);
    p.then((value) => part.didGetApplied(value));
    return this;
    ```

  **Acceptance Criteria**:
  - [ ] handler.ts 中 prompt+bridge 逻辑在 externalEdit callback 内执行
  - [ ] proactive 文件集在 prompt 前收集
  - [ ] ChatResponseExternalEditPart 不可用时优雅降级到原始流程
  - [ ] cancel 逻辑在 callback 内正确注册
  - [ ] `npm run lint` 无错误
  - [ ] `npm test` 全部通过

  **QA Scenarios**:

  ```
  Scenario: 编译和现有测试通过
    Tool: Bash
    Steps:
      1. cd H:\PyProjects\opencode-copilot && npm run lint
      2. npm test
    Expected Result: Both pass without errors
    Evidence: .sisyphus/evidence/task-3-lint-test.txt

  Scenario: ChatResponseExternalEditPart 不可用时降级
    Tool: Bash
    Steps:
      1. 检查代码中 feature detection 逻辑存在
      2. grep -n "ChatResponseExternalEditPart" handler.ts
    Expected Result: 有 if 分支处理不可用情况，走原始流程
    Evidence: .sisyphus/evidence/task-3-feature-detection.txt
  ```

  **Commit**: YES (groups with Task 2)
  - Message: `feat(checkpoint): wrap prompt+bridge in externalEdit for checkpoint integration`
  - Files: `src/participant/handler.ts`
  - Pre-commit: `npm run lint && npm test`

- [x] 4. StreamBridge 中 tool pending 时追加文件到 externalEdit（best effort）

  **What to do**:
  - 修改 `src/participant/streaming.ts` 中 `handleToolState` 方法
  - 当 tool pending 状态的工具是 write/edit 且文件 URI 不在 proactive 集中时：
    - 推送额外的 `ChatResponseTextEditPart` 或 `ChatResponseCodeblockUriPart` 来追踪该文件
    - 这是 best effort——baseline 可能不精确（文件可能已被修改）
  - 在 tool completed 时推送 `ChatResponseCodeblockUriPart` 标记编辑完成
  - 从 `state.input.filePath` 提取文件路径
  - 通过 StreamBridge 构造函数接收 proactive URI 集合，用于判断是否需要追加

  **Must NOT do**:
  - 不为每个 tool call 创建独立的 externalEdit（方案 A 整 turn 一个）
  - 不阻塞 tool 渲染逻辑
  - 不修改现有的 ChatToolInvocationPart 推送

  **Recommended Agent Profile**:
  - **Category**: `unspecified-high`
  - **Skills**: []

  **Parallelization**:
  - **Can Run In Parallel**: NO (depends on Task 3)
  - **Parallel Group**: Wave 2
  - **Blocks**: Task 6
  - **Blocked By**: Task 3

  **References**:
  - `src/participant/streaming.ts:256-283` — `handleToolState` pending 分支
  - `src/participant/streaming.ts:481-489` — write/edit 工具的 input 解析：`input.filePath`
  - `src/participant/streaming.ts:322-346` — tool completed 分支
  - `src/participant/streaming.ts:77-95` — StreamBridge 构造函数，可扩展接收 proactive URIs

  **Acceptance Criteria**:
  - [ ] write/edit 工具 completed 时，文件 URI 通过 ChatResponseCodeblockUriPart(isEdit=true) 注册
  - [ ] 不在 proactive 集中的文件也能被追踪
  - [ ] 不影响现有 tool 卡片 UI 渲染
  - [ ] `npm run lint` 无错误，`npm test` 通过

  **QA Scenarios**:

  ```
  Scenario: 编译和测试通过
    Tool: Bash
    Steps:
      1. cd H:\PyProjects\opencode-copilot && npm run lint && npm test
    Expected Result: All pass
    Evidence: .sisyphus/evidence/task-4-lint-test.txt
  ```

  **Commit**: YES
  - Message: `feat(checkpoint): track file edits from tool events in checkpoint timeline`
  - Files: `src/participant/streaming.ts`

- [x] 5. 新文件创建 — ChatResponseWorkspaceEditPart

  **What to do**:
  - 在 `src/types/vscode-proposed-additions.ts` 中补充 `ChatResponseWorkspaceEditPart` 和 `ChatWorkspaceFileEdit` 的完整声明（当前是 `unknown`）
  - 在 StreamBridge 中检测新文件创建（write 工具创建不存在的文件）
  - 推送 `ChatResponseWorkspaceEditPart` 注册文件创建操作
  - 这样 undo 时可以删除新创建的文件

  **Must NOT do**:
  - 不尝试处理文件重命名/移动（超出方案 A 范围）

  **Recommended Agent Profile**:
  - **Category**: `quick`
  - **Skills**: []

  **Parallelization**:
  - **Can Run In Parallel**: NO (depends on Tasks 1, 3)
  - **Parallel Group**: Wave 2 (with Task 4)
  - **Blocks**: Task 6
  - **Blocked By**: Tasks 1, 3

  **References**:
  - `src/types/vscode-proposed-additions.ts:189` — `ChatResponseWorkspaceEditPart: unknown`
  - VS Code `vscode.proposed.chatParticipantAdditions.d.ts`:
    ```typescript
    export interface ChatWorkspaceFileEdit {
      oldResource?: Uri;
      newResource?: Uri;
    }
    export class ChatResponseWorkspaceEditPart {
      edits: ChatWorkspaceFileEdit[];
      constructor(edits: ChatWorkspaceFileEdit[]);
    }
    ```
  - `src/participant/streaming.ts:481-489` — write 工具的 input 解析

  **Acceptance Criteria**:
  - [ ] ChatResponseWorkspaceEditPart 类型声明完整
  - [ ] write 工具创建新文件时推送 WorkspaceEditPart
  - [ ] `npm run lint` 无错误，`npm test` 通过

  **QA Scenarios**:

  ```
  Scenario: 编译和测试通过
    Tool: Bash
    Steps:
      1. cd H:\PyProjects\opencode-copilot && npm run lint && npm test
    Expected Result: All pass
    Evidence: .sisyphus/evidence/task-5-lint-test.txt
  ```

  **Commit**: YES
  - Message: `feat(checkpoint): register new file creation via WorkspaceEditPart`
  - Files: `src/types/vscode-proposed-additions.ts`, `src/participant/streaming.ts`

- [x] 6. 取消操作清理 + OpenCode revert 兜底

  **What to do**:
  - 处理 CancellationToken 取消时的 externalEdit 清理
  - 如果 callback 内 cancel 触发，确保 idlePromise 被 resolve（避免 stopExternalEdits 挂起）
  - 在 `resolveSession` 的 rewind/revert 逻辑中，确保新的 externalEdit 不与旧的冲突
  - 添加 OpenCode `session.revert()` 作为兜底：当 VS Code checkpoint 因任何原因不准确时，用户可通过命令调用 revert

  **Must NOT do**:
  - 不在 cancel 时调用 stopExternalEdits（由 callback 正常结束触发）
  - 不替换现有的 revert 逻辑（只增加兜底）

  **Recommended Agent Profile**:
  - **Category**: `unspecified-high`
  - **Skills**: []

  **Parallelization**:
  - **Can Run In Parallel**: NO (depends on Tasks 4, 5)
  - **Parallel Group**: Wave 3
  - **Blocks**: Task 7
  - **Blocked By**: Tasks 4, 5

  **References**:
  - `src/participant/handler.ts:346-364` — 现有 cancel 逻辑
  - `src/participant/handler.ts:206-230` — 现有 revert 逻辑（`client.session.revert()`）
  - `src/participant/checkpoint.ts` — Task 2 创建的 CheckpointManager

  **Acceptance Criteria**:
  - [ ] 取消操作时 idlePromise 被 resolve
  - [ ] stopExternalEdits 在 cancel 后正确执行
  - [ ] 不残留 checkpoint 状态
  - [ ] `npm run lint` 无错误，`npm test` 通过

  **QA Scenarios**:

  ```
  Scenario: 编译和测试通过
    Tool: Bash
    Steps:
      1. cd H:\PyProjects\opencode-copilot && npm run lint && npm test
    Expected Result: All pass
    Evidence: .sisyphus/evidence/task-6-lint-test.txt
  ```

  **Commit**: YES
  - Message: `feat(checkpoint): handle cancellation and add revert fallback`
  - Files: `src/participant/handler.ts`, `src/participant/checkpoint.ts`

- [x] 7. 测试补充

  **What to do**:
  - 为 checkpoint.ts 编写单元测试
  - 为 handler.ts 中的 externalEdit 流程编写单元测试
  - 为 streaming.ts 中的 file edit tracking 编写单元测试
  - Mock ChatResponseExternalEditPart 和 stream.externalEdit
  - 覆盖：正常流程、cancel 流程、feature detection 降级、空文件集

  **Must NOT do**:
  - 不修改任何实现代码

  **Recommended Agent Profile**:
  - **Category**: `writing`
  - **Skills**: []

  **Parallelization**:
  - **Can Run In Parallel**: NO (depends on Task 6)
  - **Parallel Group**: Wave 3 (after Task 6)
  - **Blocks**: F1-F4
  - **Blocked By**: Task 6

  **References**:
  - `src/test/streaming.test.ts` — 现有 StreamBridge 测试模式
  - `src/test/handler.test.ts` — 现有 handler 测试模式
  - `src/test/vscode-mock.ts` — VS Code API mock 模式

  **Acceptance Criteria**:
  - [ ] checkpoint.test.ts 创建，覆盖 CheckpointManager 所有方法
  - [ ] handler.test.ts 新增 externalEdit 流程测试
  - [ ] streaming.test.ts 新增 file tracking 测试
  - [ ] `npm test` 全部通过（含新测试）

  **QA Scenarios**:

  ```
  Scenario: 所有测试通过
    Tool: Bash
    Steps:
      1. cd H:\PyProjects\opencode-copilot && npm test
    Expected Result: All tests pass, test count increased
    Evidence: .sisyphus/evidence/task-7-tests-pass.txt
  ```

  **Commit**: YES
  - Message: `test(checkpoint): add tests for externalEdit checkpoint integration`
  - Files: `src/test/checkpoint.test.ts`, `src/test/handler.test.ts`, `src/test/streaming.test.ts`

---

## Final Verification Wave

> 4 review agents run in PARALLEL. ALL must APPROVE.

- [x] F1. **Plan Compliance Audit** — `oracle`
  Read the plan end-to-end. For each "Must Have": verify implementation exists. For each "Must NOT Have": search codebase for forbidden patterns. Check evidence files exist.
  Output: `Must Have [N/N] | Must NOT Have [N/N] | Tasks [N/N] | VERDICT: APPROVE/REJECT`

- [x] F2. **Code Quality Review** — `unspecified-high`
  Run `npm run lint` + `npm test`. Review all changed files for: `as any`, empty catches, console.log, unused imports. Check AI slop.
  Output: `Build [PASS/FAIL] | Tests [N pass/N fail] | Files [N clean/N issues] | VERDICT`

- [x] F3. **Real Manual QA** — `unspecified-high`
  Start from clean state. Build extension, launch in VS Code Extension Development Host. Send `@opencode` message that triggers file edits. Verify undo button appears and works.
  Output: `Scenarios [N/N pass] | VERDICT`

- [x] F4. **Scope Fidelity Check** — `deep`
  For each task: read "What to do", read actual diff. Verify 1:1. Check "Must NOT do" compliance.
  Output: `Tasks [N/N compliant] | VERDICT`

---

## Commit Strategy

- **Task 1**: `feat(types): add ChatResponseExternalEditPart type declarations`
- **Tasks 2+3**: `feat(checkpoint): wrap prompt+bridge in externalEdit for checkpoint integration`
- **Task 4**: `feat(checkpoint): track file edits from tool events in checkpoint timeline`
- **Task 5**: `feat(checkpoint): register new file creation via WorkspaceEditPart`
- **Task 6**: `feat(checkpoint): handle cancellation and add revert fallback`
- **Task 7**: `test(checkpoint): add tests for externalEdit checkpoint integration`

---

## Success Criteria

### Verification Commands
```bash
npm run lint   # Expected: no errors
npm test       # Expected: all tests pass
```

### Final Checklist
- [x] All "Must Have" present
- [x] All "Must NOT Have" absent
- [x] All tests pass
- [ ] Copilot undo button appears after OpenCode edits
- [ ] Undo correctly restores file content
