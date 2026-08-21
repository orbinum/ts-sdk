/**
 * decryptHintBatch — the pure trial-decryption kernel.
 * Covers ownership mix, order alignment, and malformed-hint resilience.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => ({ tryDecryptNoteVerbose: vi.fn() }));
vi.mock('../../../../src/protocol/note/NoteDecryptor', () => ({
    tryDecryptNoteVerbose: mocks.tryDecryptNoteVerbose,
}));

import { decryptHintBatch } from '../../../../src/index';
import type { ScanKeys } from '../../../../src/index';

const KEYS: ScanKeys = { viewingKey: new Uint8Array([1]), spendingKey: 2n, ownerPk: 3n };

const hint = (n: number) => ({
    commitmentHex: `0xc${n}`,
    leafIndex: n,
    encryptedMemo: `0xmemo${n}`,
});

describe('decryptHintBatch', () => {
    beforeEach(() => vi.clearAllMocks());

    it('devuelve una entrada por hint, alineada con el orden de entrada', () => {
        // Solo la 2ª es nuestra.
        mocks.tryDecryptNoteVerbose
            .mockReturnValueOnce({ note: null })
            .mockReturnValueOnce({ note: { commitmentHex: '0xc1' } })
            .mockReturnValueOnce({ note: null });

        const { notes, tagFiltered } = decryptHintBatch([hint(0), hint(1), hint(2)], KEYS);

        expect(notes).toEqual([null, { commitmentHex: '0xc1' }, null]);
        expect(tagFiltered).toBe(0);
        expect(mocks.tryDecryptNoteVerbose).toHaveBeenNthCalledWith(
            1,
            hint(0),
            KEYS.viewingKey,
            KEYS.spendingKey,
            KEYS.ownerPk,
            { viewTag: false }
        );
    });

    it('un hint malformado que lanza cuenta como null sin matar el batch', () => {
        mocks.tryDecryptNoteVerbose
            .mockReturnValueOnce({ note: { commitmentHex: '0xc0' } })
            .mockImplementationOnce(() => {
                throw new Error('bad hex');
            })
            .mockReturnValueOnce({ note: { commitmentHex: '0xc2' } });

        const { notes } = decryptHintBatch([hint(0), hint(1), hint(2)], KEYS);

        expect(notes).toEqual([{ commitmentHex: '0xc0' }, null, { commitmentHex: '0xc2' }]);
    });

    it('viewTag se activa solo desde viewTagActivationLeaf; mismatch incrementa tagFiltered', () => {
        mocks.tryDecryptNoteVerbose.mockImplementation(
            (
                _h: unknown,
                _vk: unknown,
                _sk: unknown,
                _pk: unknown,
                opts?: { viewTag?: boolean }
            ) => (opts?.viewTag ? { note: null, reason: 'view_tag_mismatch' } : { note: null })
        );

        const { tagFiltered } = decryptHintBatch([hint(4), hint(5), hint(6)], {
            ...KEYS,
            viewTagActivationLeaf: 5,
        });

        // leaf 4 → path completo; leaves 5 y 6 → filtrados por tag.
        expect(mocks.tryDecryptNoteVerbose).toHaveBeenNthCalledWith(
            1,
            hint(4),
            KEYS.viewingKey,
            KEYS.spendingKey,
            KEYS.ownerPk,
            { viewTag: false }
        );
        expect(mocks.tryDecryptNoteVerbose).toHaveBeenNthCalledWith(
            2,
            hint(5),
            KEYS.viewingKey,
            KEYS.spendingKey,
            KEYS.ownerPk,
            { viewTag: true }
        );
        expect(tagFiltered).toBe(2);
    });

    it('batch vacío devuelve []', () => {
        expect(decryptHintBatch([], KEYS)).toEqual({
            notes: [],
            tagFiltered: 0,
            selfMatched: 0,
            pairwiseMatched: 0,
            maxSelfEphIndex: null,
            maxOutgoingEphIndex: null,
            sentNotes: [],
            learnedRecipients: [],
            unmatchedSent: [],
            sealedBookEntries: [],
        });
        expect(mocks.tryDecryptNoteVerbose).not.toHaveBeenCalled();
    });
});
