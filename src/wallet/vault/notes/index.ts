/**
 * Notes: the record round trip, the provenance a wallet keeps about them, the
 * pure merge rules, and the in-memory cache a host mirrors.
 *
 * Everything here is synchronous and side-effect free apart from `record.ts`,
 * which reaches `crypto/`. No module in this layer touches storage.
 */
export { applyNoteStatus, encryptNote, decryptNoteRecord, noteBlindTag } from './record';
export {
    noteOrigin,
    stampOrigin,
    noteCreatedAt,
    noteCreatedTxHash,
    noteSpentTxHash,
    noteTxKind,
    stampCreatedAt,
    stampCreatedTxHash,
    stampSpentTxHash,
    ensureCreatedAt,
} from './meta';
export type { TxKind, NoteWithMeta } from './meta';
export { upsertNote, applyBatch, removeByCommitment, isNoteSelfConsistent } from './merge';
export { normalizeNote, normalizeNotes, NOTE_BIGINT_FIELDS } from './normalize';
export { createNotesCache } from './cache';
export type { NotesCache, ObservableNotesCache } from './cache';
