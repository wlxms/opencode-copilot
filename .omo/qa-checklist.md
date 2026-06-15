# Manual QA Checklist — SSP Direct-Stream Refactor

> Run after `F5` (Launch Extension Development Host) in VSCode.
> All scenarios below have passing automated tests (see mapping column).
> This checklist verifies VISUAL appearance and real SDK integration.

## Prerequisites
- [ ] OpenCode CLI installed and authenticated
- [ ] `npm run compile` succeeds (verified: `out/extension.js 2.4mb`)
- [ ] Press F5 to launch Extension Development Host
- [ ] Open Copilot Chat panel in dev host
- [ ] Type `@opencode hello` to verify participant is active

## Scenarios

### 1. Read Tool Card
**Input**: `@opencode read package.json`
**Automated test**: `streaming.test.ts > should push read tool as ChatSimpleToolResultData`
- [ ] Tool card appears with "Read [package.json]" invocation message
- [ ] Card shows file reference (clickable link)
- [ ] On complete, card folds (presentation: hiddenAfterComplete)
- [ ] **C1**: No past-tense message (no "Read package.json (0.3s)")
- [ ] Card stays collapsed after completion

### 2. Bash Tool Terminal
**Input**: `@opencode run npm test` (or any bash command)
**Automated test**: `streaming.test.ts > should push bash tool as ChatTerminalToolInvocationData`
- [ ] Tool card shows terminal-style UI with command
- [ ] Exit code visible (0 for success)
- [ ] Output text displayed in terminal area
- [ ] Card stays expanded after completion (not hiddenAfterComplete)

### 3. Write/Edit Tool (Normal)
**Input**: `@opencode create a file called test.txt with "hello"`
**Automated test**: `streaming.test.ts > should push write tool as a transient hidden-after-complete card`
- [ ] Tool card appears with "Writing [test.txt]" message
- [ ] On complete: card folds (hiddenAfterComplete)
- [ ] File reference link works (click to open file)

### 4. Edit Tool (Asked Flow)
**Input**: `@opencode edit src/index.ts to add a comment`
**Automated tests**: `streaming.test.ts > permission.asked lifecycle` (14 tests)
- [ ] Permission auto-approved (no user prompt blocking)
- [ ] ExternalEditPart created (undo stop)
- [ ] **No tool card shown** for the edit (suppressed by externalEditCallIds)
- [ ] File change visible in editor with undo support
- [ ] Ctrl+Z reverts the edit

### 5. Subagent Task Card
**Input**: `@opencode use a subagent to review the code`
**Automated test**: `streaming.test.ts > should push task tool as ChatSubagentToolInvocationData`
- [ ] Subagent card appears (expandable)
- [ ] Child tool calls grouped under parent card
- [ ] Progress summary visible (e.g., "3× read, 2× edit")
- [ ] Card shows agent name and description

### 6. Text Streaming
**Input**: `@opencode explain how this project works`
**Automated test**: `streaming.test.ts > should stream AI text even when user echo is missing`
- [ ] AI text appears token-by-token (not all at once)
- [ ] Markdown formatting rendered (bold, code blocks, lists)
- [ ] No duplicate text output

### 7. Reasoning Streaming
**Input**: `@opencode think step by step about the best architecture`
**Automated test**: `streaming.test.ts > should stream reasoning via thinkingProgress`
- [ ] Reasoning/thinking text appears in collapsible section
- [ ] Updates in real-time (token-by-token)
- [ ] If proposed API unavailable: reasoning silently skipped (no markdown fallback)

### 8. Multi-Turn Continuation
**Input**: Any prompt that triggers a subagent task
**Automated test**: `streaming.test.ts > should NOT stop on session.idle while subagent is active`
- [ ] After subagent completes, extension sends continuation prompt automatically
- [ ] AI continues responding after subagent results
- [ ] No premature session end

## Regression Checks
- [ ] Session history persists (`.acpilot/` directory)
- [ ] Session restore works (reopen Copilot Chat)
- [ ] Slash commands work: `/new`, `/help`, `/model`
- [ ] Cancel (Ctrl+C) aborts current operation
- [ ] Error messages display correctly (⚠️ prefix)

## Known Pre-Existing Issues (NOT caused by refactor)
- `collector-stream.test.ts > buildTurn`: ChatResponseTurn property name mismatch (mock issue)
- `event-replay-integration.test.ts > mixed`: Same property name issue
