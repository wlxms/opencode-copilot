# Serializable Stream Part Architecture

## Goal

The session pipeline should be organized around persistent data concepts, not
around the incidental live request flow. The request flow is fixed: create or
reuse a session, stream a turn, persist incrementally, then finalize the turn.
The extensibility point is the persisted stream part model.

This architecture introduces `SerializableStreamPart` (SSP) as the extension's
own canonical stream unit. SSPs are not required to map one-to-one to VS Code
chat parts. They are stable persistence records that can be projected into live
VS Code streams, restored VS Code history, diagnostics, tests, or another future
surface.

## Concept Model

```text
SerializableSession
| > create session directory and write initial meta
| - SessionMetaStore
| - TitleLifecycle
|     -> start from first prompt
|     -> async patch SessionMeta and backend title
| - SerializableTurn
    | > write TurnMeta with prompt and request id
    | - StreamingRecorder
        | - StreamingBridge
            | - EventHandler
                -> SerializableStreamPart[]
        | > append SSP records incrementally
        | > update derived indexes when needed
    | > post processing: message id, status, flush, turn-end only
```

Deserialization follows the same data concepts:

```text
SerializableSessionReader
| > read SessionMeta
| - SerializableTurnReader
    | > read TurnMeta
    | > read SerializableStreamPart[]
    | > rebuild derived indexes from part meta if missing
    | - RestoreProjector
        -> VS Code ChatRequestTurn / ChatResponseTurn
```

## Ownership

`SerializableSession` owns session identity, title state, archived state,
checkpoint approval cursor, and session-level indexes.

`TitleLifecycle` is a session concern. It starts when the first prompt is known,
not at turn finalization. Turn finalization may reconcile an already observed
title, but should not be the primary naming path.

`SerializableTurn` owns prompt, turn index, VS Code request id, backend message
id, status, and timing.

`SerializableStreamPart` owns extensible streamed content plus local recovery
metadata.

`Projector` is an adapter from SSP records to a target surface. A projector does
not own data or session lifecycle. It only renders or materializes SSPs.

Examples:

- Live VS Code projector: SSP -> `ChatResponseStream`
- Restore VS Code projector: SSP -> `ChatRequestTurn` / `ChatResponseTurn`
- Debug projector: SSP -> logs or test assertions

## SSP Shape

```ts
interface SerializableStreamPart<TKind extends string = string, TPayload = unknown> {
  kind: TKind;
  version: number;
  id: string;
  payload: TPayload;
  meta: SerializableStreamPartMeta;
}
```

`payload` describes the content of this part.

`meta` describes serialization and recovery semantics: ownership, ordering,
source event, tool call correlation, edit id correlation, request id, and schema
metadata.

Fields may appear in both places only when they serve both purposes. For
example, a file URI can be display content in `payload` and an index hint in
`meta`. When there is duplication, the recovery contract must define the source
of truth.

## Implemented Parts

The default path now persists specialized SSP records:

- `userPrompt`
- `assistantText`
- `assistantTextDelta`
- `reasoning`
- `reasoningDelta`
- `toolInvocation`
- `sessionLifecycle`
- `sessionDiff`
- `interactionRequest`
- `interactionResponse`
- `externalEdit`
- `externalEditMetadata`
- `rawAcpEvent`

`rawAcpEvent` remains a lossless fallback for unknown or newly added backend
events, but it is no longer the normal record for common chat, tool, lifecycle,
interaction, or edit metadata.

## Meta Update Contract

Session meta is not immutable after creation. It is patch-only after creation.
Allowed updates include:

- generated title
- backend title event
- request details derived from external edit SSP meta
- checkpoint cursor
- change approval state
- archived state
- status

The important rule is that updates must merge through a typed patch path. No
post-turn full meta rewrite should be able to erase request details or part
indexes.

## Current Feature Coverage

This model covers the current behavior through these invariants:

- Live streaming appends SSP records as events arrive.
- Restore prefers SSP records, then falls back to legacy raw event records.
- SSP meta contains enough data to rebuild turn ownership and request ids.
- External edit SSPs carry `requestId`, `toolCallId`, and `editId` locally.
  Restore merges those records with `_meta.json.requestDetails` so the edit
  bubble can recover even when the session meta index is incomplete.
- Session-level `_meta.json` remains a fast index and session state file, not
  the only source of part recovery truth.
- Checkpoints remain artifact records, referenced by SSP meta or payload.
- Fork/rewind remain session and turn metadata concerns, not plain stream parts.
- `permission.asked` and `question.asked` are persisted even though the bridge
  handles them as synchronous UI barriers.
- First-prompt naming is a session concern: the provisional prompt title is
  written immediately, and generated titles patch meta/backend asynchronously.
  Turn finalization only reconciles titles already observed from the backend.

## Feature Flag

`opencode.experimental.serializableStreamParts` controls the new path.

Default: `true`.

When enabled:

- live persistence writes SSP records (`stream-part`) instead of legacy raw
  `event` records;
- restore reads SSP records, rebuilds request/edit indexes from SSP meta, and
  projects specialized SSP records into the current ACP restore renderer;
- legacy event records remain readable as fallback.

When disabled:

- live persistence writes legacy `event` records;
- restore reads legacy event records.
