/**
 * Which notes pay an amount, and what the forest allows.
 *
 * The circuit is 2-in/2-out, so a spend draws on at most TWO notes and the
 * selection is a search over pairs rather than a greedy sum. A pair must agree
 * on two things beyond covering the amount: the same CIRCUIT VERSION, since one
 * proof is verified against one VK, and the same FOREST TREE, since both paths
 * resolve under one root and a cross-tree pair can never converge.
 *
 * Pure arithmetic over notes: nothing here reserves anything or touches the
 * chain, and every guard it applies is one the circuit would apply anyway,
 * seconds later and without naming the note.
 */
import type { ZkNote } from '../types';
import type { TransferInputNote } from '../proving/transfer';

/** Merkle tree depth for the transfer circuit (must match compile-time Transfer(20)). */
const TRANSFER_TREE_DEPTH = 20;

/**
 * Leaves one forest tree holds — the value this SDK assumes for the chain's
 * `MaxLeavesPerTree`.
 *
 * The pallet's `integrity_test` requires that constant to be a power of two no
 * greater than `2^MAX_TREE_DEPTH`, and forbids changing it on a live chain,
 * precisely because clients derive `tree_id` from a global leaf index with it.
 * It does NOT pin it to 2^20: a chain configured lower still passes, and this
 * constant would then place notes in the wrong tree.
 *
 * Exported so a host can reason about tree boundaries — and so a deployment on
 * a differently-configured chain has one place to look.
 */
export const LEAVES_PER_TREE = 1 << TRANSFER_TREE_DEPTH;

/**
 * Whether a leaf index is a real position in the forest.
 *
 * Leaf indexes are u32 on chain, and every one this library sees arrives from
 * an UNTRUSTED source — an indexer scan hint, or a note decoded from a memo. A
 * value outside that range is the source misbehaving, never a leaf the wallet
 * has not reached yet.
 *
 * One definition because the consequences differ per call site and all of them
 * are bad: `NaN` makes every same-tree comparison false (nothing is spendable),
 * and `Infinity` persisted as a scan cursor makes every later incremental scan
 * resume past the end of the tree (nothing is ever found again).
 */
export function isValidLeafIndex(leafIndex: number | null | undefined): leafIndex is number {
    return (
        leafIndex !== null &&
        leafIndex !== undefined &&
        Number.isSafeInteger(leafIndex) &&
        leafIndex >= 0 &&
        leafIndex < 2 ** 32
    );
}

/**
 * Forest tree a note belongs to.
 *
 * Falls back to tree 0 for a missing or malformed `leafIndex`. Both cases are
 * expected rather than defensive noise:
 *
 *   - Notes persisted before the forest upgrade carry no index, and they all
 *     predate the first seal, so tree 0 is the correct answer.
 *   - The index originates in an indexer scan hint, which is untrusted — see
 *     {@link isValidLeafIndex}.
 */
export function treeIdOf(note: Pick<ZkNote, 'leafIndex'>): number {
    const idx = note.leafIndex;
    return isValidLeafIndex(idx) ? Math.floor(idx / LEAVES_PER_TREE) : 0;
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

/** Only unspent notes with value above zero can be spent.
 *
 * A value-0 note is the change output of an exact-amount spend: the circuit
 * treats it as a dummy and forces its nullifier to 0, so it can never be
 * spent — and counting it toward a balance promises money that is not there.
 */
export function isSpendable(note: ZkNote): boolean {
    return !note.spent && note.value > 0n;
}

/**
 * Whether two notes can be the two inputs of ONE spend.
 *
 * Both inputs are proven together against one circuit VK and one public
 * `merkle_root`, so a pair must agree on BOTH: mixing circuit versions makes
 * the proof unverifiable, and notes in different forest trees anchor to roots
 * that can never be reconciled.
 *
 * Exported because manual coin selection has to enforce exactly what
 * {@link selectNotes} enforces — a UI that checked only one of the two would
 * let a user assemble a pair that dies inside the circuit.
 */
export function canPairWith(a: ZkNote, b: ZkNote): boolean {
    return a.circuitVersion === b.circuitVersion && treeIdOf(a) === treeIdOf(b);
}

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
    const unspent = notes.filter(isSpendable);
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
                canPairWith(a, b) &&
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
