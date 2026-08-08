/**
 * The vault store: the top layer, where a session's keys, a storage backend and
 * a notes cache are composed into the object a wallet actually calls.
 */
export { VaultStore } from './VaultStore';
export type { VaultStoreDeps, VaultUnlockOptions } from './VaultStore';
export { detectCommitmentMismatch } from './unlock';
