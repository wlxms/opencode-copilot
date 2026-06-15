# Learnings

## 2026-05-14 Session Start
- Branch: feat/checkpoint-externalEdit
- All 7 tasks + 4 final wave tasks from plan
- handler.ts prompt() is fire-and-forget (line 332), bridge starts separately (line 370)
- StreamBridge constructor accepts StreamBridgeOptions with logger and sessionId
- VS = vscode as ProposedVscode is the runtime access pattern for proposed classes
- Existing tests: vitest, vscode-mock.ts, test files in src/test/
- The extension already has chatParticipantAdditions enabled in package.json

## CheckpointManager created (Task 1)
- File: src/participant/checkpoint.ts
- TextDocument has no .scheme — use doc.uri.scheme instead
- Pre-existing TS errors in vscode-proposed-additions.ts (not ours): missing constructors on ChatToolFileReference, ChatToolEditPart
- Per-turn instantiation pattern: new CheckpointManager() per chat request
- idleResolve callback pattern: store resolve fn, null-check before calling
- dispose() resolves pending promise as cleanup
- collectOpenFileUris() is a standalone export at bottom of file

## Task 3: handler.ts refactor (completed 2026-05-14)

### Changes Made
- **File**: `src/participant/handler.ts` only
- Lines 324-436 replaced with checkpoint wrapper + `executeTurnWithBridge()` closure

### Key Implementation Details
- `executeTurnWithBridge()` is a closure capturing: `client`, `state`, `sessionId`, `vscodeSessionId`, `directory`, `request`, `stream`, `token`, `checkpoint`
- Runtime check: `(vscode as any).ChatResponseExternalEditPart` — if class exists AND files > 0 → wraps in externalEdit callback; else → graceful degradation
- Cancel handler now calls `checkpoint.resolveIdle()` to unblock externalEdit callback on abort
- `checkpoint.resolveIdle()` + `checkpoint.dispose()` at end of callback signals completion
- `collectOpenFileUris()` wrapped in try/catch — `vscode.workspace.textDocuments` may be undefined in test mock
- Return metadata updated to `state.sessionMap.get(vscodeSessionId)?.turnMap ?? []` since `chatState` variable moved into closure
- `stream.push(externalEditPart)` is fire-and-forget — VS Code processes async via microtask, baseline captured before callback runs

### Test Verification
- All 73 tests pass
- LSP diagnostics clean
- `tsc --noEmit` (lint) clean

## Task 2: ChatResponseWorkspaceEditPart in streaming.ts (completed 2026-05-14)

### Changes Made
- **File**: src/participant/streaming.ts only
- Added knownFileUris?: Set<string> to StreamBridgeOptions interface
- Added private knownFileUris: Set<string> field to StreamBridge class
- Constructor stores options.knownFileUris ?? new Set()
- In handleToolState completed handler, after the if/else for pushToolInvocation vs renderToolFallback:
  - Checks 	oolName === 'write' and VS.ChatResponseWorkspaceEditPart exists
  - Reads state.input.filePath, converts to URI, checks against knownFileUris
  - If new file, pushes ChatResponseWorkspaceEditPart([{ newResource: Uri.file(filePath) }]) via stream.push()
  - Wrapped in try/catch for best-effort behavior

### Key Details
- WorkspaceEditPart push happens AFTER the ChatToolInvocationPart push, independent of hasToolUI
- stream.push is checked before use (may not exist on all stream types)
- For now knownFileUris defaults to empty Set (Task 4 will connect it from handler.ts via CheckpointManager)
- ChatWorkspaceFileEdit was already imported from Task 1 changes
- All 73 tests pass, lint clean

## T4: Connect proactive file URIs to StreamBridge + reactive tracking

- handler.ts line ~382: StreamBridge constructor now receives knownFileUris: new Set(fileUris.map(u => u.toString())) from CheckpointManager's collected URIs
- streaming.ts: added diagnostic log after WorkspaceEditPart block for edit/write tools touching files outside the proactive set
- The reactive tracking is best-effort logging only; the real tracking comes from: (1) proactive externalEdit baseline captures all open editors, (2) WorkspaceEditPart for new files (T5 write tool)
- For edit tool on non-proactive files, VS Code's built-in dirty-state tracking already covers open editors; the log helps diagnose edge cases
- Both changes are additive — no existing behavior modified

## Task 6: Cancel/error cleanup for checkpoint state (completed 2026-05-14)

### Changes Made
- **File**: src/participant/handler.ts only

### Key Implementation Details
- checkpoint instance moved BEFORE outer try/catch (line 295) so it's in scope for catch block
  - Original plan said checkpoint was accessible in catch — but JS block scoping means const inside 	ry {} is NOT visible in catch {}
  - Solution: const checkpoint = new CheckpointManager() before the outer try. Lightweight object, acceptable overhead on early-return paths.
- Inner 	ry { ... } finally { checkpoint.dispose() } wraps the externalEdit/fallback branching (Change 1)
  - inally only disposes if NOT in externalEdit path (externalEdit callback handles its own dispose)
  - Condition: if (!ExternalEditCtor || fileUris.length === 0)
- Cancel handler (line ~379): added comment documenting OpenCode session.revert() as fallback
- Outer catch block: added checkpoint.dispose() as safety net for unexpected errors

### Test Verification
- All 73 tests pass
- Lint (tsc --noEmit) clean
- LSP diagnostics: no errors

## Task 7: Unit tests for checkpoint integration (completed 2026-05-14)

### Files Created/Modified
- **Created**: src/test/checkpoint.test.ts (12 tests)
- **Modified**: src/test/handler.test.ts (+3 tests, total 17)

### Test Coverage
- CheckpointManager: createIdlePromise, resolveIdle, waitForIdle, hasActiveCheckpoint, setFileUris/getFileUris, addAdditionalUri/getAdditionalUris, dispose
- collectOpenFileUris: filters file-scheme non-untitled docs, handles empty docs
- Handler checkpoint flow: ExternalEditCtor unavailable (degradation), no open files (skip), with files (enabled)

### Key Learnings
- vitest i.fn().mockImplementation() with arrow functions CANNOT be used with 
ew. Use plain unction declarations for mock constructors.
- Handler's external edit path is fire-and-forget: stream.push(externalEditPart) returns immediately, callback runs later. Handler still returns metadata with sessionId since that's set before the push.
- stream.push is already mocked in the existing handler tests (push: vi.fn()) so no changes needed to vscode-mock.ts.
- scode.workspace.textDocuments can be directly set on the mock for collectOpenFileUris testing.
- Total test count: 88 (was 73, added 15 new tests)

### Wave 5 Completion — 2026-06-14 01:48

#### T24: ExternalEditTracker cleanup
- Deleted src/test/external-edit-tracker.test.ts (70 lines)
- Removed import { ExternalEditTracker } from '../../participant/external-edit-tracker' from src/test/checkpoint/replay.test.ts (line 8)
- Rewrote ecordTrackedEdit() helper (lines 817-857) to manually capture before/after file snapshots instead of using the deleted ExternalEditTracker
- New implementation: reads file before mutate, creates FileSnapshotRecord entries, runs mutate, reads file after, creates after entries
- Zero ExternalEditTracker references remain in codebase (grep -r confirms)

#### T25: SSP test coverage verification
- un test src/test/ssp/ — **102 tests pass, 0 fail across 11 files**
- Files: assistant-text, external-edit, factory, tool-invocation, reasoning, subagent, session-lifecycle, interaction, raw-acp-event, compat, types
- All 11 SSP types covered. Session-diff tested via session-lifecycle test.

#### T26: Projector tests + integration e2e
- un test src/test/projector/ — **77 tests pass, 0 fail across 4 files**
- Created src/test/projector/projector-integration.test.ts with 10 integration tests:
  - Full pipeline: step-start → text deltas → tool lifecycle → session.idle
  - Text deltas call projector.markdown via applyDelta path
  - Reasoning deltas call projector.thinkingProgress via applyDelta path
  - Tool events call projector.beginToolInvocation via update() → render()
  - SSP ordering verification (sessionLifecycle, assistantText, toolInvocation)
  - Tool payload serialization verification
  - JSONL format validation (version header, stream-part lines)
  - Empty stream handling
  - Projector capability detection
- Key insight: VSCSPProjector.toJSON() output is { kind, version, id, payload, meta } — fields like toolName are nested under payload
- Key insight: update() calls merge() → serializer.append() → render(), so projector methods ARE called during processEvent path

#### Final verification
- un test src/test/checkpoint/ src/test/ssp/ src/test/projector/ src/test/serializer/ — **221 tests pass, 0 fail across 18 files**
- xperimental-session.test.ts has pre-existing vi.mocked Bun compatibility issue (not caused by these changes)

