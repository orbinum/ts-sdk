import { describe, it, expect } from 'vitest';
import { selectNotes, buildDummyTransferInput } from '../../src/shielded-pool/protocol/coinSelection';
import type { ZkNote } from '../../src/shielded-pool/protocol/types';

// ─── helpers ──────────────────────────────────────────────────────────────────

function note(value: bigint, opts: Partial<ZkNote> = {}): ZkNote {
    return {
        value,
        assetId: 0n,
        ownerPk: 0n,
        blinding: 1n,
        spendingKey: 1n,
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
        expect(result![0]).toBe(n100);
        expect(result![1]).toBeNull();
    });

    it('returns a single note that exceeds needed', () => {
        const n200 = note(200n);
        const result = selectNotes([note(50n), n200], 100n);
        expect(result).not.toBeNull();
        expect(result![0]).toBe(n200);
        expect(result![1]).toBeNull();
    });

    it('prefers the smallest single note that covers needed (ascending sort)', () => {
        // sorted: 80, 100, 150. First that covers 100 is 100.
        const n80  = note(80n);
        const n100 = note(100n);
        const n150 = note(150n);
        const result = selectNotes([n150, n80, n100], 100n);
        expect(result![0]).toBe(n100);
        expect(result![1]).toBeNull();
    });

    it('does not return the second slot when single note suffices', () => {
        const result = selectNotes([note(500n), note(300n)], 200n);
        expect(result![1]).toBeNull();
    });

    // ── priority 2: pair ──────────────────────────────────────────────────────

    it('returns a pair when no single note is sufficient', () => {
        const n60 = note(60n);
        const n50 = note(50n);
        const result = selectNotes([n60, n50], 100n);
        expect(result).not.toBeNull();
        expect(result![1]).not.toBeNull();
    });

    it('pair sum equals needed exactly', () => {
        const n40 = note(40n);
        const n60 = note(60n);
        const result = selectNotes([n40, n60], 100n);
        const [a, b] = result!;
        expect(a.value + b!.value).toBe(100n);
    });

    it('pair sum exceeds needed', () => {
        const n70 = note(70n);
        const n80 = note(80n);
        const result = selectNotes([n70, n80], 100n);
        const [a, b] = result!;
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
        expect(result![0]).toBe(n30);
        expect(result![1]).toBe(n70);
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
        expect(result![0].value).toBeGreaterThan(0n);
        expect(result![1]!.value).toBeGreaterThan(0n);
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
        expect(r1![0]).toBe(r2![0]);
        expect(r1![1]).toBe(r2![1]);
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
