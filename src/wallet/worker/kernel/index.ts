/**
 * The pure decryption kernel: no I/O, no stores, no threading.
 *
 * Runs unchanged on the main thread or inside a worker — the pool decides
 * which. Everything crossing this boundary is structured-clone friendly.
 */
export { decryptHintBatch } from './decryptBatch';
export { clearKnownEphWindow, getKnownEphWindow } from './ephWindow';
export type { KnownEphWindow, KnownEphEntry } from './ephWindow';
export {
    SELF_EPH_WINDOW,
    PAIRWISE_EPH_WINDOW,
    OUTGOING_EPH_WINDOW,
    EMPTY_BATCH_RESULT,
} from './types';
export type { ScanKeys, DecryptBatchResult, SentNoteMatch, UnmatchedSentHint } from './types';
