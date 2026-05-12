import type { ZkNote } from './types';
import type { TransferInputNote } from '../../proof-generator/transfer';

/** Merkle tree depth for the transfer circuit (must match compile-time Transfer(20)). */
const TRANSFER_TREE_DEPTH = 20;

/**
 * Selects up to 2 unspent notes that together cover `needed` planck.
 *
 * Priority:
 *   1. A single note whose value >= needed  →  [note, null]  (second input will be a dummy)
 *   2. The smallest pair whose sum >= needed →  [noteA, noteB]
 *   3. No combination covers needed          →  null  (consolidation via merge required)
 *
 * Only unspent notes with value > 0 are considered.
 */
export function selectNotes(notes: ZkNote[], needed: bigint): [ZkNote, ZkNote | null] | null {
    const unspent = notes.filter((n) => !n.spent && n.value > 0n);
    const sorted = [...unspent].sort((a, b) => (a.value < b.value ? -1 : 1)); // ascending

    // Priority 1: single note that alone covers the amount
    const single = sorted.find((n) => n.value >= needed);
    if (single) return [single, null];

    // Priority 2: smallest qualifying pair
    for (let i = 0; i < sorted.length; i++) {
        for (let j = i + 1; j < sorted.length; j++) {
            const a = sorted[i];
            const b = sorted[j];
            if (a !== undefined && b !== undefined && a.value + b.value >= needed) {
                return [a, b];
            }
        }
    }

    return null;
}

/**
 * Builds a dummy `TransferInputNote` for use as the second input in a single-note transfer.
 *
 * The modified transfer circuit exempts inputs with `value == 0` from Merkle membership,
 * nullifier derivation, and EdDSA signature checks (Constraints 1–3 are conditional on
 * `is_dummy[i].out == 0`). Constraint 9 forces the public nullifier to 0 for dummy inputs.
 *
 * Security: `IsZero` is a deterministic R1CS gadget — a prover cannot make it return 1
 * for a non-zero `input_values[i]` without breaking the constraint system.
 *
 * @param assetId - Must equal the real input note's assetId (circuit Constraint 7).
 */
export function buildDummyTransferInput(assetId: bigint): TransferInputNote {
    const zeroSibling = '0x' + '00'.repeat(32);
    return {
        nullifier: 0n, // Constraint 9: nullifier * is_dummy.out === 0 → must be 0
        value: 0n, // triggers is_dummy[i].out = 1 in the circuit
        assetId, // must match real note (Constraint 7)
        ownerPk: 0n,
        blinding: 0n,
        spendingKey: 1n, // arbitrary; EdDSA is disabled (enabled = 0) for dummy inputs
        pathSiblings: Array<string>(TRANSFER_TREE_DEPTH).fill(zeroSibling),
        leafIndex: 0,
    };
}
