/**
 * planTransfer / planUnshield — the pre-flight arithmetic every spend UI needs.
 *
 * The manual-selection path is the one that matters: a hand-picked pair must
 * clear the SAME bar automatic selection does. A UI that checked only the
 * circuit version — which is what the app did before this existed — lets a user
 * assemble a cross-tree pair whose proof can never be built.
 */
import { describe, it, expect } from 'vitest';
import {
    planTransfer,
    planUnshield,
    spendableBalance,
} from '../../../../src/wallet/ops/spend/plan';
import { LEAVES_PER_TREE } from '../../../../src/protocol/spend/coinSelection';
import { deriveOwnerPk } from '../../../../src/protocol/keys/PrivacyKeys';
import type { ZkNote } from '../../../../src/protocol/types';

const SPENDING_KEY = 12345678901234567890n;

/**
 * A note the wallet genuinely owns.
 *
 * `ownerPk` derives from `spendingKey` on purpose: planning discards notes
 * where it does not, because those can never be spent. A fixture that skipped
 * the pairing would land on the rejection path and prove nothing about the
 * arithmetic under test.
 */
const note = (over: Partial<ZkNote> = {}): ZkNote =>
    ({
        value: 100n,
        spent: false,
        circuitVersion: 1,
        leafIndex: 0,
        spendingKey: SPENDING_KEY,
        ownerPk: deriveOwnerPk(SPENDING_KEY),
        commitmentHex: `0xc${Math.random().toString(16).slice(2)}`,
        ...over,
    }) as ZkNote;

/** A note whose spending key does not own it — stored, but unspendable. */
const unspendable = (over: Partial<ZkNote> = {}): ZkNote =>
    note({ ownerPk: deriveOwnerPk(SPENDING_KEY + 1n), ...over });

/** A note in forest tree 1 — cannot pair with a tree-0 note. */
const otherTree = (over: Partial<ZkNote> = {}) => note({ leafIndex: LEAVES_PER_TREE, ...over });

describe('spendableBalance', () => {
    it('counts only unspent notes above zero', () => {
        // A value-0 note is a dummy the circuit forces to nullifier 0 — counting
        // it would promise money that cannot be moved.
        const notes = [
            note({ value: 50n }),
            note({ value: 0n }),
            note({ value: 30n, spent: true }),
        ];

        expect(spendableBalance(notes)).toBe(50n);
    });
});

describe('planTransfer — automatic selection', () => {
    it('plans a single-note spend with its change', () => {
        const plan = planTransfer({ notes: [note({ value: 100n })], amount: 60n, fee: 10n });

        expect(plan.ok).toBe(true);
        expect(plan.needed).toBe(70n);
        expect(plan.change).toBe(30n);
        expect(plan.inputs?.[1]).toBeNull();
    });

    it('pairs two notes when neither covers the amount alone', () => {
        const plan = planTransfer({
            notes: [note({ value: 40n }), note({ value: 50n })],
            amount: 80n,
            fee: 0n,
        });

        expect(plan.ok).toBe(true);
        expect(plan.inputs?.[1]).not.toBeNull();
    });

    it('reports insufficient when the balance does not cover amount + fee', () => {
        const plan = planTransfer({ notes: [note({ value: 50n })], amount: 50n, fee: 10n });

        expect(plan.ok).toBe(false);
        expect(plan.problem).toBe('insufficient');
    });

    it('reports needs-consolidation when the funds are stranded across trees', () => {
        // The money exists — it just cannot be proven in one transaction. The
        // right answer is an offer to consolidate, not "insufficient funds".
        const plan = planTransfer({
            notes: [note({ value: 40n }), otherTree({ value: 50n })],
            amount: 80n,
            fee: 0n,
        });

        expect(plan.ok).toBe(false);
        expect(plan.problem).toBe('needs-consolidation');
    });

    it('reports no-amount for a missing or non-positive amount', () => {
        expect(planTransfer({ notes: [note()], amount: null, fee: 0n }).problem).toBe('no-amount');
        expect(planTransfer({ notes: [note()], amount: 0n, fee: 0n }).problem).toBe('no-amount');
    });

    it('maxSpendable is the spendable balance minus the fee, floored at zero', () => {
        expect(
            planTransfer({ notes: [note({ value: 100n })], amount: null, fee: 30n }).maxSpendable
        ).toBe(70n);
        expect(
            planTransfer({ notes: [note({ value: 10n })], amount: null, fee: 30n }).maxSpendable
        ).toBe(0n);
    });
});

describe('planTransfer — manual selection', () => {
    it('accepts a hand-picked pair that shares version and tree', () => {
        const plan = planTransfer({
            notes: [],
            amount: 80n,
            fee: 0n,
            manualInputs: [note({ value: 40n }), note({ value: 50n })],
        });

        expect(plan.ok).toBe(true);
        expect(plan.change).toBe(10n);
    });

    it('rejects a hand-picked CROSS-TREE pair', () => {
        // The bug this closes: automatic selection refuses this pair, so manual
        // selection must too — otherwise the spend dies inside the circuit.
        const plan = planTransfer({
            notes: [],
            amount: 80n,
            fee: 0n,
            manualInputs: [note({ value: 40n }), otherTree({ value: 50n })],
        });

        expect(plan.ok).toBe(false);
        expect(plan.problem).toBe('needs-consolidation');
    });

    it('rejects a hand-picked pair of different circuit versions', () => {
        const plan = planTransfer({
            notes: [],
            amount: 80n,
            fee: 0n,
            manualInputs: [note({ value: 40n }), note({ value: 50n, circuitVersion: 2 })],
        });

        expect(plan.ok).toBe(false);
        expect(plan.problem).toBe('needs-consolidation');
    });

    it('reports insufficient when the picked notes do not cover the amount', () => {
        const plan = planTransfer({
            notes: [],
            amount: 200n,
            fee: 0n,
            manualInputs: [note({ value: 40n })],
        });

        expect(plan.ok).toBe(false);
        expect(plan.problem).toBe('insufficient');
    });

    it('sizes maxSpendable from the picked notes, not the whole balance', () => {
        const plan = planTransfer({
            notes: [note({ value: 1_000n })],
            amount: null,
            fee: 10n,
            manualInputs: [note({ value: 100n })],
        });

        expect(plan.maxSpendable).toBe(90n);
    });
});

describe('planUnshield', () => {
    it('plans a full withdrawal with no change', () => {
        const plan = planUnshield({ notes: [note({ value: 100n })], amount: 90n, fee: 10n });

        expect(plan.ok).toBe(true);
        expect(plan.change).toBe(0n);
    });

    it('plans a partial withdrawal with change', () => {
        const plan = planUnshield({ notes: [note({ value: 100n })], amount: 50n, fee: 10n });

        expect(plan.change).toBe(40n);
    });

    it('refuses when no SINGLE note covers the amount, even if the balance does', () => {
        // Unshield proves one input; two notes summing to enough are irrelevant,
        // and there is nothing to consolidate.
        const plan = planUnshield({
            notes: [note({ value: 60n }), note({ value: 60n })],
            amount: 100n,
            fee: 0n,
        });

        expect(plan.ok).toBe(false);
        expect(plan.problem).toBe('no-single-note');
    });

    it('sizes maxSpendable from the LARGEST note, never the summed balance', () => {
        const plan = planUnshield({
            notes: [note({ value: 60n }), note({ value: 90n })],
            amount: null,
            fee: 10n,
        });

        expect(plan.maxSpendable).toBe(80n);
    });

    it('honours a manually picked note', () => {
        const picked = note({ value: 200n });

        const plan = planUnshield({
            notes: [note({ value: 1_000n })],
            amount: 100n,
            fee: 10n,
            manualNote: picked,
        });

        expect(plan.note).toBe(picked);
        expect(plan.change).toBe(90n);
        expect(plan.maxSpendable).toBe(190n);
    });

    it('rejects a manually picked note that cannot cover the amount', () => {
        const plan = planUnshield({
            notes: [],
            amount: 500n,
            fee: 0n,
            manualNote: note({ value: 100n }),
        });

        expect(plan.ok).toBe(false);
        expect(plan.problem).toBe('no-single-note');
    });

    it('ignores spent and zero-value notes', () => {
        const plan = planUnshield({
            notes: [note({ value: 500n, spent: true }), note({ value: 0n })],
            amount: 10n,
            fee: 0n,
        });

        expect(plan.ok).toBe(false);
        expect(plan.maxSpendable).toBe(0n);
    });
});

/**
 * A note whose spending key does not derive its `ownerPk` can never be spent:
 * every spend path rebuilds the commitment from `BabyPbk(spendingKey).Ax` and
 * rejects the mismatch. Such a note reaches the vault from a rescan that
 * repaired it wrongly, or from a record an older build wrote.
 *
 * Counting it shows the user a balance holding money that cannot move;
 * selecting it sends them into an opaque failure seconds into proving.
 */
describe('unspendable notes are excluded from planning', () => {
    it('SECURITY: does not count an unowned note toward the balance', () => {
        const notes = [note({ value: 100n }), unspendable({ value: 900n })];

        expect(spendableBalance(notes)).toBe(100n);
    });

    it('SECURITY: never selects an unowned note for a transfer', () => {
        // Without the filter this plans a transfer that dies inside the circuit.
        const plan = planTransfer({
            notes: [note({ value: 100n }), unspendable({ value: 900n })],
            amount: 500n,
            fee: 0n,
        });

        expect(plan.ok).toBe(false);
    });

    it('SECURITY: never selects an unowned note for an unshield', () => {
        const plan = planUnshield({
            notes: [unspendable({ value: 900n })],
            amount: 500n,
            fee: 0n,
        });

        expect(plan.ok).toBe(false);
    });

    it('sizes maxSpendable from owned notes only', () => {
        const plan = planTransfer({
            notes: [note({ value: 100n }), unspendable({ value: 900n })],
            amount: null,
            fee: 0n,
        });

        expect(plan.maxSpendable).toBe(100n);
    });

    it('still plans normally when every note is owned', () => {
        // The filter must not reject valid notes — that would strand real funds.
        const plan = planTransfer({
            notes: [note({ value: 400n }), note({ value: 400n })],
            amount: 700n,
            fee: 0n,
        });

        expect(plan.ok).toBe(true);
    });
});
