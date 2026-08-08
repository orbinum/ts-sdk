/**
 * Pre-flight planning for a spend: which notes cover the amount, what change
 * comes back, and how much is spendable at all.
 *
 * The arithmetic is small but it is protocol arithmetic, and every wallet UI
 * needs the same answers before it can enable a button. Left to each host it
 * gets reimplemented per screen — which is how one screen ends up enforcing
 * only half of what the circuit requires.
 *
 * These are PLANS, not commitments: nothing here reserves anything or touches
 * the chain. The real guards run inside `transferNotes` / `unshieldNote`.
 */
import { selectNotes, isSpendable, canPairWith } from '../../../protocol/spend/index';
import { isNoteSelfConsistent } from '../../vault/index';
import type { CoinSelection } from '../../../protocol/spend/index';
import type { ZkNote } from '../../../protocol/types';

/**
 * The notes a spend may actually draw on.
 *
 * `isSpendable` answers the circuit's question — unspent, non-zero — but not
 * the ownership one: a note whose stored `spendingKey` does not derive its
 * `ownerPk` can never be spent, because every spend path rebuilds the
 * commitment from `BabyPbk(spendingKey).Ax` and rejects the mismatch. Such a
 * note reaches the vault from a rescan that repaired it wrongly, or from a
 * record written by an older build.
 *
 * Counting it would overstate the balance with money that cannot move, and
 * selecting it sends the user into an opaque failure seconds into proving.
 *
 * The ownership check costs one EC derivation (~0.1 ms), which is why it lives
 * here and not in `isSpendable`: that one runs inside `selectNotes`, whose pair
 * search is O(n²) and would pay the cost thousands of times over.
 */
function usableNotes(notes: ZkNote[]): ZkNote[] {
    return notes.filter((note) => isSpendable(note) && isNoteSelfConsistent(note));
}

/** Why a plan cannot go ahead. Hosts map these to their own copy. */
export type SpendPlanProblem =
    | 'no-amount' // amount missing or not positive
    | 'insufficient' // the balance does not cover amount + fee
    | 'needs-consolidation' // funds exist but only across forest trees
    | 'no-single-note'; // unshield only: no ONE note covers amount + fee

export interface TransferPlan {
    /** The inputs to spend, or null when the plan cannot proceed. */
    inputs: [ZkNote, ZkNote | null] | null;
    /** amount + fee — what the inputs must cover. */
    needed: bigint | null;
    /** Σ(inputs) − amount − fee. Null when there is no valid selection. */
    change: bigint | null;
    /** Largest amount spendable with the given notes, after fee. */
    maxSpendable: bigint;
    ok: boolean;
    problem?: SpendPlanProblem;
}

export interface UnshieldPlan {
    /** Unshield spends exactly ONE note — the circuit takes a single input. */
    note: ZkNote | null;
    needed: bigint | null;
    change: bigint | null;
    maxSpendable: bigint;
    ok: boolean;
    problem?: SpendPlanProblem;
}

/** Total of the notes that can actually be spent. */
export function spendableBalance(notes: ZkNote[]): bigint {
    return usableNotes(notes).reduce((sum, n) => sum + n.value, 0n);
}

/**
 * Plans a private transfer.
 *
 * Pass `manualInputs` when the user picked notes themselves — the plan then
 * validates that choice instead of selecting, and rejects a pair the circuit
 * could not prove together.
 */
export function planTransfer(params: {
    notes: ZkNote[];
    amount: bigint | null;
    fee: bigint;
    manualInputs?: ZkNote[] | undefined;
}): TransferPlan {
    const { notes, amount, fee, manualInputs } = params;

    const pool = manualInputs ?? usableNotes(notes);
    const maxSpendable = manualInputs
        ? bounded(manualInputs.reduce((s, n) => s + n.value, 0n) - fee)
        : bounded(spendableBalance(notes) - fee);

    if (amount === null || amount <= 0n) {
        return {
            inputs: null,
            needed: null,
            change: null,
            maxSpendable,
            ok: false,
            problem: 'no-amount',
        };
    }

    const needed = amount + fee;
    let inputs: [ZkNote, ZkNote | null] | null;

    if (manualInputs) {
        const [a, b] = manualInputs;
        if (!a) {
            return {
                inputs: null,
                needed,
                change: null,
                maxSpendable,
                ok: false,
                problem: 'insufficient',
            };
        }
        // A manual pair must clear the SAME bar the automatic selection does,
        // or the user assembles something the circuit refuses.
        if (b && !canPairWith(a, b)) {
            return {
                inputs: null,
                needed,
                change: null,
                maxSpendable,
                ok: false,
                problem: 'needs-consolidation',
            };
        }
        inputs = [a, b ?? null];
    } else {
        const selection: CoinSelection = selectNotes(pool, needed);
        if (selection === null) {
            return {
                inputs: null,
                needed,
                change: null,
                maxSpendable,
                ok: false,
                problem: 'insufficient',
            };
        }
        if (!Array.isArray(selection)) {
            // The balance covers it, but only across trees — an offer to
            // consolidate, not an insufficient-funds error.
            return {
                inputs: null,
                needed,
                change: null,
                maxSpendable,
                ok: false,
                problem: 'needs-consolidation',
            };
        }
        inputs = selection;
    }

    const total = inputs[0].value + (inputs[1]?.value ?? 0n);
    const change = total - needed;
    if (change < 0n) {
        return {
            inputs: null,
            needed,
            change: null,
            maxSpendable,
            ok: false,
            problem: 'insufficient',
        };
    }
    return { inputs, needed, change, maxSpendable, ok: true };
}

/**
 * Plans an unshield.
 *
 * Unshield proves ONE input, so a balance spread over two notes cannot cover an
 * amount neither note reaches alone. That is not the cross-tree case and there
 * is nothing to consolidate — it simply needs a bigger note.
 */
export function planUnshield(params: {
    notes: ZkNote[];
    amount: bigint | null;
    fee: bigint;
    manualNote?: ZkNote | undefined;
}): UnshieldPlan {
    const { notes, amount, fee, manualNote } = params;

    const spendable = usableNotes(notes);
    // The ceiling is one note's worth, never the summed balance: a second note
    // cannot join this spend.
    const largest = manualNote
        ? manualNote.value
        : spendable.reduce((max, n) => (n.value > max ? n.value : max), 0n);
    const maxSpendable = bounded(largest - fee);

    if (amount === null || amount <= 0n) {
        return {
            note: null,
            needed: null,
            change: null,
            maxSpendable,
            ok: false,
            problem: 'no-amount',
        };
    }

    const needed = amount + fee;
    const note = manualNote ?? spendable.find((n) => n.value >= needed) ?? null;

    if (!note || note.value < needed) {
        return {
            note: null,
            needed,
            change: null,
            maxSpendable,
            ok: false,
            problem: 'no-single-note',
        };
    }

    return { note, needed, change: note.value - needed, maxSpendable, ok: true };
}

const bounded = (v: bigint) => (v > 0n ? v : 0n);
