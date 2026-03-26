/**
 * Types for the arguments passed to pallet-shielded-pool extrinsics.
 * Byte arrays are represented as `number[]` to match SCALE encoding.
 */

/** Arguments for the `shield` extrinsic. */
export type ShieldArgs = {
    assetId: number;
    amount: bigint;
    /** 32-byte Poseidon commitment (LE). */
    commitment: number[];
    /** 104-byte encrypted memo. */
    encryptedMemo: number[];
};

/** Arguments for the `unshield` extrinsic. */
export type UnshieldArgs = {
    /** Groth16 proof bytes. */
    proof: number[];
    /** 32-byte Merkle root (LE). */
    merkleRoot: number[];
    /** 32-byte Poseidon nullifier (LE). */
    nullifier: number[];
    assetId: number;
    amount: bigint;
    /** 32-byte recipient AccountId. */
    recipient: number[];
};

/** Single input note for a private transfer. */
export type PrivateTransferInput = {
    /** 32-byte Poseidon nullifier (LE). */
    nullifier: number[];
    /** 32-byte Poseidon commitment (LE). */
    commitment: number[];
};

/** Single output note for a private transfer. */
export type PrivateTransferOutput = {
    /** 32-byte Poseidon commitment (LE). */
    commitment: number[];
    /** 104-byte encrypted memo. */
    memo: number[];
};

/** Arguments for the `private_transfer` extrinsic. */
export type PrivateTransferArgs = {
    inputs: PrivateTransferInput[];
    outputs: PrivateTransferOutput[];
    /** Groth16 proof bytes. */
    proof: number[];
    /** 32-byte Merkle root (LE). */
    merkleRoot: number[];
};
