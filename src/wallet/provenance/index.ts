/**
 * NoteProvenance — the wallet's private history of its own notes.
 *
 * Two mechanisms feed it, and this module is the vocabulary both speak:
 * the memo's `sourcePk` (readable by whoever can decrypt the note) and a lookup
 * by commitment, which returns public fields only.
 * `ProvenanceSource` records which one spoke for a given record.
 *
 * Nothing here derives or relates keys — this layer only holds facts already
 * recovered elsewhere.
 */
export type {
    NoteOrigin,
    ProvenanceSource,
    PkScope,
    ProvenancePeer,
    ProvenanceAmount,
    NoteProvenanceRecord,
} from './types';

export {
    hasSourcePk,
    selectDescribingNote,
    selectDescribingNoteByCommitment,
} from './selectDescribingNote';

export { mergeProvenance, outranks } from './merge';

export { regeneratePaymentSlip } from './regenerateSlip';
