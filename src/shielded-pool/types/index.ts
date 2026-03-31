import type { TxResult } from '../../client/types';

export type MerkleTreeInfo = {
    root: string;
    treeSize: number;
    depth: number;
};

export type ScanCommitment = {
    commitmentHex: string;
    leafIndex: number;
    encryptedMemo: string | null;
};

export type DecryptedMemo = {
    value: bigint;
    ownerPk: bigint;
    blinding: bigint;
    assetId: bigint;
};

export type ShieldParams = {
    assetId: number;
    amount: bigint;
    /** 0x-prefixed 32-byte commitment hex */
    commitment: string;
    /** Optional encrypted memo bytes. Auto-generates a dummy memo if absent. */
    encryptedMemo?: Uint8Array;
};

export type UnshieldParams = {
    /** ZK proof bytes */
    proof: Uint8Array;
    /** 0x-prefixed merkle root hex */
    merkleRoot: string;
    /** 0x-prefixed nullifier hex */
    nullifier: string;
    assetId: number;
    amount: bigint;
    /** SS58 or 0x-prefixed 32-byte address */
    recipientAddress: string;
};

export type PrivateTransferInput = {
    /** 0x-prefixed nullifier hex */
    nullifier: string;
    /** 0x-prefixed commitment hex */
    commitment: string;
};

export type PrivateTransferOutput = {
    /** 0x-prefixed commitment hex */
    commitment: string;
    encryptedMemo?: Uint8Array;
};

export type PrivateTransferParams = {
    inputs: PrivateTransferInput[];
    outputs: PrivateTransferOutput[];
    /** ZK proof bytes */
    proof: Uint8Array;
    /** 0x-prefixed merkle root hex */
    merkleRoot: string;
};

/** Input params for NoteBuilder.build(). All fields except value have defaults. */
export type NoteInput = {
    /** Amount in planck (required). */
    value: bigint;
    /** Asset ID — default 0 (native ORB-Privacy). */
    assetId?: bigint;
    /** BabyJubJub Ax coordinate (owner public key x). Default 0n. */
    ownerPk?: bigint;
    /** Random blinding scalar. Defaults to BigInt(Date.now()). */
    blinding?: bigint;
    /** Secret spending key used to derive the nullifier. Default 0n. */
    spendingKey?: bigint;
    /**
     * 32-byte recipient viewing key used to encrypt the memo (ChaCha20-Poly1305).
     * When provided, NoteBuilder.build() will auto-generate the 104-byte encrypted memo.
     * Omit to skip memo generation (use buildMemo() separately if needed).
     */
    viewingKey?: Uint8Array;
};

/**
 * Computed ZK note (commitment + nullifier). Built entirely off-chain.
 *
 * commitment = Poseidon(value, assetId, ownerPk, blinding)
 * nullifier  = Poseidon(commitment, spendingKey)
 */
export type ZkNote = {
    value: bigint;
    assetId: bigint;
    ownerPk: bigint;
    blinding: bigint;
    spendingKey: bigint;
    /** Whether the note has been spent/nullified on-chain. */
    spent: boolean;
    /** Local timestamp when this note was marked spent, or null if still active/unknown. */
    spentAt: number | null;
    /** Poseidon commitment scalar. */
    commitment: bigint;
    /** Poseidon nullifier scalar. */
    nullifier: bigint;
    /** 0x-prefixed 32-byte little-endian hex commitment. */
    commitmentHex: string;
    /** 0x-prefixed 32-byte little-endian hex nullifier. */
    nullifierHex: string;
    /**
     * 104-byte encrypted memo (ChaCha20-Poly1305) as number[] for SCALE encoding.
     * Always populated: uses a dummy memo when no viewingKey is provided.
     */
    memo: number[];
};

/** Result of buildAndShield: the submitted tx and the note to keep safe. */
export type ShieldResult = {
    txResult: TxResult;
    note: ZkNote;
};

/** Parameters for a single item in a shield_batch extrinsic. */
export type ShieldBatchItem = {
    assetId: number;
    amount: bigint;
    /** 0x-prefixed 32-byte commitment hex */
    commitment: string;
    /** Optional encrypted memo bytes. Auto-generates a dummy memo if absent. */
    encryptedMemo?: Uint8Array;
};

/** Parameters for shieldedPool.shieldBatch — deposits up to 20 notes in one extrinsic. */
export type ShieldBatchParams = {
    items: ShieldBatchItem[];
};
