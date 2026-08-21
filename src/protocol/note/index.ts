/**
 * A note's life off-chain: building one, opening one that arrives, and proving
 * what one holds without granting the power to spend it.
 */
export { NoteBuilder } from './NoteBuilder';
export {
    tryDecryptNote,
    tryDecryptNoteVerbose,
    computeNullifier,
    computeNoteCommitment,
    commitmentHexOf,
    collectOutgoingFacts,
} from './NoteDecryptor';
export { recoverSentNote, recoverSentFromSharedSecret } from './recoverSent';
export type { SentNoteFacts } from './recoverSent';
export { sealRecipientBookEntry, openRecipientBookEntry } from './recipientBook';
export { createNoteDisclosureKey, decodeNoteDisclosureKey } from './NoteDisclosure';
export type { NoteDisclosure } from './NoteDisclosure';
