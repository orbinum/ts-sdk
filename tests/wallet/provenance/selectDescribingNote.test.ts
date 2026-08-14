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
import type { ZkNote } from '../../../src/protocol/types';

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

// ─── A note that skipped normalisation ───────────────────────────────────────

describe('hasSourcePk checks the type, not just the value', () => {
    it('rejects a scalar that is still a string', () => {
        // Notes come back from encrypted storage as whatever JSON held, and
        // `normalizeNote` is what makes their scalars bigints. This is public
        // API and takes any object with the field, so an unnormalised record
        // reaches it: `'0' != null && '0' !== 0n` is true, so a zero written as
        // a string would read as a stamped key.
        expect(hasSourcePk({ sourcePk: '0' } as unknown as Pick<ZkNote, 'sourcePk'>)).toBe(false);
        expect(hasSourcePk({ sourcePk: '5' } as unknown as Pick<ZkNote, 'sourcePk'>)).toBe(false);
        expect(hasSourcePk({ sourcePk: 5 } as unknown as Pick<ZkNote, 'sourcePk'>)).toBe(false);
    });

    it('still accepts a real stamped key and still rejects a real zero', () => {
        expect(hasSourcePk({ sourcePk: 5n })).toBe(true);
        expect(hasSourcePk({ sourcePk: 0n })).toBe(false);
        expect(hasSourcePk({ sourcePk: null } as unknown as Pick<ZkNote, 'sourcePk'>)).toBe(false);
    });

    it('an unnormalised note does not win the selection over a real one', () => {
        // The failure this prevents: the change note picked as the one that
        // describes the transfer, reporting the change amount as the amount.
        const unnormalised = { sourcePk: '7' } as unknown as Pick<ZkNote, 'sourcePk'>;
        const real = { sourcePk: 9n };

        expect(selectDescribingNote([unnormalised, real])).toBe(real);
    });
});
