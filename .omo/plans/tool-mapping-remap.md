# 工具映射迁移至真实 VS Code 类型

## TL;DR

> **快速摘要**: 将 `src/participant/streaming.ts` 中 5 个自定义本地 interface（TerminalToolData、SimpleToolResultData、ToolResourcesData、SubagentToolData、ToolInvocationPart）替换为 VS Code 官方 `chatParticipantAdditions` 提案 API (version 3) 中的真实类型，同时添加 MCP 工具映射支持。
> 
> **交付物**:
> - 官方 VS Code 类型声明文件 `src/types/vscode-tool-invocation.d.ts`
> - 重写 `buildToolSpecificData()` 使用真实类型（含构造函数调用）
> - `ToolResourcesData` 从 `{path,line,char}` 迁移至 `Uri | Location`
> - 新增 `ChatMcpToolInvocationData` 映射
> - 正确关联 `subAgentInvocationId`
> - 更新 mock 和 14 个现有单元测试
> 
> **预估工作量**: Short（3 个并行 Wave，10 个任务）
> **并行执行**: YES - Wave 1 (3 任务) → Wave 2 (4 任务并行) → Wave 3 (3 任务)
> **关键路径**: Task 1 → Task 4 → Task 5 → Task 9 → Task 12 → F1-F4 → 用户确认

---

## Context

### 原始需求
用户希望将当前工具映射从自定义数据结构迁移为更真实的 VS Code 工具类型，与真实的 VS Code 保持一致。

### 访谈摘要
**关键讨论**:
- 当前 5 个自定义 interface 定义在 `streaming.ts` 第 25-85 行，通过 `const VS = vscode as any` 在运行时访问
- 真实 VS Code API（version 3, 2026年2月）提供了 6 种 `toolSpecificData` 类型，其中 `ChatSubagentToolInvocationData` 和 `ChatToolInvocationPart` 是**有构造函数的 class**
- 最关键的差异：`ToolResourcesData` 使用 `{path, line, character}` 而非 `Uri | Location`，导致 VS Code 无法将其渲染为可点击的文件链接
- 用户选择：从 VS Code 源码复制类型、添加 MCP 映射、单元测试+代理 QA、类型安全与 UI 保真度并重

**研究结论**:
- VS Code 官方 `vscode.proposed.chatParticipantAdditions.d.ts` (version 3) 中定义了所有需要的真实类型
- `ChatSubagentToolInvocationData` 在 2026年2月 (commit `1aa2356`) 从 interface 升级为 class
- VS Code 内部使用 `instanceof` 检查来区分 `toolSpecificData` 类型（如 `data instanceof types.ChatSubagentToolInvocationData`）
- `presentationOverrides` 字段存在于真实 API 但在当前自定义类型中缺失

---

## Work Objectives

### 核心目标
将 `StreamBridge` 类的工具映射层从自定义本地类型完全迁移到 VS Code 官方 Chat Participant proposed API 类型，确保类型安全和原生 UI 渲染能力。

### 具体交付物
- `src/types/vscode-tool-invocation.d.ts` — 官方 VS Code 工具调用类型声明
- 更新 `src/participant/streaming.ts` — `buildToolSpecificData()` 使用真实类型和构造函数
- 更新 `src/test/vscode-mock.ts` — ChatToolInvocationPart 支持正确的 toolSpecificData 类型
- 更新 `src/test/streaming.test.ts` — 14 个测试适配新类型
- 新增 `src/test/tool-mapping.test.ts` — 针对 buildToolSpecificData 的单元测试

### 定义完成
- [ ] `tsc --noEmit` 零错误
- [ ] `vitest run` 全部测试通过（14 个现有 + 新增）
- [ ] 代理 QA：在 VS Code 中 F5 启动，验证 bash/read/write/task/MCP 工具卡片使用原生 UI 渲染

### 必须包含
- 所有 5 个自定义 interface 替换为真实 VS Code 类型
- `ToolResourcesData.values` 使用 `vscode.Uri | vscode.Location`
- `ChatSubagentToolInvocationData` 使用 `new` 构造函数
- `subAgentInvocationId` 正确关联到 `ChatToolInvocationPart`

### 必须不包含（防护规则）
- 不实现完整 MCP 协议 — 仅限数据映射
- 不映射 `ChatTodoToolInvocationData`（OpenCode 暂无 todo 输出）
- 不修改 `handler.ts`、`commands.ts`、`server.ts` 等非映射模块
- 不引入新 npm 依赖
- 不修改 `package.json`（enabledApiProposals 已包含 chatParticipantAdditions）

---

## Verification Strategy

> **零人工干预** — 所有验证由代理执行。严禁需要人工手动测试的验收标准。

### 测试决策
- **基础设施存在**: YES（Vitest + 已有 streaming.test.ts 14 个测试用例）
- **自动化测试**: Unit tests + Agent QA
- **框架**: Vitest
- **代理 QA 策略**: Playwright 在 VS Code 中验证工具卡片原生渲染

### QA 策略
每个任务必须包含代理可执行的 QA 场景。
- **前端/UI**: 使用 Playwright — 导航、交互、断言 DOM、截图
- **API/后端**: 使用 Bash (curl) — 发送请求、断言状态码和响应字段
- **模块/库**: 使用 Bash (bun REPL) — 导入、调用函数、验证输出

---

## Execution Strategy

### 并行执行 Wave

```
Wave 1（立即开始 — 基础设施）:
├── Task 1: 复制官方 VS Code 类型声明文件 [quick]
├── Task 2: 更新 VSCode mock 的类型定义 [quick]
└── Task 3: 验证 TypeScript 编译基线 [quick]

Wave 2（Wave 1 完成后 — 核心迁移，最大化并行）:
├── Task 4: 替换 Terminal Tool 类型映射（bash/shell）[quick]
├── Task 5: 替换 Simple/Resources Tool 类型映射（read/list/grep/write/edit）[visual-engineering]
├── Task 6: 替换 Subagent/Task 类型映射（task/subagent）[quick]
└── Task 7: 替换 ToolInvocationPart + 关联 subAgentInvocationId [quick]

Wave 3（Wave 2 完成后 — 扩展 + 测试）:
├── Task 8: 添加 MCP 工具映射（ChatMcpToolInvocationData）[quick]
├── Task 9: 更新现有 streaming 测试（14 个测试适配新类型）[unspecified-high]
└── Task 10: 新增 buildToolSpecificData 单元测试 [unspecified-high]

Wave FINAL（所有任务完成后 — 4 个并行审查，然后等待用户确认）:
├── Task F1: Plan Compliance Audit（oracle）
├── Task F2: Code Quality Review（unspecified-high）
├── Task F3: Real Manual QA（unspecified-high + playwright）
└── Task F4: Scope Fidelity Check（deep）
→ 呈现结果 → 获取用户明确确认
```

**关键路径**: Task 1 → Task 4 → Task 5 → Task 9 → F1-F4 → 用户确认
**并行加速**: 比串行快约 60%（Wave 2 中 4 个任务并行）
**最大并发**: 4（Wave 2）

---

- [ ] 3. 验证 TypeScript 编译基线

  ...（见上方 Task 3）...

- [ ] 4. 替换 Terminal Tool 类型映射（bash/shell）

  **What to do**:
  - 在 `src/participant/streaming.ts` 的 `buildToolSpecificData()` 方法中（`case 'bash':` 和 `case 'shell':` 分支）
  - 删除本地 `TerminalToolData` interface 定义（第 25-31 行）
  - 将返回对象改为返回 `vscode.ChatTerminalToolInvocationData` 类型
  - 添加 `presentationOverrides` 字段支持（当标题检测到 `cd <dir> && <cmd>` 模式时设置）
  - 保持现有的 `commandLine.original`、`language`、`output.text`、`state.duration` 映射
  - 更新 `formatPastTenseMsg()` 中 `bash` 的过去式动词为 `Ran`
  - 移除 `TerminalToolData` 从 `ToolSpecificData` 联合类型

  **Must NOT do**:
  - 不要修改 `handleToolState()` 的事件处理逻辑
  - 不要修改 `pushToolInvocation()` 中创建 ChatToolInvocationPart 的逻辑（由 Task 7 处理）
  - 不要修改 bash/shell 工具调用的 SSE 事件解析逻辑

  **Recommended Agent Profile**:
  - **Category**: `quick`
    - Reason: 针对性替换单一工具类型的映射逻辑，改动范围小
  - **Skills**: []
    - 无需特殊技能

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 2（与 Task 5, Task 6, Task 7 并行）
  - **Blocks**: Task 9（测试适配）
  - **Blocked By**: Task 1, Task 3

  **References**:
  - 目标文件: `src/participant/streaming.ts:336-353` — `case 'bash':` 和 `case 'shell':` 分支，需要替换 TerminalToolData 为 ChatTerminalToolInvocationData
  - 新类型声明: `src/types/vscode-tool-invocation.d.ts` — `ChatTerminalToolInvocationData` 的真实接口定义，包含 `presentationOverrides` 字段
  - 语言检测辅助: `src/participant/streaming.ts:509-516` — `detectLanguage()` 函数，presentationOverrides 可复用此逻辑

  **Acceptance Criteria**:
  - [ ] `TerminalToolData` interface 从 streaming.ts 中删除
  - [ ] bash/shell 分支返回 `ChatTerminalToolInvocationData` 类型
  - [ ] `presentationOverrides` 在检测到 cd 前缀时正确设置
  - [ ] `tsc --noEmit` 无新增类型错误
  - [ ] `formatPastTenseMsg` 中 bash 的过去式正确

  **QA Scenarios**:

  ```
  Scenario: bash 工具调用产生正确的 ChatTerminalToolInvocationData
    Tool: Bash (bun REPL)
    Preconditions: Task 1-3 完成
    Steps:
      1. 在 Node.js REPL 中构造 StreamBridge 实例
      2. 调用 buildToolSpecificData('bash', title, {command: 'npm install'}, 'output text', 1000, 2500)
      3. 验证返回对象包含 commandLine: { original: 'npm install' }
      4. 验证 language 字段为 'bash'
      5. 验证 state.duration 为 1500
      6. 验证 output.text 为 'output text'
      7. 验证返回对象符合 ChatTerminalToolInvocationData 接口
    Expected Result: 返回的对象结构与 ChatTerminalToolInvocationData 完全匹配
    Failure Indicators: 缺少必填字段、类型不匹配、presentationOverrides 处理错误
    Evidence: .sisyphus/evidence/task-4-terminal-type.txt

  Scenario: presentationOverrides 在 cd 前缀时正确设置
    Tool: Bash (bun REPL)
    Preconditions: 同上
    Steps:
      1. 传入 title='cd /project && npm test'
      2. 验证 presentationOverrides.commandLine 去除了 cd 前缀
      3. 验证 presentationOverrides.language 仍然正确
    Expected Result: presentationOverrides 正确剥离 cd 前缀
    Failure Indicators: cd 前缀未被剥离、presentationOverrides 格式错误
    Evidence: .sisyphus/evidence/task-4-presentation-overrides.txt
  ```

  **Commit**: YES（Wave 2 合并提交）
  - Message: `refactor(streaming): migrate tool mapping to real VS Code types`
  - Files: `src/participant/streaming.ts`

- [ ] 5. 替换 Simple/Resources Tool 类型映射（read/list/grep/write/edit）

  **What to do**:
  - 在 `buildToolSpecificData()` 方法中替换以下分支：
    - `case 'read':` / `case 'list':` / `case 'grep':`（第 355-362 行）→ 返回 `ChatSimpleToolResultData`
    - `case 'write':` / `case 'edit':`（第 364-377 行）→ 在有 filePath 时返回 `ChatToolResourcesInvocationData`，否则返回 `ChatSimpleToolResultData`
  - **关键修改 — ToolResourcesData**: 将 `{ path: filePath }` 替换为 `new vscode.Uri(filePath)` 构建 `vscode.Uri` 对象
  - 对于 line/character 信息，使用 `new vscode.Location(uri, new vscode.Position(line, character))` 或直接使用 `vscode.Uri`
  - 删除本地 `ToolResourcesData` 和 `SimpleToolResultData` interface 定义
  - 更新 `formatPastTenseMsg()` 中的过去式动词映射（read→Read, list→Listed, grep→Searched, write→Wrote, edit→Edited）

  **Must NOT do**:
  - 不要修改 `read/list/grep` 的 input/output 截断逻辑（`truncate(output, 2000)`）
  - 不要修改文件读写的事件处理逻辑
  - 不要使用 `vscode.Uri.file()`（应在 VS Code 扩展环境中可用，但 mock 需要兼容）

  **Recommended Agent Profile**:
  - **Category**: `visual-engineering`
    - Reason: 涉及 Uri/Location 对象构建，直接影响 VS Code UI 渲染效果，需要了解 VS Code 资源 URI 系统
  - **Skills**: []
    - 无需特殊技能 — URI 构建是 VS Code 基础知识

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 2（与 Task 4, Task 6, Task 7 并行）
  - **Blocks**: Task 9（测试适配）
  - **Blocked By**: Task 1, Task 3

  **References**:
  - read/list/grep 分支: `src/participant/streaming.ts:355-362` — 当前返回 SimpleToolResultData
  - write/edit 分支: `src/participant/streaming.ts:364-377` — 当前返回 ToolResourcesData 或 SimpleToolResultData
  - 真实类型: `src/types/vscode-tool-invocation.d.ts` — `ChatToolResourcesInvocationData.values: Array<Uri | Location>`
  - formatInput 辅助: `src/participant/streaming.ts:501-506` — 用于格式化显示 title
  - truncate 辅助: `src/participant/streaming.ts:495-498` — 输出截断逻辑，需要保留

  **Acceptance Criteria**:
  - [ ] `SimpleToolResultData` 和 `ToolResourcesData` interface 从 streaming.ts 中删除
  - [ ] read/list/grep 返回 `ChatSimpleToolResultData`
  - [ ] write/edit 有 filePath 时返回 `ChatToolResourcesInvocationData`（values 数组含 `vscode.Uri` 对象）
  - [ ] write/edit 无 filePath 时降级返回 `ChatSimpleToolResultData`
  - [ ] `tsc --noEmit` 无新增类型错误

  **QA Scenarios**:

  ```
  Scenario: write 工具调用使用 Uri 构建 ChatToolResourcesInvocationData
    Tool: Bash (bun REPL)
    Preconditions: Task 1-3 完成, Task 4 不阻塞此测试
    Steps:
      1. 调用 buildToolSpecificData('write', title, {filePath: '/path/to/file.ts'}, '', undefined, undefined)
      2. 验证返回的 values 数组长度为 1
      3. 验证 values[0] 是 vscode.Uri 实例
      4. 验证 values[0].fsPath 或 path 指向 '/path/to/file.ts'
    Expected Result: values 数组包含 Uri 对象，非普通字符串
    Failure Indicators: values 仍是 {path: string} 对象、不是 Uri 实例
    Evidence: .sisyphus/evidence/task-5-uri-values.txt

  Scenario: read 工具调用使用 ChatSimpleToolResultData
    Tool: Bash (bun REPL)
    Preconditions: 同上
    Steps:
      1. 调用 buildToolSpecificData('read', 'Read file.txt', {filePath: 'file.txt'}, 'file content', undefined, undefined)
      2. 验证返回对象有 input 和 output 字段
      3. 验证 input 包含 'filePath'
      4. 验证 output 为 'file content'
    Expected Result: 返回符合 ChatSimpleToolResultData 接口的对象
    Failure Indicators: 字段名称错误、类型不匹配
    Evidence: .sisyphus/evidence/task-5-simple-result.txt

  Scenario: edit（无 filePath）降级为 ChatSimpleToolResultData
    Tool: Bash (bun REPL)
    Preconditions: 同上
    Steps:
      1. 调用 buildToolSpecificData('edit', 'Edit code', {old: 'a', new: 'b'}, 'done', undefined, undefined)
      2. 验证返回对象是 ChatSimpleToolResultData 格式（有 input/output）
      3. 验证不包含 values 数组
    Expected Result: 降级到通用 SimpleToolResultData
    Failure Indicators: 返回了错误的类型、返回了空对象
    Evidence: .sisyphus/evidence/task-5-edit-fallback.txt
  ```

  **Commit**: YES（Wave 2 合并提交）
  - Message: `refactor(streaming): migrate tool mapping to real VS Code types`
  - Files: `src/participant/streaming.ts`

- [ ] 6. 替换 Subagent/Task 类型映射（task/subagent）

  **What to do**:
  - 在 `buildToolSpecificData()` 方法中替换 `case 'task':` / `case 'subagent':` 分支（第 379-387 行）
  - 将返回对象改为使用 `new vscode.ChatSubagentToolInvocationData(description, agentName, prompt, result)` 构造函数
  - 删除本地 `SubagentToolData` interface 定义
  - 参数映射：
    - `description` ← `input.description` 或 `title`
    - `agentName` ← `input.agentName` 或 `toolName`
    - `prompt` ← `input.prompt` 或 `formatInput(input, '')`
    - `result` ← `truncate(output, 4000)`
  - 确保构造函数参数顺序正确

  **Must NOT do**:
  - 不要修改 subagent 的工具调用状态机
  - 不要修改 `formatInvocationMsg()` 中与 task 相关的逻辑
  - 不要移除 result 截断逻辑

  **Recommended Agent Profile**:
  - **Category**: `quick`
    - Reason: 单一工具类型替换，将对象字面量改为 class 构造函数调用，改动范围小
  - **Skills**: []
    - 无需特殊技能

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 2（与 Task 4, Task 5, Task 7 并行）
  - **Blocks**: Task 9（测试适配）
  - **Blocked By**: Task 1, Task 3

  **References**:
  - task/subagent 分支: `src/participant/streaming.ts:379-387` — 当前返回 SubagentToolData
  - 真实类型: `src/types/vscode-tool-invocation.d.ts` — `ChatSubagentToolInvocationData` class 定义，含构造函数签名
  - formatInput 辅助: `src/participant/streaming.ts:501-506` — prompt 格式化逻辑
  - truncate 辅助: `src/participant/streaming.ts:495-498` — result 截断逻辑

  **Acceptance Criteria**:
  - [ ] `SubagentToolData` interface 从 streaming.ts 中删除
  - [ ] task/subagent 分支使用 `new ChatSubagentToolInvocationData(...)` 构造函数
  - [ ] 构造函数四个参数正确映射
  - [ ] `tsc --noEmit` 无新增类型错误
  - [ ] result 仍被 truncate(output, 4000) 截断

  **QA Scenarios**:

  ```
  Scenario: task 工具调用产生 ChatSubagentToolInvocationData 实例
    Tool: Bash (bun REPL)
    Preconditions: Task 1-3 完成
    Steps:
      1. 调用 buildToolSpecificData('task', 'Fix bugs', {description: 'Fix login bug', agentName: 'bug-fixer', prompt: 'fix all'}, 'Done: fixed 3 bugs', undefined, undefined)
      2. 验证返回对象是 vscode.ChatSubagentToolInvocationData 实例
      3. 验证 description 为 'Fix login bug'
      4. 验证 agentName 为 'bug-fixer'
      5. 验证 prompt 包含 'fix all'
      6. 验证 result 被截断（如果不是超长字符串）或完整保留
    Expected Result: 返回 ChatSubagentToolInvocationData 实例，所有字段正确赋值
    Failure Indicators: 仍是普通对象而非 class 实例、字段值为空、构造函数参数顺序错误
    Evidence: .sisyphus/evidence/task-6-subagent-class.txt

  Scenario: subagent 无 description 时使用 title 作为 fallback
    Tool: Bash (bun REPL)
    Preconditions: 同上
    Steps:
      1. 调用 buildToolSpecificData('subagent', 'Generic task', {}, 'result', undefined, undefined)
      2. 验证 description 为 'Generic task'（从 title 获取）
      3. 验证返回实例无异常
    Expected Result: 参数 fallback 正确，无 undefined 值错误
    Failure Indicators: description 为 undefined、构造函数抛出错误
    Evidence: .sisyphus/evidence/task-6-fallback.txt
  ```

  **Commit**: YES（Wave 2 合并提交）
  - Message: `refactor(streaming): migrate tool mapping to real VS Code types`
  - Files: `src/participant/streaming.ts`

- [ ] 7. 替换 ToolInvocationPart 包装 + 关联 subAgentInvocationId

  **What to do**:
  - 在 `pushToolInvocation()` 方法（第 290-322 行）中：
    - 删除本地 `ToolInvocationPart` interface 定义（第 61-75 行）
    - 将 `new VS.ChatToolInvocationPart(toolName, callID)` 的类型从自定义 interface 改为使用 `vscode.ChatToolInvocationPart`
    - 添加 `part.subAgentInvocationId = ...` 支持：当当前工具是子代理时从 `meta` 中提取 subAgentInvocationId 并设置
  - 更新 `Stream` 类型中的 `beginToolInvocation` 和 `updateToolInvocation` 方法声明使用 `vscode.ChatToolInvocationStreamData`
  - 删除 `ToolSpecificData` 本地联合类型（不再需要，由 VS Code 的类型联合自动处理）
  - 更新 `buildToolSpecificData()` 的返回类型为 `vscode.ChatToolInvocationPart['toolSpecificData']`

  **Must NOT do**:
  - 不要删除 `const VS = vscode as any`（仍需在运行时访问）
  - 不要修改 `pushToolInvocation()` 中的 try/catch 错误处理
  - 不要修改 `stream.push(part)` 的逻辑

  **Recommended Agent Profile**:
  - **Category**: `quick`
    - Reason: 类型替换和单个字段添加，改动范围小
  - **Skills**: []
    - 无需特殊技能

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 2（与 Task 4, Task 5, Task 6 并行）
  - **Blocks**: Task 9（测试适配需要完整的类型迁移）
  - **Blocked By**: Task 1, Task 3（不依赖于 Task 4-6 的具体实现细节，可并行进行类型声明层面的一致性调整）

  **References**:
  - pushToolInvocation: `src/participant/streaming.ts:290-322` — 创建 ChatToolInvocationPart 并设置 toolSpecificData
  - 本地 ToolInvocationPart: `src/participant/streaming.ts:61-75` — 需要删除的自定义 interface
  - 真实类型: `src/types/vscode-tool-invocation.d.ts` — `ChatToolInvocationPart` class 定义，含 `subAgentInvocationId` 属性
  - Stream 类型: `src/participant/streaming.ts:78-82` — 需要更新 beginToolInvocation/updateToolInvocation 的类型签名

  **Acceptance Criteria**:
  - [ ] `ToolInvocationPart` 和 `ToolSpecificData` 本地类型已删除
  - [ ] `part.subAgentInvocationId` 在子代理调用时正确设置
  - [ ] `beginToolInvocation` / `updateToolInvocation` 类型签名使用 VS Code 真实类型
  - [ ] `buildToolSpecificData()` 返回类型正确推断
  - [ ] `tsc --noEmit` 无新增类型错误

  **QA Scenarios**:

  ```
  Scenario: subAgentInvocationId 在子代理工具调用时正确设置
    Tool: Bash (bun REPL)
    Preconditions: Task 1-6 完成
    Steps:
      1. 模拟一个子代理工具调用的 handleToolState 流程（pending → running → completed）
      2. 在 completed 状态时验证 pushToolInvocation 中设置了 part.subAgentInvocationId
      3. 验证非子代理工具调用时 subAgentInvocationId 为 undefined
    Expected Result: 子代理有 subAgentInvocationId，普通工具没有
    Failure Indicators: subAgentInvocationId 始终为 undefined
    Evidence: .sisyphus/evidence/task-7-subagent-id.txt

  Scenario: 类型推断正确
    Tool: Bash (pwsh)
    Preconditions: Task 1-7 完成
    Steps:
      1. 运行: tsc --noEmit 2>&1
      2. 验证退出码为 0
      3. 搜索输出中无 'ToolInvocationPart' 或 'ToolSpecificData' 相关错误
    Expected Result: 编译成功，类型推断正确
    Failure Indicators: 编译错误、类型不兼容
    Evidence: .sisyphus/evidence/task-7-typecheck.txt
  ```

  **Commit**: YES（Wave 2 合并提交）
  - Message: `refactor(streaming): migrate tool mapping to real VS Code types`
  - Files: `src/participant/streaming.ts`

---

## Final Verification Wave

> 所有实现任务完成后，4 个审查代理并行运行。全部必须 APPROVE。向用户呈现合并结果，获取明确"okay"后方可标记完成。

- [ ] F1. **Plan Compliance Audit** — `oracle`

  Read the plan end-to-end. For each "Must Have": verify implementation exists. For each "Must NOT Have": search codebase for forbidden patterns. Check evidence files exist in `.sisyphus/evidence/`.
  Output: `Must Have [N/N] | Must NOT Have [N/N] | Tasks [N/N] | VERDICT: APPROVE/REJECT`

- [ ] F2. **Code Quality Review** — `unspecified-high`

  Run `tsc --noEmit` + `vitest run`. Review all changed files for anti-patterns. Check AI slop: excessive comments, over-abstraction, generic names.
  Output: `Build [PASS/FAIL] | Tests [N pass/N fail] | VERDICT`

- [ ] F3. **Real Manual QA** — `unspecified-high` (+ `playwright` skill)

  Execute EVERY QA scenario from EVERY task in VS Code via Playwright. Test cross-task integration.
  Output: `Scenarios [N/N pass] | Integration [N/N] | Edge Cases [N tested] | VERDICT`

- [ ] F4. **Scope Fidelity Check** — `deep`

  Verify 1:1 — everything in spec was built, nothing beyond spec was built. Check "Must NOT do" compliance.
  Output: `Tasks [N/N compliant] | Contamination [CLEAN/N issues] | Unaccounted [CLEAN/N files] | VERDICT`

---

## Commit Strategy

- **Wave 1**: `feat(types): add official VS Code tool invocation type declarations` — `src/types/vscode-tool-invocation.d.ts`, `src/test/vscode-mock.ts`
- **Wave 2**: `refactor(streaming): migrate tool mapping to real VS Code types` — `src/participant/streaming.ts`
- **Wave 3**: `feat(streaming): add MCP tool mapping and update tests` — `src/participant/streaming.ts`, `src/test/streaming.test.ts`, `src/test/tool-mapping.test.ts`

---

## Success Criteria

### 验证命令
```bash
tsc --noEmit                    # 期望：零错误
vitest run                      # 期望：全部通过（≥14 + 新增测试）
```

### 最终检查清单
- [ ] 所有"Must Have"均存在
- [ ] 所有"Must NOT Have"均不存在
- [ ] 所有测试通过
- [ ] VS Code 中 F5 启动正常，工具卡片使用原生 UI
  - 返回 `vscode.ChatMcpToolInvocationData` 类型对象：
    - `input` ← `formatInput(input, title)` 格式化的工具输入
    - `output` ← `[]`（空数组）或解析 OpenCode MCP 输出为 `McpToolInvocationContentData[]`
  - 如果 OpenCode 的 MCP 工具输出是文本格式，包装为 `new vscode.McpToolInvocationContentData(encodedData, 'text/plain')`
  - 保留 default 分支中的泛型 fallback 逻辑不变
  - 在 `formatPastTenseMsg()` 中添加 `mcp` 的过去式映射（如 `Called` 或 `Invoked`）

  **Must NOT do**:
  - 不要实现完整的 MCP 协议解析 — 仅处理 OpenCode 当前可能的 MCP 输出格式
  - 不要修改 default 分支的 fallback 逻辑
  - 不要添加 MCP 工具调用的事件处理逻辑（handleToolState 中无需修改）

  **Recommended Agent Profile**:
  - **Category**: `quick`
    - Reason: 新增一个 switch case 分支，逻辑简单，改动范围小
  - **Skills**: []
    - 无需特殊技能

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 3（与 Task 9, Task 10 并行）
  - **Blocks**: None
  - **Blocked By**: Task 1, Task 7

  **References**:
  - buildToolSpecificData: `src/participant/streaming.ts:328-398` — 现有 switch 分支结构
  - default 分支: `src/participant/streaming.ts:389-398` — 泛型 fallback 模式参考
  - 真实类型: `src/types/vscode-tool-invocation.d.ts` — `ChatMcpToolInvocationData` 和 `McpToolInvocationContentData` 定义
  - formatInput 辅助: `src/participant/streaming.ts:501-506` — 输入格式化

  **Acceptance Criteria**:
  - [ ] `case 'mcp':` 分支存在于 buildToolSpecificData 中
  - [ ] 返回对象符合 `ChatMcpToolInvocationData` 接口（有 input 和 output 字段）
  - [ ] `tsc --noEmit` 无新增类型错误
  - [ ] default 分支不变

  **QA Scenarios**:

  ```
  Scenario: MCP 工具调用映射到 ChatMcpToolInvocationData
    Tool: Bash (bun REPL)
    Preconditions: Task 1-7 完成
    Steps:
      1. 调用 buildToolSpecificData('mcp', 'MCP Tool', {action: 'query', params: '...'}, 'result data', undefined, undefined)
      2. 验证返回对象有 input 字段（非空字符串）
      3. 验证 output 是数组类型
    Expected Result: 返回符合 ChatMcpToolInvocationData 接口的对象
    Failure Indicators: 代码进入 default 分支而非 mcp 分支
    Evidence: .sisyphus/evidence/task-8-mcp-mapping.txt

  Scenario: 未知工具仍使用通用 fallback
    Tool: Bash (bun REPL)
    Preconditions: 同上
    Steps:
      1. 调用 buildToolSpecificData('unknown_tool', 'Unknown', {key: 'val'}, 'output', undefined, undefined)
      2. 验证返回对象是 ChatSimpleToolResultData 格式（input/output）
    Expected Result: default 分支的 fallback 逻辑正常
    Failure Indicators: default 分支被破坏、返回空或错误类型
    Evidence: .sisyphus/evidence/task-8-fallback.txt
  ```

  **Commit**: YES
  - Message: `feat(streaming): add MCP tool mapping and update tests`
  - Files: `src/participant/streaming.ts`

- [ ] 9. 更新现有 streaming 测试（14 个测试适配新类型）

  **What to do**:
  - 打开 `src/test/streaming.test.ts`
  - 检查 14 个测试用例，找出所有涉及 `toolSpecificData` 断言的测试
  - 更新断言以匹配新的类型结构：
    - `toolSpecificData.commandLine.original` → 保持不变（结构兼容）
    - `toolSpecificData.values[0].path` → 改为检查 `toolSpecificData.values[0]` 是 `Uri` 实例
    - `toolSpecificData.description` → 改为检查 `instanceof ChatSubagentToolInvocationData` 或字段值
    - 任何直接匹配对象结构的断言需要更新类型引用
  - 运行 `vitest run` 确保所有测试通过
  - 如果测试失败，逐个修复断言

  **Must NOT do**:
  - 不要删除任何现有测试用例
  - 不要改变测试覆盖的业务逻辑范围
  - 不要修改测试中的 mock 设置（mock 已在 Task 2 中更新）

  **Recommended Agent Profile**:
  - **Category**: `unspecified-high`
    - Reason: 需要批量检查和修改 14 个测试用例的断言，确保语义不变的同时适配新类型
  - **Skills**: []
    - 无需特殊技能 — 标准的测试维护工作

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 3（与 Task 8, Task 10 并行，但与 Task 10 共享文件需注意合并冲突）
  - **Blocks**: None
  - **Blocked By**: Task 4, Task 5, Task 6, Task 7

  **References**:
  - 测试文件: `src/test/streaming.test.ts` — 14 个测试，包含 toolSpecificData 断言
  - Mock 文件: `src/test/vscode-mock.ts` (Task 2 更新后) — ChatToolInvocationPart 的新类型定义
  - 测试配置: `vitest.config.ts` — 确认测试运行配置

  **Acceptance Criteria**:
  - [ ] 14 个测试全部适配新类型
  - [ ] `vitest run` 全部通过（14/14）
  - [ ] 没有因类型不匹配导致的测试失败
  - [ ] 断言仍验证相同的业务逻辑

  **QA Scenarios**:

  ```
  Scenario: 所有现有测试在新类型下通过
    Tool: Bash (pwsh)
    Preconditions: Task 1-8 完成
    Steps:
      1. 运行: npx vitest run 2>&1
      2. 检查输出中 "Tests" 行显示 14 passed（或更多）
      3. 检查无 FAIL 标记
    Expected Result: 14/14 测试通过
    Failure Indicators: 测试失败、断言错误、类型不匹配
    Evidence: .sisyphus/evidence/task-9-tests-pass.txt

  Scenario: Uri/Location 类型断言正确
    Tool: Bash (pwsh)
    Preconditions: 同上
    Steps:
      1. 在测试输出中搜索 write 相关测试的名称
      2. 确认断言检查的是 Uri 实例而非 {path: string}
    Expected Result: write 工具测试使用 Uri 断言
    Failure Indicators: 测试仍用旧的对象比较方式断言
    Evidence: .sisyphus/evidence/task-9-uri-assertion.txt
  ```

  **Commit**: YES
  - Message: `feat(streaming): add MCP tool mapping and update tests`
  - Files: `src/test/streaming.test.ts`

- [ ] 10. 新增 buildToolSpecificData 单元测试

  **What to do**:
  - 创建 `src/test/tool-mapping.test.ts`
  - 导入 `StreamBridge` 类（将 `buildToolSpecificData` 设为 public 或通过反射访问）
  - 编写针对所有工具类型的单元测试：
    - `bash` → `ChatTerminalToolInvocationData`（含 presentationOverrides）
    - `shell` → `ChatTerminalToolInvocationData`
    - `read` → `ChatSimpleToolResultData`
    - `list` → `ChatSimpleToolResultData`
    - `grep` → `ChatSimpleToolResultData`
    - `write` (有 filePath) → `ChatToolResourcesInvocationData`（Uri 类型）
    - `write` (无 filePath) → `ChatSimpleToolResultData`
    - `edit` (有 filePath) → `ChatToolResourcesInvocationData`
    - `task` → `ChatSubagentToolInvocationData`（instanceof + 字段值）
    - `subagent` → `ChatSubagentToolInvocationData`
    - `mcp` → `ChatMcpToolInvocationData`
    - `unknown_tool` → `ChatSimpleToolResultData`（fallback）
  - 确保每个测试用例至少验证：
    - 返回类型正确
    - 必填字段存在且值正确
    - 边界情况（空输入、空输出、缺失可选字段）
  - 运行 `vitest run` 确认新增测试全部通过

  **Must NOT do**:
  - 不要创建需要 VS Code 扩展运行时环境的测试
  - 不要使用 Playwright 或 E2E 测试框架
  - 不要依赖 OpenCode SDK 或真实服务器

  **Recommended Agent Profile**:
  - **Category**: `unspecified-high`
    - Reason: 需要编写 12+ 个测试用例，覆盖完整的工具类型矩阵和边界情况
  - **Skills**: []
    - 无需特殊技能 — 标准 Vitest 单元测试

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 3（与 Task 8, Task 9 并行，但与 Task 9 不共享文件）
  - **Blocks**: None
  - **Blocked By**: Task 2, Task 7

  **References**:
  - 测试模式参考: `src/test/streaming.test.ts` — 了解项目的测试结构和断言风格
  - 被测试方法: `src/participant/streaming.ts:328-398` — buildToolSpecificData 完整实现
  - Mock 文件: `src/test/vscode-mock.ts` — 了解如何在测试中构造 mock 对象
  - 测试配置: `vitest.config.ts` — 确认测试运行配置

  **Acceptance Criteria**:
  - [ ] 文件 `src/test/tool-mapping.test.ts` 已创建
  - [ ] 至少 12 个测试用例（每种工具类型至少 1 个）
  - [ ] `vitest run` 新增测试全部通过
  - [ ] 覆盖了所有 toolSpecificData 类型映射路径
  - [ ] 包含边界情况测试（空输入、空输出、未知工具）

  **QA Scenarios**:

  ```
  Scenario: 所有工具类型映射测试通过
    Tool: Bash (pwsh)
    Preconditions: Task 1-9 完成
    Steps:
      1. 运行: npx vitest run tool-mapping 2>&1
      2. 检查输出中至少有 12 passed
      3. 验证每个工具名称（bash/read/write/task/mcp 等）在测试名称中出现
    Expected Result: ≥12 测试通过，覆盖全部工具类型
    Failure Indicators: 测试失败、测试数量不足、未覆盖关键类型
    Evidence: .sisyphus/evidence/task-10-new-tests.txt

  Scenario: 边界情况测试正确
    Tool: Bash (pwsh)
    Preconditions: 同上
    Steps:
      1. 在工具映射测试输出中搜索 'fallback' 或 'unknown'
      2. 验证未知工具返回 ChatSimpleToolResultData
      3. 验证空 input 不导致崩溃
    Expected Result: 边界情况正确处理
    Failure Indicators: 空输入导致异常、未知工具返回错误类型
    Evidence: .sisyphus/evidence/task-10-edge-cases.txt
  ```

  **Commit**: YES
  - Message: `feat(streaming): add MCP tool mapping and update tests`
  - Files: `src/test/tool-mapping.test.ts`

---

## Final Verification Wave

> 所有实现任务完成后，4 个审查代理并行运行。全部必须 APPROVE。向用户呈现合并结果，获取明确"okay"后方可标记完成。

- [ ] F1. **Plan Compliance Audit** — `oracle`
- [ ] F2. **Code Quality Review** — `unspecified-high`
- [ ] F3. **Real Manual QA** — `unspecified-high` (+ `playwright` skill)
- [ ] F4. **Scope Fidelity Check** — `deep`

---

## Commit Strategy

- **Wave 1**: `feat(types): add official VS Code tool invocation type declarations` — `src/types/vscode-tool-invocation.d.ts`, `src/test/vscode-mock.ts`
- **Wave 2**: `refactor(streaming): migrate tool mapping to real VS Code types` — `src/participant/streaming.ts`
- **Wave 3**: `feat(streaming): add MCP tool mapping and update tests` — `src/participant/streaming.ts`, `src/test/streaming.test.ts`, `src/test/tool-mapping.test.ts`

---

## Success Criteria

### 验证命令
```bash
tsc --noEmit                    # 期望：零错误
vitest run                      # 期望：全部通过（≥14 + 新增测试）
```

### 最终检查清单
- [ ] 所有"Must Have"均存在
- [ ] 所有"Must NOT Have"均不存在
- [ ] 所有测试通过
- [ ] VS Code 中 F5 启动正常，工具卡片使用原生 UI
