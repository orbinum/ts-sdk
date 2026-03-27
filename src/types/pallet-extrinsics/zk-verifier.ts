/**
 * TypeScript types for pallet-zk-verifier extrinsics.
 *
 * Conventions:
 *   - Byte arrays  → `number[]`  (SCALE-compatible)
 *   - Versions     → `number`    (u32)
 */

// ─── CircuitId ────────────────────────────────────────────────────────────────

/**
 * On-chain circuit identifier (u32 newtype on-chain).
 * Use the {@link CircuitId} constant object for named values.
 */
export type CircuitId = (typeof CircuitId)[keyof typeof CircuitId];

/**
 * Named constants for all supported ZK circuits.
 *
 * | Name         | Value | Circuit                         |
 * |--------------|-------|---------------------------------|
 * | Transfer     | 1     | 2-in-2-out private transfer     |
 * | Unshield     | 2     | Withdrawal from the pool        |
 * | Disclosure   | 3     | Selective disclosure            |
 * | PrivateLink  | 4     | Private chain-link proof        |
 */
export const CircuitId = {
    Transfer: 1,
    Unshield: 2,
    Disclosure: 3,
    PrivateLink: 4,
} as const;

// ─── Supporting types ─────────────────────────────────────────────────────────

/**
 * A single verification key registration entry used in batch operations.
 * Maps to `VkEntry` in Rust.
 */
export type VkEntry = {
    circuitId: CircuitId;
    /** Circuit version number (u32 on-chain). Versions are independent per circuit. */
    version: number;
    /** Serialised Groth16 verification key bytes — max 8 192 bytes. */
    verificationKey: number[];
};

// ─── Extrinsic argument types ─────────────────────────────────────────────────

/**
 * Call index 0 — `register_verification_key` (Root origin)
 * Registers a Groth16 verification key for a specific circuit and version.
 */
export type RegisterVerificationKeyArgs = {
    circuitId: CircuitId;
    /** Version to associate with this key. */
    version: number;
    /** Serialised Groth16 verification key bytes — max 8 192 bytes. */
    verificationKey: number[];
};

/**
 * Call index 1 — `set_active_version` (Root origin)
 * Designates a specific version as the active one used for proof verification.
 */
export type SetActiveVersionArgs = {
    circuitId: CircuitId;
    version: number;
};

/**
 * Call index 2 — `remove_verification_key` (Root origin)
 * Removes a registered verification key.
 * The currently active version cannot be removed.
 */
export type RemoveVerificationKeyArgs = {
    circuitId: CircuitId;
    version: number;
};

/**
 * Call index 3 — `verify_proof` (Signed origin)
 * Verifies a single Groth16 proof on-chain for the specified circuit.
 * Uses the circuit's currently active verification key version.
 */
export type VerifyProofArgs = {
    circuitId: CircuitId;
    /** Groth16 proof bytes. */
    proof: number[];
    /**
     * Public inputs as a list of 32-byte field elements (LE).
     * Number and meaning of inputs depends on the circuit:
     * - Transfer:    [merkle_root, nullifier_0, nullifier_1, commitment_0, commitment_1]
     * - Unshield:    [merkle_root, nullifier, amount_fe, recipient_hash, asset_id_fe]
     * - Disclosure:  [commitment, revealed_value_fe, revealed_asset_id_fe, owner_hash]
     * - PrivateLink: [commitment, call_hash_fe]
     */
    publicInputs: number[][];
};

/**
 * Call index 4 — `batch_register_verification_keys` (Root origin)
 * Registers up to 10 verification keys in one extrinsic.
 * Useful for initial chain setup or coordinated upgrades.
 */
export type BatchRegisterVerificationKeysArgs = {
    /** Up to 10 VK entries. */
    entries: VkEntry[];
};

// ─── Discriminated call union ─────────────────────────────────────────────────

/** All pallet-zk-verifier calls as a discriminated union. */
export type ZkVerifierCall =
    | { type: 'registerVerificationKey'; args: RegisterVerificationKeyArgs }
    | { type: 'setActiveVersion'; args: SetActiveVersionArgs }
    | { type: 'removeVerificationKey'; args: RemoveVerificationKeyArgs }
    | { type: 'verifyProof'; args: VerifyProofArgs }
    | { type: 'batchRegisterVerificationKeys'; args: BatchRegisterVerificationKeysArgs };
