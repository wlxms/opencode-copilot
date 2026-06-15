# Learnings

## T22/T23: SSP Bridge Test Updates (2025-06-14)

### Changes Made

**handler.test.ts** (5 locations):
- Replaced `setTracker: vi.fn()` -> `setProjector: vi.fn()`
- Added `initializeEditSync: vi.fn()` to all bridge mock objects
- Removed all ExternalEditTracker references
- Result: 38/38 tests pass

**commands.test.ts** (1 location):
- Replaced `setTracker: vi.fn()` -> `setProjector: vi.fn()`
- Added `initializeEditSync: vi.fn()` to bridge mock
- Result: 11/11 tests pass

**streaming.test.ts** (major rewrite):
- Added `mockProjector()` with all 15 vi.fn() methods
- Added `mockSerializer()` with `append: vi.fn()`
- Added `beforeEach` that sets projector+serializer on bridge
- Rewrote permission.asked section (10 tests): removed ExternalEditTracker mock,
  replaced with SSP-based tests verifying auto-approve, callbacks, SSP lifecycle
- Updated all stream assertions to projector assertions:
  - `stream.markdown` -> `projector.markdown`
  - `stream.beginToolInvocation` -> `projector.beginToolInvocation` (3-arg signature)
  - `stream.thinkingProgress` -> `projector.thinkingProgress` (string arg, not object)
  - `stream.push` for tool data -> `projector.completeToolInvocation`
  - `stream.push` for subagent cards -> `projector.updateSubagentCard`/`pushFinalSubagentUpdate`
- Removed all `setTracker` calls and `mockTracker` variable
- Result: 40/40 tests pass

### Key Learnings

- `SubagentSSP.render()` uses `updateSubagentCard`/`pushFinalSubagentUpdate`, NOT `beginToolInvocation`/`completeToolInvocation`
- `ReasoningSSP.applyDelta()` passes raw string to `projector.thinkingProgress(text)`, not an object
- `SessionDiffSSP.render()` is a no-op (persistence only)
- `AssistantTextSSP.applyDelta()` calls `proj?.markdown(text)` for each delta
- `ToolInvocationSSP.update()` triggers `render()` via base class pipeline
- vitest (not bun test) must be used due to `vscode` module alias in vitest.config.ts
- The `opencode-bridge.test.ts` file does not exist yet (planned for future)

### Projector Interface (15 methods)
markdown, thinkingProgress, beginToolInvocation, updateToolInvocation,
completeToolInvocation, errorToolInvocation, beginExternalEdit, endExternalEdit,
pushToolInvocationFallback, updateSubagentCard, pushFinalSubagentUpdate,
pushToolSpecificData, progress, reference, finalize
