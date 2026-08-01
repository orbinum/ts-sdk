import type { ZkNote } from './types';
import type { TransferInputNote } from '../../proof-generator/transfer';

/** Merkle tree depth for the transfer circuit (must match compile-time Transfer(20)). */
const TRANSFER_TREE_DEPTH = 20;

/**
 * Leaves per forest tree. Pinned to the runtime's `MaxLeavesPerTree` (2^20),
 * guarded on-chain by the pallet's `integrity_test` — it can never change on
 * a live chain, so deriving tree membership locally is safe.
 */
const LEAVES_PER_TREE = 1 << TRANSFER_TREE_DEPTH;

/**
 * Forest tree a note belongs to.
 *
 * Falls back to tree 0 for a missing or malformed `leafIndex`. Both cases are
 * expected rather than defensive noise:
 *
 *   - Notes persisted before the forest upgrade carry no index, and they all
 *     predate the first seal, so tree 0 is the correct answer.
 *   - The index originates in an indexer scan hint, which is untrusted. A
 *     `NaN` reaching this function would make every same-tree comparison
 *     false — no pair would ever be selectable and the whole balance would
 *     look unspendable.
 */
export function treeIdOf(note: Pick<ZkNote, 'leafIndex'>): number {
    const idx = note.leafIndex;
    if (idx === undefined || !Number.isSafeInteger(idx) || idx < 0 || idx >= 2 ** 32) return 0;
    return Math.floor(idx / LEAVES_PER_TREE);
}

/**
 * Outcome of {@link selectNotes}.
 *
 *   - `[noteA, noteB | null]` — a spendable selection; a `null` second slot
 *     means the transfer runs with a dummy input.
 *   - `{ needsConsolidation: true }` — the balance covers the amount, but only
 *     by pairing notes from different forest trees, which no single proof can
 *     do. The caller should offer a consolidation, not an insufficient-funds
 *     error.
 *   - `null` — no combination covers the amount.
 */
export type CoinSelection = [ZkNote, ZkNote | null] | { needsConsolidation: true } | null;

/**
 * Selects up to 2 unspent notes that together cover `needed` planck.
 *
 * Both inputs of a transfer are proven together against ONE circuit VK and ONE
 * public `merkle_root`, so a pair must agree on two things: mixing circuit
 * versions produces an invalid proof, and notes in different forest trees
 * anchor to different roots that can never converge. A single note needs
 * neither check.
 *
 * Resolution order:
 *   1. One note that alone covers `needed` → `[note, null]`.
 *   2. Smallest same-version, same-tree pair whose sum covers it → `[a, b]`.
 *   3. A cross-tree pair would cover it → `{ needsConsolidation: true }`.
 *   4. Nothing covers it → `null`.
 *
 * Only unspent notes with value > 0 are considered.
 */
export function selectNotes(notes: ZkNote[], needed: bigint): CoinSelection {
    const unspent = notes.filter((n) => !n.spent && n.value > 0n);
    const sorted = [...unspent].sort((a, b) => (a.value < b.value ? -1 : 1)); // ascending

    // Step 1: single note that alone covers the amount.
    const single = sorted.find((n) => n.value >= needed);
    if (single) return [single, null];

    // Step 2: smallest pair that shares both a circuit version and a tree.
    for (let i = 0; i < sorted.length; i++) {
        for (let j = i + 1; j < sorted.length; j++) {
            const a = sorted[i];
            const b = sorted[j];
            if (
                a !== undefined &&
                b !== undefined &&
                a.circuitVersion === b.circuitVersion &&
                treeIdOf(a) === treeIdOf(b) &&
                a.value + b.value >= needed
            ) {
                return [a, b];
            }
        }
    }

    // Step 3: no same-tree pair worked. If a cross-tree pair would have
    // covered the amount, the funds exist but are stranded — say so instead
    // of reporting them as missing.
    for (let i = 0; i < sorted.length; i++) {
        for (let j = i + 1; j < sorted.length; j++) {
            const a = sorted[i];
            const b = sorted[j];
            if (
                a !== undefined &&
                b !== undefined &&
                a.circuitVersion === b.circuitVersion &&
                a.value + b.value >= needed
            ) {
                return { needsConsolidation: true };
            }
        }
    }

    // Step 4: the balance genuinely does not cover the amount.
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
