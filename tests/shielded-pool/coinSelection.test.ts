import { describe, it, expect } from 'vitest';
import { selectNotes, treeIdOf, buildDummyTransferInput } from '../../src/shielded-pool/protocol/coinSelection';
import type { ZkNote } from '../../src/shielded-pool/protocol/types';

// ─── helpers ──────────────────────────────────────────────────────────────────
// Narrows the CoinSelection union for legacy assertions that expect a pair.
function asPair(r: ReturnType<typeof selectNotes>): [ZkNote, ZkNote | null] {
    if (!Array.isArray(r)) throw new Error('expected a note pair');
    return r;
}


function note(value: bigint, opts: Partial<ZkNote> = {}): ZkNote {
    return {
        value,
        assetId: 0n,
        ownerPk: 0n,
        blinding: 1n,
        spendingKey: 1n,
        circuitVersion: 1,
        spent: false,
        spentAt: null,
        commitment: value,        // arbitrary unique identifier for assertions
        nullifier: value + 1000n,
        commitmentHex: '0x' + value.toString(16).padStart(64, '0'),
        nullifierHex: '0x' + (value + 1000n).toString(16).padStart(64, '0'),
        memo: [],
        counterpartyPk: 0n,
        ...opts,
    };
}

// ─── selectNotes ──────────────────────────────────────────────────────────────

describe('selectNotes', () => {

    // ── empty / no match ──────────────────────────────────────────────────────

    it('returns null for empty list', () => {
        expect(selectNotes([], 100n)).toBeNull();
    });

    it('returns null when no note covers needed and no pair does either', () => {
        const notes = [note(10n), note(20n)];
        expect(selectNotes(notes, 100n)).toBeNull();
    });

    it('returns null when only spent notes are available', () => {
        const notes = [note(500n, { spent: true }), note(600n, { spent: true })];
        expect(selectNotes(notes, 100n)).toBeNull();
    });

    it('ignores notes with value 0', () => {
        const notes = [note(0n), note(0n)];
        expect(selectNotes(notes, 1n)).toBeNull();
    });

    it('ignores spent notes even when their value would cover needed', () => {
        const spentBig = note(1000n, { spent: true });
        const unspentSmall = note(50n);
        // only unspentSmall is live; 50 < 100 → null
        expect(selectNotes([spentBig, unspentSmall], 100n)).toBeNull();
    });

    // ── priority 1: single note ───────────────────────────────────────────────

    it('returns a single note that exactly equals needed', () => {
        const n100 = note(100n);
        const result = selectNotes([n100], 100n);
        expect(result).not.toBeNull();
        expect(asPair(result)[0]).toBe(n100);
        expect(asPair(result)[1]).toBeNull();
    });

    it('returns a single note that exceeds needed', () => {
        const n200 = note(200n);
        const result = selectNotes([note(50n), n200], 100n);
        expect(result).not.toBeNull();
        expect(asPair(result)[0]).toBe(n200);
        expect(asPair(result)[1]).toBeNull();
    });

    it('prefers the smallest single note that covers needed (ascending sort)', () => {
        // sorted: 80, 100, 150. First that covers 100 is 100.
        const n80  = note(80n);
        const n100 = note(100n);
        const n150 = note(150n);
        const result = selectNotes([n150, n80, n100], 100n);
        expect(asPair(result)[0]).toBe(n100);
        expect(asPair(result)[1]).toBeNull();
    });

    it('does not return the second slot when single note suffices', () => {
        const result = selectNotes([note(500n), note(300n)], 200n);
        expect(asPair(result)[1]).toBeNull();
    });

    // ── priority 2: pair ──────────────────────────────────────────────────────

    it('returns a pair when no single note is sufficient', () => {
        const n60 = note(60n);
        const n50 = note(50n);
        const result = selectNotes([n60, n50], 100n);
        expect(result).not.toBeNull();
        expect(asPair(result)[1]).not.toBeNull();
    });

    it('pair sum equals needed exactly', () => {
        const n40 = note(40n);
        const n60 = note(60n);
        const result = selectNotes([n40, n60], 100n);
        const [a, b] = asPair(result);
        expect(a.value + b!.value).toBe(100n);
    });

    it('pair sum exceeds needed', () => {
        const n70 = note(70n);
        const n80 = note(80n);
        const result = selectNotes([n70, n80], 100n);
        const [a, b] = asPair(result);
        expect(a.value + b!.value).toBeGreaterThanOrEqual(100n);
    });

    it('selects the smallest qualifying pair', () => {
        // notes: 30, 70, 80  — no single note covers 100
        // Pairs covering 100: (30,70)=100, (30,80)=110, (70,80)=150
        // Smallest qualifying = (30, 70) with sum 100
        const n30 = note(30n);
        const n70 = note(70n);
        const n80 = note(80n);
        const result = selectNotes([n80, n70, n30], 100n);
        expect(asPair(result)[0]).toBe(n30);
        expect(asPair(result)[1]).toBe(n70);
    });

    it('does not select same note twice for pair', () => {
        // Only one note but it alone is insufficient
        const result = selectNotes([note(50n)], 100n);
        expect(result).toBeNull();
    });

    it('ignores spent notes when building pair', () => {
        // spent(80) + unspent(30) would cover 100, but spent is filtered
        const n80spent = note(80n, { spent: true });
        const n30 = note(30n);
        const n40 = note(40n);
        // 30 + 40 = 70 < 100 → no valid pair
        expect(selectNotes([n80spent, n30, n40], 100n)).toBeNull();
    });

    it('pair skips zero-value notes', () => {
        const n0   = note(0n);
        const n60  = note(60n);
        const n40  = note(40n);
        // zero-value filtered; pair 60+40=100 covers needed
        const result = selectNotes([n0, n60, n40], 100n);
        expect(result).not.toBeNull();
        expect(asPair(result)[0].value).toBeGreaterThan(0n);
        expect(asPair(result)[1]!.value).toBeGreaterThan(0n);
    });

    // ── determinism / no mutation ─────────────────────────────────────────────

    it('does not mutate the input array', () => {
        const notes = [note(200n), note(50n)];
        const original = [...notes];
        selectNotes(notes, 100n);
        expect(notes[0]).toBe(original[0]);
        expect(notes[1]).toBe(original[1]);
    });

    it('is deterministic for the same input', () => {
        const notes = [note(30n), note(70n), note(150n)];
        const r1 = selectNotes(notes, 100n);
        const r2 = selectNotes(notes, 100n);
        expect(asPair(r1)[0]).toBe(asPair(r2)[0]);
        expect(asPair(r1)[1]).toBe(asPair(r2)[1]);
    });

    // ── version-aware pairing ─────────────────────────────────────────────────
    // Both transfer inputs prove against ONE VK, so a pair must share a version.

    it('does not pair notes of different circuit versions', () => {
        // 50 (v1) + 50 (v2) = 100 covers needed, but versions differ → no valid pair.
        const v1 = note(50n, { circuitVersion: 1 });
        const v2 = note(50n, { circuitVersion: 2 });
        expect(selectNotes([v1, v2], 100n)).toBeNull();
    });

    it('pairs two notes of the same version even when a cheaper cross-version pair exists', () => {
        // Cross pair (40v1 + 70v2)=110 is cheaper-sorted but forbidden;
        // same-version pair (70v2 + 60v2)=130 is the only legal one.
        const a = note(40n, { circuitVersion: 1 });
        const b = note(70n, { circuitVersion: 2 });
        const c = note(60n, { circuitVersion: 2 });
        const result = selectNotes([a, b, c], 100n);
        expect(result).not.toBeNull();
        expect(asPair(result)[0]!.circuitVersion).toBe(2);
        expect(asPair(result)[1]!.circuitVersion).toBe(2);
    });

    it('a single note of any version still wins over the version-pair rule', () => {
        // One v2 note alone covers needed → priority 1, no pairing considered.
        const single = note(120n, { circuitVersion: 2 });
        const other = note(90n, { circuitVersion: 1 });
        const result = selectNotes([other, single], 100n);
        expect(asPair(result)[0]).toBe(single);
        expect(asPair(result)[1]).toBeNull();
    });
});

// ─── buildDummyTransferInput ──────────────────────────────────────────────────

describe('buildDummyTransferInput', () => {

    it('value is 0n (triggers is_dummy in circuit)', () => {
        const dummy = buildDummyTransferInput(0n);
        expect(dummy.value).toBe(0n);
    });

    it('nullifier is 0n (Constraint 9: nullifier * is_dummy.out === 0)', () => {
        const dummy = buildDummyTransferInput(0n);
        expect(dummy.nullifier).toBe(0n);
    });

    it('assetId matches the provided assetId (Constraint 7)', () => {
        expect(buildDummyTransferInput(0n).assetId).toBe(0n);
        expect(buildDummyTransferInput(42n).assetId).toBe(42n);
        expect(buildDummyTransferInput(999n).assetId).toBe(999n);
    });

    it('ownerPk is 0n', () => {
        expect(buildDummyTransferInput(0n).ownerPk).toBe(0n);
    });

    it('blinding is 0n', () => {
        expect(buildDummyTransferInput(0n).blinding).toBe(0n);
    });

    it('spendingKey is non-zero (must be ≥ 1 for circuit internal use)', () => {
        expect(buildDummyTransferInput(0n).spendingKey).toBeGreaterThanOrEqual(1n);
    });

    it('pathSiblings has exactly 20 elements (TRANSFER_TREE_DEPTH)', () => {
        const dummy = buildDummyTransferInput(0n);
        expect(dummy.pathSiblings).toHaveLength(20);
    });

    it('all pathSiblings are 0x-prefixed 32-byte hex strings', () => {
        const dummy = buildDummyTransferInput(0n);
        for (const sibling of dummy.pathSiblings) {
            expect(sibling).toMatch(/^0x[0-9a-fA-F]{64}$/);
        }
    });

    it('all pathSiblings are all-zero (dummy path)', () => {
        const dummy = buildDummyTransferInput(0n);
        const zeroSibling = '0x' + '00'.repeat(32);
        for (const sibling of dummy.pathSiblings) {
            expect(sibling).toBe(zeroSibling);
        }
    });

    it('leafIndex is 0', () => {
        expect(buildDummyTransferInput(0n).leafIndex).toBe(0);
    });

    it('different assetIds produce independent objects', () => {
        const a = buildDummyTransferInput(1n);
        const b = buildDummyTransferInput(2n);
        expect(a).not.toBe(b);
        expect(a.assetId).toBe(1n);
        expect(b.assetId).toBe(2n);
    });

    it('mutating pathSiblings of one result does not affect another', () => {
        const a = buildDummyTransferInput(0n);
        const b = buildDummyTransferInput(0n);
        a.pathSiblings[0] = '0x' + 'ff'.repeat(32);
        expect(b.pathSiblings[0]).toBe('0x' + '00'.repeat(32));
    });
});

describe('forest same-tree selection', () => {
    const TREE = 1 << 20;
    const note = (value: bigint, leafIndex?: number): ZkNote =>
        ({ ...baseNote(value), leafIndex }) as ZkNote;
    // Minimal valid note for selection purposes.
    const baseNote = (value: bigint) =>
        ({ value, spent: false, circuitVersion: 1 }) as unknown as ZkNote;

    it('prefers a same-tree pair over a cross-tree one', () => {
        const a = note(60n, 5);
        const b = note(60n, TREE + 1); // tree 1
        const c = note(50n, 7); // tree 0, smaller
        const sel = selectNotes([a, b, c], 100n);
        expect(Array.isArray(sel)).toBe(true);
        const [x, y] = sel as [ZkNote, ZkNote | null];
        expect(treeIdOf(x)).toBe(treeIdOf(y as ZkNote));
    });

    it('signals consolidation when only a cross-tree pair covers the amount', () => {
        const a = note(60n, 5); // tree 0
        const b = note(60n, TREE + 1); // tree 1
        expect(selectNotes([a, b], 100n)).toEqual({ needsConsolidation: true });
    });

    it('treats notes without leafIndex as tree 0', () => {
        const legacy = note(60n, undefined);
        const t0 = note(60n, 3);
        const sel = selectNotes([legacy, t0], 100n);
        expect(Array.isArray(sel)).toBe(true);
        expect(treeIdOf(legacy)).toBe(0);
    });

    it('malformed leafIndex (NaN, negative, float, huge) falls back to tree 0', () => {
        for (const bad of [NaN, -1, 1.5, 2 ** 32, Infinity]) {
            expect(treeIdOf({ leafIndex: bad })).toBe(0);
        }
        // A poisoned note must still pair with honest tree-0 notes.
        const poisoned = note(60n, NaN);
        const honest = note(60n, 3);
        const sel = selectNotes([poisoned, honest], 100n);
        expect(Array.isArray(sel)).toBe(true);
    });

    it('derives treeId correctly at the 2^20 boundary', () => {
        expect(treeIdOf({ leafIndex: TREE - 1 })).toBe(0);
        expect(treeIdOf({ leafIndex: TREE })).toBe(1);
    });

    it('still returns null when no combination covers the amount', () => {
        expect(selectNotes([note(10n, 1), note(20n, TREE + 2)], 100n)).toBeNull();
    });
});
