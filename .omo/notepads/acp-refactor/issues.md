
## QA Session 2026-06-14 — Streaming Test Regressions

**17 new failures in pre-existing streaming integration tests** caused by refactored handler.ts / opencode-bridge.ts:

- `e2e-backend-serialize.test.ts`: 1 failure — collector.parts.length = 0 after bridge replay
- `event-replay-integration.test.ts`: 6 new failures — text, reasoning, bash, write, read, multiple tools no longer produce parts
- `handler-restore-integration.test.ts`: 10 failures — all restore integration tests fail

Likely root cause: `createBridge()` and event replay paths changed in the refactored handler/bridge code. The streaming tests mock event flows that no longer match the new code paths.

**These need to be updated to match the refactored architecture** — not reverted.
