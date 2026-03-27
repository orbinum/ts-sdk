/**
 * TypeScript types for events emitted by pallet-zk-verifier.
 *
 * Conventions:
 *   - CircuitId  → imported from pallet-extrinsics (u32 newtype)
 *   - version    → `number` (u32)
 *   - count      → `number` (u32)
 */

import type { CircuitId } from '../pallet-extrinsics';

// ─── Individual event types ───────────────────────────────────────────────────

/**
 * Emitted by `register_verification_key()` when a new VK is stored.
 * Rust variant: `VerificationKeyRegistered { circuit_id, version }`
 */
export type VerificationKeyRegisteredEvent = {
    circuitId: CircuitId;
    version: number;
};

/**
 * Emitted by `set_active_version()` when the active VK version changes.
 * Rust variant: `ActiveVersionSet { circuit_id, version }`
 */
export type ActiveVersionSetEvent = {
    circuitId: CircuitId;
    version: number;
};

/**
 * Emitted by `remove_verification_key()` when a VK is deleted.
 * Rust variant: `VerificationKeyRemoved { circuit_id, version }`
 */
export type VerificationKeyRemovedEvent = {
    circuitId: CircuitId;
    version: number;
};

/**
 * Emitted by `verify_proof()` when a ZK proof is successfully verified.
 * Rust variant: `ProofVerified { circuit_id, version }`
 */
export type ProofVerifiedEvent = {
    circuitId: CircuitId;
    version: number;
};

/**
 * Emitted by `verify_proof()` when ZK proof verification fails.
 * Rust variant: `ProofVerificationFailed { circuit_id, version }`
 */
export type ProofVerificationFailedEvent = {
    circuitId: CircuitId;
    version: number;
};

/**
 * Emitted by `batch_register_verification_keys()` on success.
 * Rust variant: `BatchVerificationKeysRegistered { count }`
 */
export type BatchVerificationKeysRegisteredEvent = {
    /** Number of VK entries registered in the batch. */
    count: number;
};

// ─── Discriminated union ──────────────────────────────────────────────────────

/** All events emitted by pallet-zk-verifier as a discriminated union. */
export type ZkVerifierEvent =
    | { type: 'VerificationKeyRegistered'; data: VerificationKeyRegisteredEvent }
    | { type: 'ActiveVersionSet'; data: ActiveVersionSetEvent }
    | { type: 'VerificationKeyRemoved'; data: VerificationKeyRemovedEvent }
    | { type: 'ProofVerified'; data: ProofVerifiedEvent }
    | { type: 'ProofVerificationFailed'; data: ProofVerificationFailedEvent }
    | { type: 'BatchVerificationKeysRegistered'; data: BatchVerificationKeysRegisteredEvent };
