# VSCode Chat Editing 气泡 +N -N 渲染链路分析

## 问题背景

VSCode Chat 的编辑气泡（位于输入框上方）显示 `+N -N` 表示当前编辑会话中的行数变更。我们的扩展使用 `ChatResponseExternalEditPart` 机制追踪外部工具对文件的修改，但气泡始终显示 `+0 -0`，即使 diff 面板中能看到正确的变更。

## 完整数据流

```
┌──────────────────────────────────────────────────────────────┐
│ 1. Editing Session Entry 创建                                 │
│    ChatEditingModifiedDocumentEntry                           │
│    ├── originalModel (编辑前文件内容)                          │
│    └── modifiedModel (编辑后文件内容)                          │
│         │                                                      │
│         │ onDidChangeContent 事件                               │
│         ▼                                                      │
│ 2. ChatEditingTextModelChangeService._mirrorEdits()          │
│    │                                                           │
│    ▼                                                           │
│ 3. _updateDiffInfoSeq() → _updateDiffInfo()                  │
│    │  ⚠️ 关键守卫: state 必须 === ModifiedFileEntryState.Modified │
│    │  否则直接设 nullDocumentDiff → linesAdded=0, linesRemoved=0│
│    ▼                                                           │
│ 4. editorWorkerService.computeDiff(original, modified)        │
│    │                                                           │
│    ▼                                                           │
│ 5. _diffInfo.set(diff)   ← observable 更新                    │
│    │                                                           │
│    ▼                                                           │
│ 6. autorun → updateLineChangeCount(_diffInfo)                │
│    │  遍历 diff.changes 计算 linesAdded / linesRemoved         │
│    ▼                                                           │
│ 7. ChatEditingModifiedDocumentEntry.linesAdded (derived)     │
│    linesRemoved (derived)                                     │
│    │  这些也是 observable，依赖 _diffInfo                       │
│    ▼                                                           │
│ 8. chatInputPart.ts 第3378行 autorun(reader)                 │
│    │  entry.linesAdded?.read(reader)                          │
│    │  entry.linesRemoved?.read(reader)                        │
│    │  → diffMeta: { added, removed }                          │
│    ▼                                                           │
│ 9. 第3561行 DOM 渲染                                          │
│    _workingSetLinesAddedSpan.textContent = `+${added}`        │
│    _workingSetLinesRemovedSpan.textContent = `-${removed}`    │
└──────────────────────────────────────────────────────────────┘
```

## VSCode 关键源文件

| 文件 | 作用 |
|------|------|
| `chatEditingSession.ts` | 管理 editing session，包含 `startExternalEdits` / `stopExternalEdits` |
| `chatEditingModifiedDocumentEntry.ts` | 文件编辑 entry，暴露 `linesAdded` / `linesRemoved` observable |
| `chatEditingTextModelChangeService.ts` | 核心：`_mirrorEdits` → `_updateDiffInfoSeq` → `_updateDiffInfo` → `computeDiff` 链 |
| `chatEditingModifiedFileEntry.ts` | 抽象基类，管理 entry state、`acceptStreamingEditsEnd`、`revertToDisk` |
| `chatInputPart.ts` (第3378行) | autorun 读取 `entry.linesAdded/linesRemoved` 并渲染到 DOM |
| `chatModel.ts` | `_mergeOrPushTextEditGroup` 合并 textEdit 进度项 |
| `mainThreadChatAgents2.ts` | API 桥接：处理 `externalEdits` 和 `textEdit` progress |
| `chat/common/chat.ts` (第54行) | `editingSession.entries` 聚合所有 entry 的 added/removed |

## linesAdded / linesRemoved 的计算

```typescript
// chatEditingModifiedDocumentEntry.ts:60
get linesAdded() {
    return this._textModelChangeService.diffInfo.map(diff => {
        let added = 0;
        for (const c of diff.changes) {
            added += Math.max(0, c.modified.endLineNumberExclusive - c.modified.startLineNumber);
        }
        return added;
    });
}
get linesRemoved() {
    return this._textModelChangeService.diffInfo.map(diff => {
        let removed = 0;
        for (const c of diff.changes) {
            removed += Math.max(0, c.original.endLineNumberExclusive - c.original.startLineNumber);
        }
        return removed;
    });
}
```

## _updateDiffInfo 的关键守卫（+0 -0 的直接原因）

```typescript
// chatEditingTextModelChangeService.ts:484
private async _updateDiffInfo(): Promise<IDocumentDiff | undefined> {
    if (this.originalModel.isDisposed() || this.modifiedModel.isDisposed() || this._store.isDisposed) {
        return undefined;
    }

    // ⚠️ 关键：state 必须是 Modified，否则 diff 直接清零
    if (this.state.get() !== ModifiedFileEntryState.Modified) {
        this._diffInfo.set(nullDocumentDiff, undefined);
        this._originalToModifiedEdit = StringEdit.empty;
        return nullDocumentDiff;
    }

    const docVersionNow = this.modifiedModel.getVersionId();
    const snapshotVersionNow = this.originalModel.getVersionId();

    const diff = await this._editorWorkerService.computeDiff(
        this.originalModel.uri,
        this.modifiedModel.uri,
        { ignoreTrimWhitespace: false, computeMoves: false },
    );
    // ... version 检查后 set diff
}
```

## _mirrorEdits 的分支逻辑

```typescript
// chatEditingTextModelChangeService.ts:358
private _mirrorEdits(event: IModelContentChangedEvent) {
    const edit = offsetEditFromContentChanges(event.changes);
    const isExternalEdit = this._isExternalEditInProgress?.();

    if (this._isEditFromUs || isExternalEdit) {
        // 扩展自己应用的 edits 或 ExternalEdit → 跳过，不触发 diff 更新
        // 只更新 _originalToModifiedEdit 映射
    } else {
        // 用户手动编辑 → 触发 diff 更新
        this._updateDiffInfoSeq();
    }
}
```

## ExternalEdit 完整流程

```
1. Extension: push(ChatResponseExternalEditPart)
2. mainThreadChatAgents2.ts: progress.kind === 'externalEdits', start=true
3. chatEditingSession.startExternalEdits()
   → 设置 _isExternalEditInProgress = true
   → 捕获 baseline snapshot（currentContents）
   → 调用 callback（阻塞等待 completeEdit）
4. Callback 阻塞中 → 外部工具修改文件
5. Extension: completeEdit() → callback 返回
6. mainThreadChatAgents2.ts: progress.kind === 'externalEdits', start=false
7. chatEditingSession.stopExternalEdits()
   → computeEditsFromSnapshots() — 从 baseline snapshot 和当前内容计算 TextEdits
   → 生成 IChatProgress.textEdit（带 isExternalEdit=true）
   → _mergeOrPushTextEditGroup() 写入 chatModel
   → chatEditingServiceImpl 监听 textEditGroup 变化
   → addFileToEditingSession(uri) — 创建/获取 entry
   → entry.acceptAgentEdits() — 应用 edits 到 modifiedModel
   → revertToDisk() — ⚠️ 将 model 回退到磁盘内容
   → acceptStreamingEditsEnd() — 结束流式编辑
   → modifiedModel.onDidChangeContent 触发
   → _mirrorEdits 看到 _isEditFromUs=true
   → _updateDiffInfoSeq()
   → _updateDiffInfo()
   → ⚠️ state 检查：如果不是 Modified → nullDocumentDiff → +0 -0
   → computeDiff(original, modified)
   → _diffInfo.set(diff)
   → autorun → updateLineChangeCount → linesAdded / linesRemoved 更新
   → chatInputPart autorun → DOM 更新 `+N` / `-N`
```

## +0 -0 的根本原因假设

### 假设 1：Entry State 守卫（最可能）

`_updateDiffInfo` 要求 `state === ModifiedFileEntryState.Modified`。如果在 `revertToDisk` 之后、`_updateDiffInfo` 执行时，entry 的 state 已经变为非 Modified（如 Accepted 或 HasStaleEdits），diff 会被清零。

可能的 state 变化路径：
- `revertToDisk()` → model 和磁盘一致 → state 变为 `Accepted`（无差异）
- 之后再调用 `_updateDiffInfo` → state 不是 Modified → 返回 nullDocumentDiff → +0 -0

### 假设 2：Version 守卫

`_updateDiffInfo` 在异步 computeDiff 完成后检查 model version：
```typescript
const docVersionNow = this.modifiedModel.getVersionId();
// ... async computeDiff ...
if (this.modifiedModel.getVersionId() !== docVersionNow) {
    return undefined; // version 变了，丢弃结果
}
```

如果 `revertToDisk` 在 computeDiff 期间改变了 model version，diff 结果会被丢弃。

### 假设 3：_mirrorEdits 路径选择

ExternalEdit 期间 `_isExternalEditInProgress = true`，导致 `_mirrorEdits` 走"跳过"分支，不触发 `_updateDiffInfoSeq`。之后 `stopExternalEdits` 中的 `acceptAgentEdits` 又设置了 `_isEditFromUs = true`，再次跳过。最终可能没有正确触发 diff 更新。

## stream.textEdit() 为什么不行

`stream.textEdit()` 和 `ChatResponseExternalEditPart` 是**完全不同的系统**：

| | ExternalEditPart | stream.textEdit() |
|---|---|---|
| 创建 editing session entry | ✅ 是 | ❌ 否 |
| 有 original/modified model | ✅ 是 | ❌ 否 |
| 触发 _mirrorEdits 链 | ✅ 是 | ❌ 否 |
| 气泡 +N -N 数据 | ✅ 有 | ❌ 无 |
| diff 面板 | ✅ 显示 | ❌ 不显示 |
| 渲染方式 | editing session widget | 内联 TextEditContentPart |

`stream.textEdit()` 创建的是 `ChatResponseTextEditPart`，走 chat response 内联渲染，完全不经过 editing session 系统。气泡只从 editing session entries 读取 linesAdded/linesRemoved，所以 textEdit 路径无法影响气泡。

## 下一步调查方向

1. 在 `stopExternalEdits` 流程中添加日志，追踪 entry state 在 `revertToDisk` 前后的值
2. 确认 `_mirrorEdits` 是否在 `acceptAgentEdits` 后正确触发了 `_updateDiffInfoSeq`
3. 如果 state 确实变为非 Modified，找到方法阻止这个 state 变化，或在 state 变化前确保 diff 已计算完成
4. 考虑是否可以在 `stopExternalEdits` 完成后手动触发一次 diff 更新
