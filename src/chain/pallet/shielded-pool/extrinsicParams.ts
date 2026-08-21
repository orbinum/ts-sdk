/**
 * The argument shapes the `shieldedPool` pallet's extrinsics accept.
 *
 * Separate from `protocol/types.ts` because these describe a CALL, not a note.
 * Field names and widths here track the pallet's signatures — a runtime upgrade
 * changes this file, while what a note is stays put.
 *
 * Every `amount` is planck and every hex string is 0x-prefixed. Commitments
 * travel LITTLE-endian: the chain accepts either byte order, and a big-endian
 * one produces a note that no scan can ever find (see `buildShieldParams`).
 */

/** Parameters for shieldedPool.shield — deposits one note into the pool. */
export type ShieldParams = {
    /** Asset ID being deposited. */
    assetId: number;
    /** Amount to deposit in planck. */
    amount: bigint;
    /** 0x-prefixed 32-byte commitment hex */
    commitment: string;
    /** Encrypted memo bytes (180 bytes). Required — notes without valid memos are irrecoverable. */
    encryptedMemo: Uint8Array;
};

/**
 * How the relay fee recipient is decided.
 *
 * It is not a parameter anywhere in this module: the chain reads it from the
 * dispatch origin, which calldata cannot influence. A `relayer` field would be an
 * unauthenticated claim — anyone could take a propagated proof, resubmit it
 * naming themselves, and collect a fee they never paid for.
 *
 * | Submitted via | Credited |
 * |---|---|
 * | EVM precompile | whoever signed that EVM transaction and paid its gas |
 * | Signed extrinsic | the signer's registered EVM address |
 * | Unsigned extrinsic | the block author |
 *
 * `fee` below still matters: it is a ZK public input, so it cannot be altered
 * without regenerating the proof. Only the *recipient* moved to the origin.
 */

/** Parameters for shieldedPool.unshield — withdraws from the pool to a clear address. */
export type UnshieldParams = {
    /** ZK proof bytes */
    proof: Uint8Array;
    /** 0x-prefixed merkle root hex */
    merkleRoot: string;
    /** 0x-prefixed nullifier hex */
    nullifier: string;
    /** Asset ID being withdrawn. */
    assetId: number;
    /** Net amount recipient receives (planck) */
    amount: bigint;
    /** SS58 or 0x-prefixed 32-byte address */
    recipientAddress: string;
    /** Gasless fee in planck (default 0n; note_value == amount + fee + changeValue in circuit) */
    fee?: bigint;
    /**
     * 0x-prefixed 32-byte change note commitment hex.
     * Pass the value returned by generateUnshieldProof().changeCommitment (converted to hex).
     * Omit or use all-zero hex for total unshield (no change note).
     */
    changeCommitment?: string;
    /**
     * Encrypted memo for the change note (180 bytes).
     * Required for partial unshield so the change note can be recovered via blockchain scan.
     * Omit for total unshield.
     */
    changeEncryptedMemo?: Uint8Array;
    /** Circuit version the spent note was created under. Verified against that version's VK. */
    circuitVersion: number;
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
    /** Encrypted memo bytes (180 bytes). Required — notes without valid memos are irrecoverable. */
    encryptedMemo: Uint8Array;
};

export type PrivateTransferParams = {
    /** Input notes being spent (nullifier + commitment each). */
    inputs: PrivateTransferInput[];
    /** Output notes being created (commitment + encrypted memo each). */
    outputs: PrivateTransferOutput[];
    /** ZK proof bytes */
    proof: Uint8Array;
    /** 0x-prefixed merkle root hex */
    merkleRoot: string;
    /** Asset ID being transferred (public input of the proof) */
    assetId: number;
    /** Gasless fee in planck (default 0n; input_sum == output_sum + fee in circuit).
     *  The fee is paid to the block author (validator) by the pallet runtime. */
    fee?: bigint;
    /** Circuit version the input notes were created under. Verified against that version's VK. */
    circuitVersion: number;
};

/** Parameters for a single item in a shield_batch extrinsic. */
export type ShieldBatchItem = {
    /** Asset ID being deposited. */
    assetId: number;
    /** Amount to deposit in planck. */
    amount: bigint;
    /** 0x-prefixed 32-byte commitment hex */
    commitment: string;
    /** Encrypted memo bytes (180 bytes). Required — notes without valid memos are irrecoverable. */
    encryptedMemo: Uint8Array;
};

/** Parameters for shieldedPool.shieldBatch — deposits up to 20 notes in one extrinsic. */
export type ShieldBatchParams = {
    /** The notes to deposit (up to 20). */
    items: ShieldBatchItem[];
};

/**
 * Parameters for shieldedPool.claimShieldedFees —
 * claims accrued relay fees into the shielded pool.
 *
 * The relayer must supply a ZK value proof that binds the commitment to the
 * exact amount and asset_id, preventing fee inflation attacks.
 */
export type ClaimShieldedFeesParams = {
    /** 0x-prefixed 32-byte commitment hex (Poseidon of value, assetId, ownerPk, blinding) */
    commitment: string;
    /** Amount to claim in planck (must match the circuit's public input) */
    amount: bigint;
    /** Asset ID being claimed */
    assetId: number;
    /** 128-byte Groth16 proof bytes */
    proof: Uint8Array;
    /** 76-byte public signals buffer (commitment || amount_u64_le || assetId_u32_le || owner_hash) */
    publicSignals: Uint8Array;
    /** Encrypted memo bytes (180 bytes). Required — notes without valid memos are irrecoverable. */
    encryptedMemo: Uint8Array;
    /** Circuit version of the fee-claim note. Verified against that version's VK. */
    circuitVersion: number;
};
