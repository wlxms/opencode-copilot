# Decisions - SSP Architecture v2

## Architecture
- SSP upgraded from interface to abstract class
- Bridge downgraded from 2001-line state machine to ~200-line event router
- Projector as interface (not hardcoded) for multi-surface support
- ExternalEditSSP encapsulates full edit lifecycle
- Edit sync owned by Backend/Bridge, not extension layer

## Key Files
- src/acp/serializable/types.ts:90-99 — Current SSP interface (backward compat target)
- src/acp/serializable/stream-parts.ts — Current AcpEvent → SSP converter
- src/backends/opencode/opencode-bridge.ts — 2001-line Bridge to rewrite
