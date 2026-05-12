/**
 * TypeScript types for pallet-shielded-pool extrinsics and supporting structures.
 *
 * Conventions:
 *   - Fixed/bounded byte arrays  → `number[]`  (SCALE-compatible)
 *   - Balances (u128)            → `bigint`
 *   - AccountId                  → `string`    (SS58 or 0x-prefixed 64-char hex)
 *   - Block numbers              → `number`
 *   - Optional fields            → `T | null`
 */

// ─── Shared primitives ────────────────────────────────────────────────────────

/**
 * 32-byte SCALE-encoded value (commitment, nullifier, Merkle root, etc.).
 * Stored as little-endian Poseidon field elements on-chain.
 */
export type Bytes32 = number[];

/**
 * 176-byte encrypted memo (ChaCha20-Poly1305 ECDH).
 * Layout: nonce(12) || ciphertext(132) || tag(16) || ephPk(32) = 176 bytes.
 */
export type Bytes176 = number[];

/**
 * Disclosure public signals — exactly 256 bytes (ECDH Baby Jubjub layout):
 *   commitment[0..32] | auditor_pk_x[32..64] | auditor_pk_y[64..96]
 *   | epk_x[96..128] | epk_y[128..160] | enc_value[160..192]
 *   | enc_asset_id[192..224] | enc_owner_hash[224..256]
 */
export type DisclosurePublicSignals = number[];

/**
 * ECDH-encrypted note fields stored on-chain after a successful disclosure.
 * Maps to `EncryptedDisclosureSignals` in Rust.
 */
export type EncryptedDisclosureSignals = {
    /** Ephemeral public key x-coordinate (Baby Jubjub), 32 bytes LE. */
    epkX: number[];
    /** Ephemeral public key y-coordinate (Baby Jubjub), 32 bytes LE. */
    epkY: number[];
    /** Encrypted note value (field element LE). 0 if not disclosed. */
    encValue: number[];
    /** Encrypted asset ID (field element LE). 0 if not disclosed. */
    encAssetId: number[];
    /** Encrypted Poseidon(owner_pubkey) (field element LE). 0 if not disclosed. */
    encOwnerHash: number[];
};

/**
 * Bitmap of which note fields the auditor requires to be disclosed.
 * Maps to `DisclosureFieldMask` in Rust.
 */
export type DisclosureFieldMask = {
    /** Must disclose the note value (amount in planck). */
    value: boolean;
    /** Must disclose the asset ID. */
    assetId: boolean;
    /** Must disclose Poseidon(owner_pubkey). */
    owner: boolean;
};

// ─── Supporting types ─────────────────────────────────────────────────────────

/**
 * A single auditor entry in an audit policy.
 * Maps to `Auditor<AccountId>` in Rust.
 */
export type Auditor = {
    /** SS58 or 0x-prefixed AccountId of the authorized auditor. */
    account: string;
};

/**
 * A condition that must be satisfied before disclosure is permitted.
 * Maps to `DisclosureCondition` in Rust. Max 10 conditions per policy.
 * Evaluation is OR — a single satisfied condition is enough.
 */
export type DisclosureCondition =
    | { type: 'Always' }
    | { type: 'TimeDelay'; afterBlock: number }
    | { type: 'AmountThreshold'; minAmount: bigint };

/**
 * A single entry in a batch disclosure proof submission.
 * Maps to `BatchDisclosureSubmission<AccountId>` in Rust.
 */
export type BatchDisclosureSubmission = {
    /** 32-byte commitment (LE). */
    commitment: Bytes32;
    /** Groth16 proof bytes — max 256 bytes. */
    proof: number[];
    /** 76-byte public signals: commitment(32) | value(8) | asset_id(4) | owner_hash(32). */
    publicSignals: DisclosurePublicSignals;
    /** Optional auditor AccountId. Null = voluntary disclosure. */
    auditor: string | null;
};

/**
 * A single shield operation for use in `shield_batch`.
 */
export type ShieldOperation = {
    assetId: number;
    amount: bigint;
    /** 32-byte Poseidon commitment (LE). */
    commitment: Bytes32;
    /** Encrypted memo bytes — exactly 104 bytes. */
    encryptedMemo: number[];
};

// ─── Extrinsic argument types ─────────────────────────────────────────────────

/**
 * Call index 0 — `shield` (Signed origin)
 * Deposits a public token amount into the shielded pool.
 */
export type ShieldArgs = {
    assetId: number;
    amount: bigint;
    /** 32-byte Poseidon commitment (LE). */
    commitment: Bytes32;
    /** Encrypted memo — exactly 104 bytes. */
    encryptedMemo: number[];
};

/**
 * Call index 12 — `shield_batch` (Signed origin)
 * Deposits multiple notes in a single extrinsic — max 20 operations.
 */
export type ShieldBatchArgs = {
    operations: ShieldOperation[];
};

/** Input note consumed by a private transfer (SCALE wire format). */
export type RawTransferInput = {
    /** 32-byte Poseidon nullifier (LE). */
    nullifier: Bytes32;
    /** 32-byte Poseidon commitment (LE). */
    commitment: Bytes32;
};

/** Output note created by a private transfer (SCALE wire format). */
export type RawTransferOutput = {
    /** 32-byte Poseidon commitment (LE). */
    commitment: Bytes32;
    /** Encrypted memo — exactly 104 bytes. */
    memo: number[];
};

/**
 * Call index 1 — `private_transfer` (Unsigned/gasless origin)
 * Transfers value between notes without revealing sender, recipient or amount.
 * Fee is embedded in the ZK proof: input_sum == output_sum + fee.
 * The fee is paid to the block author (validator) by the pallet runtime.
 */
export type PrivateTransferArgs = {
    /** Groth16 proof bytes — max 512 bytes. */
    proof: number[];
    /** 32-byte Merkle root (LE). */
    merkleRoot: Bytes32;
    nullifiers: RawTransferInput[];
    outputs: RawTransferOutput[];
    encryptedMemos: number[][];
    /** Asset ID being transferred (public input of the proof). */
    assetId: number;
    /** Gasless fee in planck. Paid to the block author (validator). */
    fee: bigint;
};

/**
 * Call index 2 — `unshield` (Unsigned/gasless origin)
 * Withdraws a note from the pool to a public account.
 * Fee is embedded in the ZK proof: note_value == amount + fee + changeValue.
 */
export type UnshieldArgs = {
    /** Groth16 proof bytes — max 512 bytes. */
    proof: number[];
    /** 32-byte Merkle root (LE). */
    merkleRoot: Bytes32;
    /** 32-byte nullifier of the spent note (LE). */
    nullifier: Bytes32;
    assetId: number;
    /** Net amount recipient receives (planck). */
    amount: bigint;
    /** SS58 or 0x-prefixed AccountId of the recipient. */
    recipient: string;
    /** Gasless fee in planck. */
    fee: bigint;
    /**
     * 32-byte change note commitment (LE). All zeros for total unshield.
     * Must equal NoteCommitment(changeValue, assetId, changeOwnerPk, changeBlinding)
     * when changeValue > 0 — enforced by the ZK circuit.
     */
    changeCommitment: Bytes32;
    /**
     * Encrypted memo for the change note (176 bytes, empty for total unshield).
     * Enables note recovery via blockchain scan for partial unshield.
     */
    changeEncryptedMemo?: Bytes176;
};

/**
 * Call index 4 — `set_audit_policy` (Signed origin)
 * Registers or replaces the caller's audit policy for selective disclosure.
 */
export type SetAuditPolicyArgs = {
    /** Up to 10 authorized auditors. */
    auditors: Auditor[];
    /** Up to 10 disclosure conditions. */
    conditions: DisclosureCondition[];
    /** Minimum blocks between disclosures to the same auditor. Null = no limit. */
    maxFrequency: number | null;
    /** Block after which the policy expires. Null = no expiry. */
    validUntil: number | null;
};

/**
 * Call index 5 — `request_disclosure` (Signed origin)
 * Auditor requests selective disclosure from a target account for a specific commitment.
 */
export type RequestDisclosureArgs = {
    /** AccountId of the disclosure target. */
    target: string;
    /** 32-byte commitment the auditor wants disclosed (LE). */
    commitment: number[];
    /** Which note fields must be revealed. */
    requiredFields: DisclosureFieldMask;
    /** Human-readable request reason — max 256 bytes UTF-8. */
    reason: string;
    /** Auditor's Baby Jubjub public key x-coordinate (32 bytes LE). */
    auditorBjjPkX: number[];
    /** Auditor's Baby Jubjub public key y-coordinate (32 bytes LE). */
    auditorBjjPkY: number[];
};

/**
 * Call index 6 — `disclose` (Signed origin)
 * Submit a Groth16 disclosure proof for a commitment.
 */
export type DiscloseArgs = {
    /** 32-byte note commitment to disclose (LE). */
    commitment: Bytes32;
    /** Groth16 proof bytes — max 128 bytes. */
    proofBytes: number[];
    /**
     * 256-byte public signals (ECDH Baby Jubjub layout):
     *   commitment[0..32] | auditor_pk_x[32..64] | auditor_pk_y[64..96]
     *   | epk_x[96..128] | epk_y[128..160] | enc_value[160..192]
     *   | enc_asset_id[192..224] | enc_owner_hash[224..256]
     * Use `buildDisclosurePublicSignals()` to construct this.
     */
    publicSignals: DisclosurePublicSignals;
    /** Auditor AccountId — required (must match the DisclosureRequest). */
    auditor: string;
};

/**
 * Call index 7 — `reject_disclosure` (Signed origin)
 * Disclosure target rejects a pending request from an auditor for a specific commitment.
 */
export type RejectDisclosureArgs = {
    /** AccountId of the auditor whose request is rejected. */
    auditor: string;
    /** 32-byte commitment of the request being rejected (LE). */
    commitment: number[];
    /** Rejection reason — max 256 bytes UTF-8. */
    reason: string;
};

/**
 * Call index 13 — `batch_submit_disclosure_proofs` (Signed origin)
 * Submit up to 10 disclosure proofs in one extrinsic.
 */
export type BatchSubmitDisclosureProofsArgs = {
    submissions: BatchDisclosureSubmission[];
};

/**
 * Call index 9 — `register_asset` (Root origin)
 * Registers a new asset in the shielded pool registry.
 */
export type RegisterAssetArgs = {
    /** Asset name — max 64 bytes UTF-8. */
    name: string;
    /** Asset ticker symbol, e.g. "USDT" — max 16 bytes UTF-8. */
    symbol: string;
    /** Token decimal precision (e.g. 18 for ORB, 6 for USDT). */
    decimals: number;
    /** 20-byte EVM contract address for ERC-20 assets. Null = native asset. */
    contractAddress: number[] | null;
};

/**
 * Call index 10 — `verify_asset` (Root origin)
 * Marks a registered asset as verified, enabling shielding.
 */
export type VerifyAssetArgs = {
    assetId: number;
};

/**
 * Call index 11 — `unverify_asset` (Root origin)
 * Removes the verified status from an asset, disabling new shield operations.
 */
export type UnverifyAssetArgs = {
    assetId: number;
};

/**
 * Call index 14 — `prune_expired_request` (Signed origin)
 * Cleans up a disclosure request that has passed its expiration block.
 */
export type PruneExpiredRequestArgs = {
    /** AccountId of the disclosure target. */
    target: string;
    /** AccountId of the auditor. */
    auditor: string;
    /** 32-byte commitment of the expired request (LE). */
    commitment: number[];
};

/**
 * Call index 15 — `revoke_disclosure_record` (Signed origin)
 * Allows the note owner to revoke a previously submitted disclosure record.
 */
export type RevokeDisclosureRecordArgs = {
    /** 32-byte commitment whose disclosure record should be revoked (LE). */
    commitment: Bytes32;
};

// ─── Discriminated call union ─────────────────────────────────────────────────

/** All pallet-shielded-pool calls as a discriminated union. */
export type ShieldedPoolCall =
    | { type: 'shield'; args: ShieldArgs }
    | { type: 'shieldBatch'; args: ShieldBatchArgs }
    | { type: 'privateTransfer'; args: PrivateTransferArgs }
    | { type: 'unshield'; args: UnshieldArgs }
    | { type: 'setAuditPolicy'; args: SetAuditPolicyArgs }
    | { type: 'requestDisclosure'; args: RequestDisclosureArgs }
    | { type: 'disclose'; args: DiscloseArgs }
    | { type: 'rejectDisclosure'; args: RejectDisclosureArgs }
    | { type: 'batchSubmitDisclosureProofs'; args: BatchSubmitDisclosureProofsArgs }
    | { type: 'registerAsset'; args: RegisterAssetArgs }
    | { type: 'verifyAsset'; args: VerifyAssetArgs }
    | { type: 'unverifyAsset'; args: UnverifyAssetArgs }
    | { type: 'pruneExpiredRequest'; args: PruneExpiredRequestArgs }
    | { type: 'revokeDisclosureRecord'; args: RevokeDisclosureRecordArgs };
