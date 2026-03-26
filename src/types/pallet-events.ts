/**
 * Types for events emitted by pallet-shielded-pool.
 * Hex strings are 0x-prefixed 32-byte LE Poseidon values.
 */

/** Emitted by `shield()` when a note is deposited. */
export type ShieldedEvent = {
    /** SS58 or 0x-prefixed AccountId of the depositor. */
    depositor: string;
    amount: bigint;
    /** 0x-prefixed 32-byte commitment hex (LE). */
    commitment: string;
    /** 0x-prefixed encrypted memo hex. */
    encryptedMemo: string;
    /** Leaf index assigned in the Merkle tree. */
    leafIndex: number;
};

/** Emitted by `private_transfer()`. */
export type PrivateTransferEvent = {
    /** Input nullifiers (0x-prefixed 32-byte hex each). */
    nullifiers: string[];
    /** Output commitments (0x-prefixed 32-byte hex each). */
    commitments: string[];
    /** Encrypted memos for each output. */
    encryptedMemos: string[];
    /** Leaf indices assigned to output commitments. */
    leafIndices: number[];
};

/** Emitted by `unshield()` when a note is withdrawn. */
export type UnshieldedEvent = {
    /** 0x-prefixed 32-byte nullifier hex (LE). */
    nullifier: string;
    amount: bigint;
    /** SS58 or 0x-prefixed AccountId of the recipient. */
    recipient: string;
};

/** Emitted after every Merkle tree update. */
export type MerkleRootUpdatedEvent = {
    /** 0x-prefixed previous root hex. */
    oldRoot: string;
    /** 0x-prefixed new root hex. */
    newRoot: string;
    /** New total number of leaves. */
    treeSize: number;
};

/** Discriminated union of all shielded-pool events. */
export type ShieldedPoolEvent =
    | { type: 'Shielded'; data: ShieldedEvent }
    | { type: 'PrivateTransfer'; data: PrivateTransferEvent }
    | { type: 'Unshielded'; data: UnshieldedEvent }
    | { type: 'MerkleRootUpdated'; data: MerkleRootUpdatedEvent };
