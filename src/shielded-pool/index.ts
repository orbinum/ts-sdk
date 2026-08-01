export { NoteBuilder } from './protocol/NoteBuilder';
export { EncryptedMemo, ENCRYPTED_MEMO_SIZE } from './protocol/EncryptedMemo';
export { serializeMemo, deriveViewTag } from './protocol/memo';
export { deriveSelfEphSk, selfEphWindow, type SelfEphWindowEntry } from './protocol/selfEph';
export { ShieldedPoolModule } from './pallet/ShieldedPoolModule';
export type {
    DecryptedMemo,
    MerkleTreeInfo,
    ScanCommitment,
    ShieldParams,
    ShieldBatchItem,
    ShieldBatchParams,
    ClaimShieldedFeesParams,
    UnshieldParams,
    PrivateTransferInput,
    PrivateTransferOutput,
    PrivateTransferParams,
    NoteInput,
    ZkNote,
} from './protocol/types';
export {
    tryDecryptNote,
    tryDecryptNoteVerbose,
    computeNullifier,
    computeNoteCommitment,
    type TryDecryptOptions,
} from './protocol/NoteDecryptor';
export { createNoteDisclosureKey, decodeNoteDisclosureKey } from './protocol/NoteDisclosure';
export type { NoteDisclosure } from './protocol/NoteDisclosure';
export { selectNotes, treeIdOf, buildDummyTransferInput } from './protocol/coinSelection';
export { CircuitVersionResolver } from './CircuitVersionResolver';
export type { ResolvedSpendVersion } from './CircuitVersionResolver';
