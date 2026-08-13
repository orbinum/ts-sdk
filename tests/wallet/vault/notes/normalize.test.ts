/**
 * Repairing notes whose scalars came back from JSON as strings or numbers.
 *
 * The failure this prevents is remote from its cause: a note with a string
 * `value` throws `Cannot mix BigInt and other types` inside a balance sum, in
 * code that is correct. The failure it must NOT introduce is worse — a scalar
 * defaulted to `0n` produces a note that rebuilds a different commitment than
 * the one on chain, so it is counted in the balance, offered for spending, and
 * dies seconds into proving with an assert naming nothing.
 */
import { describe, it, expect } from 'vitest';
import {
    normalizeNote,
    normalizeNotes,
    NOTE_BIGINT_FIELDS,
} from '../../../../src/wallet/vault/notes/normalize';
import type { ZkNote } from '../../../../src/protocol/types';

const note = (over: Partial<Record<string, unknown>> = {}): ZkNote =>
    ({
        value: 100n,
        assetId: 0n,
        ownerPk: 1n,
        blinding: 2n,
        spendingKey: 3n,
        commitment: 4n,
        nullifier: 5n,
        sourcePk: 6n,
        circuitVersion: 1,
        spent: false,
        spentAt: null,
        commitmentHex: '0xc1',
        nullifierHex: '0xn1',
        ...over,
    }) as unknown as ZkNote;

describe('NOTE_BIGINT_FIELDS', () => {
    it('lists every scalar a note carries', () => {
        expect([...NOTE_BIGINT_FIELDS].sort()).toEqual([
            'assetId',
            'blinding',
            'commitment',
            'nullifier',
            'ownerPk',
            'sourcePk',
            'spendingKey',
            'value',
        ]);
    });

    it('includes sourcePk — the one a host enumerating by hand misses', () => {
        // Optional on the way in, so it is easy to leave out; a string here
        // breaks change-note construction rather than the balance.
        expect(NOTE_BIGINT_FIELDS).toContain('sourcePk');
    });
});

describe('normalizeNote', () => {
    it('returns the same object when nothing needs repair', () => {
        const n = note();
        expect(normalizeNote(n)).toBe(n);
    });

    it('coerces strings and numbers back to bigint', () => {
        const repaired = normalizeNote(note({ value: '250', assetId: 1 }));
        expect(repaired.value).toBe(250n);
        expect(repaired.assetId).toBe(1n);
    });

    it('repairs every listed field, not just the obvious ones', () => {
        const broken = note(Object.fromEntries(NOTE_BIGINT_FIELDS.map((f) => [f, '7'])));
        const repaired = normalizeNote(broken);
        for (const field of NOTE_BIGINT_FIELDS) {
            expect(typeof repaired[field]).toBe('bigint');
        }
    });

    it('leaves non-scalar fields alone', () => {
        const repaired = normalizeNote(note({ value: '1' }));
        expect(repaired.circuitVersion).toBe(1);
        expect(repaired.spent).toBe(false);
        expect(repaired.commitmentHex).toBe('0xc1');
    });

    it('defaults an ABSENT sourcePk to zero — that is its real value', () => {
        // The type documents it as "Zero for shield/unshield notes", and older
        // records omit it entirely. Those notes are good; rejecting them would
        // make a wallet drop notes it can spend.
        const repaired = normalizeNote(note({ sourcePk: undefined }));
        expect(repaired.sourcePk).toBe(0n);
    });

    it('does NOT default any other absent scalar', () => {
        // The distinction that matters: absent means zero only where zero is a
        // real value. A missing blinding is a corrupt record, and zeroing it
        // yields a note whose commitment matches no leaf.
        expect(() => normalizeNote(note({ blinding: undefined }))).toThrow(/unreadable blinding/);
        expect(() => normalizeNote(note({ spendingKey: undefined }))).toThrow(
            /unreadable spendingKey/
        );
        expect(() => normalizeNote(note({ value: undefined }))).toThrow(/unreadable value/);
    });

    it('SECURITY: throws rather than defaulting an unreadable scalar to zero', () => {
        // A spendingKey of 0n rebuilds a commitment that is not the on-chain
        // one. The note then sits in the balance, unspendable, until a rescan.
        expect(() => normalizeNote(note({ spendingKey: 'not-a-number' }))).toThrow(
            /unreadable spendingKey/
        );
    });

    it('names the note and the field, so the report is actionable', () => {
        expect(() => normalizeNote(note({ blinding: {}, commitmentHex: '0xdead' }))).toThrow(
            /0xdead.*unreadable blinding/
        );
    });
});

describe('normalizeNotes', () => {
    it('repairs a whole list', () => {
        const [a, b] = normalizeNotes([note({ value: '1' }), note({ value: 2 })]);
        expect(a!.value).toBe(1n);
        expect(b!.value).toBe(2n);
    });

    it('drops an unrepairable note rather than losing the rest', () => {
        // A list comes from storage, where one damaged record must not cost the
        // user every other note they hold.
        const skipped: ZkNote[] = [];
        const out = normalizeNotes(
            [note({ commitmentHex: '0xok' }), note({ commitmentHex: '0xbad', ownerPk: 'x' })],
            (n) => skipped.push(n)
        );
        expect(out).toHaveLength(1);
        expect(out[0]!.commitmentHex).toBe('0xok');
        expect(skipped[0]!.commitmentHex).toBe('0xbad');
    });

    it('does not require the callback', () => {
        expect(normalizeNotes([note({ ownerPk: 'x' })])).toEqual([]);
    });
});
