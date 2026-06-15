# Issues

## BUG (FIXED): "Response stream has been closed"
**Fix**: Added `await externalEditPart.applied` after `stream.push(externalEditPart)`

---

## BUG: Reactive externalEdit tracks wrong files
**Symptom**: Reactive externalEdit fires for ANY file not in the open-editors set, including unrelated files.

**Root Cause**: The condition `!this.knownFileUris.has(fileUri)` is too broad — it fires for every file that wasn't open when the turn started. But OpenCode may edit many files, and not all should be tracked.

**Decision**: Revert the reactive externalEdit. The proactive approach (track open editors) is the correct baseline. New files created by OpenCode during the turn should use WorkspaceEditPart (which was already working), not externalEdit.

---

## BUG: First write tool got `status=error`
**Status**: Likely an OpenCode-side issue (not related to our checkpoint integration).


