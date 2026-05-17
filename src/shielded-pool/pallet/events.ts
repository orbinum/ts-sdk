/**
 * TypeScript types for events emitted by pallet-shielded-pool.
 *
 * Conventions:
 *   - Byte arrays (Commitment, Nullifier, Hash) → `string`  (0x-prefixed hex, LE)
 *   - Balances (BalanceOf<T>)                   → `bigint`
 *   - AccountId                                 → `string`  (SS58 or 0x-prefixed)
 *   - BoundedVec<T, N>                          → `T[]`     (max N documented per field)
 *   - u32 / leaf indices                        → `number`
 *   - Option<T>                                 → `T | null`
 */

// ─── Core deposit / transfer / withdrawal ────────────────────────────────────

/**
 * Emitted by `shield()` when a note is deposited into the shielded pool.
 * Rust variant: `Shielded { depositor, amount, commitment, encrypted_memo, leaf_index }`
 */
export type ShieldedEvent = {
    /** SS58 AccountId of the depositor. */
    depositor: string;
    amount: bigint;
    /** 0x-prefixed 32-byte Poseidon commitment (LE). */
    commitment: string;
    /** 0x-prefixed encrypted memo bytes (104 bytes). */
    encryptedMemo: string;
    /** Leaf index assigned in the Merkle tree. */
    leafIndex: number;
};

/**
 * Emitted by `private_transfer()` when input nullifiers are spent.
 * Rust variant: `NullifiersSpent { nullifiers }`
 * Emitted independently of CommitmentsInserted to prevent graph correlation.
 */
export type NullifiersSpentEvent = {
    /** Input nullifiers consumed — max 2. 0x-prefixed 32-byte hex each. */
    nullifiers: string[];
};

/**
 * Emitted by `private_transfer()` when output commitments are inserted.
 * Rust variant: `CommitmentsInserted { commitments, encrypted_memos, leaf_indices }`
 * Emitted independently of NullifiersSpent to prevent graph correlation.
 */
export type CommitmentsInsertedEvent = {
    /** Output commitments created — max 2. 0x-prefixed 32-byte hex each. */
    commitments: string[];
    /** Encrypted memos for each output — max 2. */
    encryptedMemos: string[];
    /** Leaf indices assigned to output commitments — max 2. */
    leafIndices: number[];
};

/**
 * Emitted by `unshield()` when a note is withdrawn to the public chain.
 * Rust variant: `Unshielded { nullifier, amount, recipient, change_commitment }`
 */
export type UnshieldedEvent = {
    /** 0x-prefixed 32-byte Poseidon nullifier (LE). */
    nullifier: string;
    amount: bigint;
    /** SS58 AccountId of the recipient. */
    recipient: string;
    /**
     * 0x-prefixed 32-byte change note commitment (LE), or null for total unshield.
     * When present, the commitment has been inserted into the Merkle tree.
     */
    changeCommitment: string | null;
};

/**
 * Emitted after every Merkle tree update (shield / transfer / unshield).
 * Rust variant: `MerkleRootUpdated { old_root, new_root, tree_size }`
 */
export type MerkleRootUpdatedEvent = {
    /** 0x-prefixed previous Merkle root (32 bytes, LE). */
    oldRoot: string;
    /** 0x-prefixed new Merkle root (32 bytes, LE). */
    newRoot: string;
    /** Total number of leaves after the update. */
    treeSize: number;
};

// ─── Asset registry ───────────────────────────────────────────────────────────

/**
 * Emitted by `register_asset()` when a new asset is registered in the pool.
 * Rust variant: `AssetRegistered { asset_id }`
 */
export type AssetRegisteredEvent = {
    assetId: number;
};

/**
 * Emitted by `verify_asset()` when an asset is verified (marked as trusted).
 * Rust variant: `AssetVerified { asset_id }`
 */
export type AssetVerifiedEvent = {
    assetId: number;
};

/**
 * Emitted by `unverify_asset()` when an asset's verified status is removed.
 * Rust variant: `AssetUnverified { asset_id }`
 */
export type AssetUnverifiedEvent = {
    assetId: number;
};

// ─── Discriminated union ──────────────────────────────────────────────────────

/** All events emitted by pallet-shielded-pool as a discriminated union. */
export type ShieldedPoolEvent =
    | { type: 'Shielded'; data: ShieldedEvent }
    | { type: 'NullifiersSpent'; data: NullifiersSpentEvent }
    | { type: 'CommitmentsInserted'; data: CommitmentsInsertedEvent }
    | { type: 'Unshielded'; data: UnshieldedEvent }
    | { type: 'MerkleRootUpdated'; data: MerkleRootUpdatedEvent }
    | { type: 'AssetRegistered'; data: AssetRegisteredEvent }
    | { type: 'AssetVerified'; data: AssetVerifiedEvent }
    | { type: 'AssetUnverified'; data: AssetUnverifiedEvent };
