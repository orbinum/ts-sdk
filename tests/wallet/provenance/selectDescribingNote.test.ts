/**
 * selectDescribingNote — the tie-break that decides which of an extrinsic's
 * notes describes the transfer.
 *
 * This rule used to exist twice: `findChangeNote` in the scanner and
 * `resolveIncomingTransferMeta` in the app. Getting it wrong reports the CHANGE
 * amount as the transfer amount, so the property worth pinning is that a note
 * with a stamped `sourcePk` always wins over one without.
 */
import { describe, it, expect } from 'vitest';
import {
    hasSourcePk,
    selectDescribingNote,
    selectDescribingNoteByCommitment,
} from '../../../src/wallet/provenance/index';

const note = (commitmentHex: string, sourcePk: bigint) => ({ commitmentHex, sourcePk });

describe('hasSourcePk', () => {
    it('zero is absence — a shield/unshield output names no other party', () => {
        expect(hasSourcePk({ sourcePk: 0n })).toBe(false);
    });

    it('any non-zero pk counts as present', () => {
        expect(hasSourcePk({ sourcePk: 1n })).toBe(true);
    });
});

describe('selectDescribingNote', () => {
    it('prefers the note carrying a sourcePk over one without', () => {
        const change = note('0xchange', 0xabcn);
        const other = note('0xother', 0n);

        // Order must not matter: the stamped note wins from either position.
        expect(selectDescribingNote([other, change])).toBe(change);
        expect(selectDescribingNote([change, other])).toBe(change);
    });

    it('falls back to the first candidate when none carries a pk', () => {
        const first = note('0xa', 0n);
        expect(selectDescribingNote([first, note('0xb', 0n)])).toBe(first);
    });

    it('returns undefined when we own none of the notes', () => {
        expect(selectDescribingNote([])).toBeUndefined();
    });
});

describe('selectDescribingNoteByCommitment', () => {
    it('resolves hexes and applies the same rule', () => {
        const change = note('0xchange', 0xabcn);
        const plain = note('0xplain', 0n);
        const lookup = new Map([
            [change.commitmentHex, change],
            [plain.commitmentHex, plain],
        ]);

        expect(selectDescribingNoteByCommitment(['0xplain', '0xchange'], lookup)).toBe(change);
    });

    it('skips commitments we do not own rather than yielding a hole', () => {
        const mine = note('0xmine', 0n);
        const lookup = new Map([[mine.commitmentHex, mine]]);

        // '0xtheirs' is the recipient's output — present on chain, absent here.
        expect(selectDescribingNoteByCommitment(['0xtheirs', '0xmine'], lookup)).toBe(mine);
    });

    it('returns undefined when none of the commitments are ours', () => {
        expect(selectDescribingNoteByCommitment(['0xtheirs'], new Map())).toBeUndefined();
    });
});
