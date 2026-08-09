/**
 * A note's life off-chain: building one, opening one that arrives, and proving
 * what one holds without granting the power to spend it.
 */
export { NoteBuilder } from './NoteBuilder';
export {
    tryDecryptNote,
    tryDecryptNoteVerbose,
    tryRecoverOutgoing,
    computeNullifier,
    computeNoteCommitment,
    commitmentHexOf,
} from './NoteDecryptor';
export type { OutgoingHint } from './NoteDecryptor';
export { createNoteDisclosureKey, decodeNoteDisclosureKey } from './NoteDisclosure';
export type { NoteDisclosure } from './NoteDisclosure';
