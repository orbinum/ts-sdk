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
    /** Counterparty BabyJubJub Ax coordinate. Zero for shield/unshield notes. */
    counterpartyPk: bigint;
};

export type ShieldParams = {
    assetId: number;
    amount: bigint;
    /** 0x-prefixed 32-byte commitment hex */
    commitment: string;
    /** Encrypted memo bytes (168 bytes). Required — notes without valid memos are irrecoverable. */
    encryptedMemo: Uint8Array;
};

export type UnshieldParams = {
    /** ZK proof bytes */
    proof: Uint8Array;
    /** 0x-prefixed merkle root hex */
    merkleRoot: string;
    /** 0x-prefixed nullifier hex */
    nullifier: string;
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
     * Encrypted memo for the change note (176 bytes).
     * Required for partial unshield so the change note can be recovered via blockchain scan.
     * Omit for total unshield.
     */
    changeEncryptedMemo?: Uint8Array;
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
    /** Encrypted memo bytes (168 bytes). Required — notes without valid memos are irrecoverable. */
    encryptedMemo: Uint8Array;
};

export type PrivateTransferParams = {
    inputs: PrivateTransferInput[];
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
     * 32-byte LE-encoded packed BJJ viewing public key of the recipient (from their privacy address).
     * When provided, NoteBuilder.build() will auto-generate the 168-byte ECDH-encrypted memo.
     * Omit to skip memo generation (use buildMemo() separately if needed).
     */
    viewingPublicKey?: Uint8Array;
    /**
     * BabyJubJub Ax coordinate of the recipient (from their privacy address).
     * Required together with viewingPublicKey to enable stealth address derivation:
     * the commitment will use stealthOwnerPk instead of ownerPk, making each
     * transaction unlinkable even when the same privacy address is reused.
     */
    recipientOwnerPk?: bigint;
    /** Counterparty BabyJubJub Ax coordinate. Zero for shield/unshield notes. Default 0n. */
    counterpartyPk?: bigint;
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
     * 168-byte encrypted memo (ChaCha20-Poly1305 ECDH) as number[] for SCALE encoding.
     * Always populated: uses a dummy memo when no viewingPublicKey is provided.
     */
    memo: number[];
    /** Counterparty BabyJubJub Ax coordinate. Zero for shield/unshield notes. */
    counterpartyPk: bigint;
};

/** Parameters for a single item in a shield_batch extrinsic. */
export type ShieldBatchItem = {
    assetId: number;
    amount: bigint;
    /** 0x-prefixed 32-byte commitment hex */
    commitment: string;
    /** Encrypted memo bytes (168 bytes). Required — notes without valid memos are irrecoverable. */
    encryptedMemo: Uint8Array;
};

/** Parameters for shieldedPool.shieldBatch — deposits up to 20 notes in one extrinsic. */
export type ShieldBatchParams = {
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
    /** Encrypted memo bytes (168 bytes). Required — notes without valid memos are irrecoverable. */
    encryptedMemo: Uint8Array;
};
