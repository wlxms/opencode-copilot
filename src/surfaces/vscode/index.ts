/**
 * VS Code surface exports.
 *
 * Runtime OpenCode events are interpreted by the backend bridge and emitted as
 * SSP parts. The VS Code surfaces consume that shared bridge/SSP pipeline
 * instead of owning protocol-specific rendering logic.
 *
 * @module
 */
export * from './capabilities';
export * from './stable-participant';
export * from './experimental-session';
export * from './language-model-provider';
