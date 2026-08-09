/**
 * The shielded-pool protocol: what a note is and how one is built, sealed,
 * found and spent.
 *
 * ```
 * note/     build a note, open one that arrives, disclose what one holds
 * eph/      deterministic ephemerals — the hash-lookup discovery paths
 * spend/    the circuit's rules for pairing inputs
 * memo/     the 180-byte encrypted memo, and the plaintext inside it
 * types.ts  ZkNote, NoteInput, DecryptedMemo — the vocabulary
 * ```
 *
 * Pure and offline: no chain access, no storage, no environment. The argument
 * shapes for the extrinsics that carry these notes on chain live in
 * `pallet/extrinsicParams.ts` — a wallet can build, decrypt and select notes
 * without submitting anything.
 */
export * from './memo/index';
export * from './eph/index';
export * from './note/index';
export * from './spend/index';
export type {
    MerkleTreeInfo,
    ScanCommitment,
    DecryptedMemo,
    NoteInput,
    ZkNote,
    OutgoingNoteRecord,
} from './types';
export { CURRENT_CIRCUIT_VERSION } from './types';
