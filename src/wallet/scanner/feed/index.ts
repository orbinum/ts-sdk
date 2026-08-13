/**
 * The feed contracts a host implements. Types only — no logic, no dependencies.
 *
 * The bottom of the scanner: every phase reads through one of these, and none of
 * them knows what backend answers.
 */
export type {
    ScanHint,
    ScanHintPage,
    ScanHintSource,
    ScanChunkManifest,
    ChunkInfo,
    NullifierSource,
    NullifierManifest,
    NullifierChunkBody,
    NullifierTail,
    TxFactsSource,
    ExtrinsicRecord,
    TransferFactsSource,
    TransferFactsRow,
    TransferOutputRow,
} from './sources';
