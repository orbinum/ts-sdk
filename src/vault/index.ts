export { vaultReplacer, vaultReviver } from './VaultJson';
export { deriveVaultKey, encryptJson, decryptJson } from './VaultCrypto';
export type { EncryptedNoteRecord, NoteStatusUpdate } from './types';
export { VaultLockedError } from './errors';
export { applyNoteStatus, encryptNote, decryptNoteRecord } from './noteOps';
