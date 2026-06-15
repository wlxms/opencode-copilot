# Tool Mapping Improvement Plan

> **状态**: 可行性验证已完成 (2026-05-13)
> **测试**: 101 通过 (原有 67 + 新增 34)，0 失败

## Goal

将 `StreamBridge` (`src/participant/streaming.ts`) 从使用旧的 `message.part.*` 事件迁移到新的 `session.next.tool.*` 事件流，并修正 `toolSpecificData` 类型以完全匹配 VSCode 原生 `ChatToolInvocationPart` 数据结构。

## 可行性验证结果

### ✅ 已完成并验证的工作

通过 TDD 方式完成了核心功能实现和验证：

| 验证项 | 状态 | 说明 |
|---|---|---|
| `session.next.tool.*` 事件流 | ✅ 通过 | input.started/delta/ended, called, progress, success/failed 全部处理 |
| `session.next.text.*` 事件流 | ✅ 通过 | text.started/delta/ended → stream.markdown() |
| `session.next.reasoning.*` 事件流 | ✅ 通过 | reasoning.started/delta/ended → stream.thinkingProgress() |
| `session.next.step.*` 事件流 | ✅ 通过 | step.started/ended/failed — 静默处理不崩溃 |
| 旧事件向后兼容 | ✅ 通过 | `message.part.*` 事件处理完全保留，行为不变 |
| callID 去重 | ✅ 通过 | 同一 callID 新旧路径只推送一次 (`pushedCallIds: Set<string>`) |
| `vscode.Uri.file()` 修复 | ✅ 通过 | write/edit 工具返回正确的 Uri 对象 (scheme='file', path, fsPath) |
| 多工具顺序调用 | ✅ 通过 | 两个工具独立 beginToolInvocation + push |
| 工具失败 (isError=true) | ✅ 通过 | tool.failed → ChatToolInvocationPart.isError = true |
| 多 content 拼接 | ✅ 通过 | ToolTextContent[] → join 为单一 output string |
| proposed API 不可用 fallback | ✅ 通过 | 降级到 markdown 渲染 |
| 取消/空闲 停止 | ✅ 通过 | cancellation + session.idle 终止 |

### 文件变更摘要

| 文件 | 变更 |
|---|---|
| `src/participant/streaming.ts` | 517→834 行 (+317) — 新增 `session.next.*` 处理器、去重机制、`pushedCallIds`、`joinToolContent`、`deriveTitleFromInput` |
| `src/test/streaming-next.test.ts` | **新建** 892 行, 34 个测试用例 |
| `src/test/vscode-mock.ts` | 新增 `Uri.file()`, `Uri.parse()`, `MarkdownString` class |

---

## 剩余工作

### Phase 1: 类型重命名为 VSCode 原生名 (可选优化)

**优先级**: 低 — 当前自定义接口结构已与 VSCode 原生一致，只是名字不同。运行时无差异。

**改动**:
- `TerminalToolData` → `ChatTerminalToolInvocationData`
- `SimpleToolResultData` → `ChatSimpleToolResultData`
- `ToolResourcesData` → `ChatToolResourcesInvocationData`
- `SubagentToolData` → `ChatSubagentToolInvocationData` (注意 VSCode 中是 **class**)
- `ToolSpecificData` union → VSCode 原生 union + `ChatMcpToolInvocationData` + `ChatTodoToolInvocationData`
- `ToolInvocationPart` → `ChatToolInvocationPart` 属性: `invocationMessage` 等支持 `string | MarkdownString`

**风险**: proposed API 类型名可能变化，需要动态检测。

### Phase 2: MarkdownString 增强 (可选优化)

**优先级**: 低

**改动**: `invocationMessage`、`pastTenseMessage` 使用 `new vscode.MarkdownString()` 代替 plain string，支持加粗、链接等富文本。

### Phase 3: MCP 工具支持

**优先级**: 中 — 需要实际 MCP 事件数据来验证

**改动**: 
- 检测 MCP 工具（工具名前缀 `mcp__` 或 provider.metadata 中的标记）
- 使用 `ChatMcpToolInvocationData` 类型（input: string, output: McpToolInvocationContentData[]）
- 需要等待 OpenCode Server 实际发送 MCP 工具事件来验证数据结构

---

## 已验证的架构

### 事件处理流程 (streaming.ts processEvent)

```
processEvent(evt)
├── message.part.updated     → handlePartUpdated()     [旧路径]
├── message.part.delta       → handlePartDelta()       [旧路径]
├── session.next.tool.input.started  → handleNextToolInputStarted()   [新路径]
├── session.next.tool.input.delta    → handleNextToolInputDelta()     [新路径]
├── session.next.tool.input.ended    → handleNextToolInputEnded()     [新路径]
├── session.next.tool.called         → handleNextToolCalled()         [新路径]
├── session.next.tool.progress       → handleNextToolProgress()       [新路径]
├── session.next.tool.success        → handleNextToolSuccess()        [新路径]
├── session.next.tool.failed         → handleNextToolFailed()         [新路径]
├── session.next.text.delta          → handleNextTextDelta()          [新路径]
├── session.next.reasoning.delta     → handleNextReasoningDelta()     [新路径]
├── session.next.step.*              → 静默处理 (no-op)               [新路径]
└── session.idle              → return true (终止)
```

### 去重机制

```
pushedCallIds: Set<string>

handleToolState(completed)     → 检查 pushedCallIds.has(callID) → 跳过
handleNextToolSuccess()        → 检查 pushedCallIds.has(callID) → 跳过
handleNextToolFailed()         → 检查 pushedCallIds.has(callID) → 跳过

push 后 → pushedCallIds.add(callID)
reset() → pushedCallIds.clear()
```

### toolSpecificData 映射 (buildToolSpecificData)

| OpenCode tool | VSCode toolSpecificData | 状态 |
|---|---|---|
| `bash` / `shell` | `TerminalToolData` { commandLine, language, output, state.duration } | ✅ 已验证 |
| `read` / `list` / `grep` | `SimpleToolResultData` { input, output } | ✅ 已验证 |
| `write` / `edit` | `ToolResourcesData` { values: [vscode.Uri.file()] } | ✅ 已验证 + Uri 修复 |
| `task` / `subagent` | `SubagentToolData` { description, agentName, prompt, result } | ✅ 已验证 |
| MCP tools | `ChatMcpToolInvocationData` | ⬜ 待实现 (需实际数据) |
| (other) | `SimpleToolResultData` fallback | ✅ 已验证 |
