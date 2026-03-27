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
 * Emitted by `private_transfer()`.
 * Rust variant: `PrivateTransfer { nullifiers, commitments, encrypted_memos, leaf_indices }`
 * Max 2 inputs / 2 outputs.
 */
export type PrivateTransferEvent = {
    /** Input nullifiers — max 2. 0x-prefixed 32-byte hex each. */
    nullifiers: string[];
    /** Output commitments — max 2. 0x-prefixed 32-byte hex each. */
    commitments: string[];
    /** Encrypted memos for each output — max 2. */
    encryptedMemos: string[];
    /** Leaf indices assigned to output commitments — max 2. */
    leafIndices: number[];
};

/**
 * Emitted by `unshield()` when a note is withdrawn to the public chain.
 * Rust variant: `Unshielded { nullifier, amount, recipient }`
 */
export type UnshieldedEvent = {
    /** 0x-prefixed 32-byte Poseidon nullifier (LE). */
    nullifier: string;
    amount: bigint;
    /** SS58 AccountId of the recipient. */
    recipient: string;
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

// ─── Audit policy ─────────────────────────────────────────────────────────────

/**
 * Emitted by `set_audit_policy()` when an account sets or updates its audit policy.
 * Rust variant: `AuditPolicySet { account, version }`
 */
export type AuditPolicySetEvent = {
    /** SS58 AccountId of the policy owner. */
    account: string;
    /** Policy version number (monotonically increasing). */
    version: number;
};

// ─── Disclosure ───────────────────────────────────────────────────────────────

/**
 * Emitted by `disclose()` when a note is disclosed.
 * Rust variant: `Disclosed { who, commitment, auditor }`
 */
export type DisclosedEvent = {
    /** SS58 AccountId of the discloser. */
    who: string;
    /** 0x-prefixed 32-byte commitment of the disclosed note. */
    commitment: string;
    /** SS58 AccountId of the auditor, or null for voluntary disclosure. */
    auditor: string | null;
};

/**
 * Emitted by `request_disclosure()` when an auditor requests a note disclosure.
 * Rust variant: `DisclosureRequested { target, auditor, reason }`
 */
export type DisclosureRequestedEvent = {
    /** SS58 AccountId of the note owner (disclosure target). */
    target: string;
    /** SS58 AccountId of the requesting auditor. */
    auditor: string;
    /** Reason string (max 256 bytes, UTF-8). */
    reason: string;
};

/**
 * Emitted by `reject_disclosure()` when a note owner rejects a disclosure request.
 * Rust variant: `DisclosureRejected { target, auditor, reason }`
 */
export type DisclosureRejectedEvent = {
    /** SS58 AccountId of the note owner. */
    target: string;
    /** SS58 AccountId of the auditor whose request was rejected. */
    auditor: string;
    /** Rejection reason string (max 256 bytes, UTF-8). */
    reason: string;
};

/**
 * Emitted when a pending disclosure request expires (on_finalize pruning).
 * Rust variant: `DisclosureRequestExpired { target, auditor }`
 */
export type DisclosureRequestExpiredEvent = {
    /** SS58 AccountId of the note owner. */
    target: string;
    /** SS58 AccountId of the auditor. */
    auditor: string;
};

/**
 * Emitted by `revoke_disclosure_record()` when an account revokes a previous disclosure.
 * Rust variant: `DisclosureRecordRevoked { who, commitment }`
 */
export type DisclosureRecordRevokedEvent = {
    /** SS58 AccountId of the note owner. */
    who: string;
    /** 0x-prefixed 32-byte commitment of the revoked note. */
    commitment: string;
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
    | { type: 'PrivateTransfer'; data: PrivateTransferEvent }
    | { type: 'Unshielded'; data: UnshieldedEvent }
    | { type: 'MerkleRootUpdated'; data: MerkleRootUpdatedEvent }
    | { type: 'AuditPolicySet'; data: AuditPolicySetEvent }
    | { type: 'Disclosed'; data: DisclosedEvent }
    | { type: 'DisclosureRequested'; data: DisclosureRequestedEvent }
    | { type: 'DisclosureRejected'; data: DisclosureRejectedEvent }
    | { type: 'DisclosureRequestExpired'; data: DisclosureRequestExpiredEvent }
    | { type: 'DisclosureRecordRevoked'; data: DisclosureRecordRevokedEvent }
    | { type: 'AssetRegistered'; data: AssetRegisteredEvent }
    | { type: 'AssetVerified'; data: AssetVerifiedEvent }
    | { type: 'AssetUnverified'; data: AssetUnverifiedEvent };
