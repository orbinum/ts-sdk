/**
 * decryptHintBatch × view tags — integration against the REAL @orbinum/sdk
 * (file-linked 0.15.0): own note found through the filter, foreign note
 * skipped without AEAD work, activation boundary respected, filter off by
 * default. Complements the mocked unit tests in decryptBatch.test.ts.
 */
import { describe, it, expect } from 'vitest';
import {
    NoteBuilder,
    deriveViewingSecretKey,
    deriveViewingPublicKey,
    deriveOwnerPk,
    toHex,
} from '@orbinum/sdk';
import type { ScanCommitment } from '@orbinum/sdk';
import { decryptHintBatch } from '../../../../src/index';

const SPENDING_KEY = 12345678901234567890n;
const ivsk = deriveViewingSecretKey(SPENDING_KEY);
const ivk = deriveViewingPublicKey(ivsk);
const ownerPk = deriveOwnerPk(SPENDING_KEY);

const FOREIGN_SK = 98765432109876543210n;
const foreignIvk = deriveViewingPublicKey(deriveViewingSecretKey(FOREIGN_SK));

const KEYS = { viewingKey: ivsk, spendingKey: SPENDING_KEY, ownerPk };

async function buildHint(own: boolean, leafIndex: number): Promise<ScanCommitment> {
    const note = await NoteBuilder.build({
        value: 1000n + BigInt(leafIndex),
        assetId: 0n,
        ownerPk: own ? ownerPk : 999n,
        blinding: 42n + BigInt(leafIndex),
        spendingKey: own ? SPENDING_KEY : FOREIGN_SK,
        viewingPublicKey: own ? ivk : foreignIvk,
        circuitVersion: 1,
    });
    return {
        commitmentHex: note.commitmentHex,
        leafIndex,
        encryptedMemo: toHex(new Uint8Array(note.memo)),
    };
}

describe('decryptHintBatch × view tags (real SDK)', () => {
    it('filtro activo: nota propia se encuentra, ajenas se filtran por tag', async () => {
        const hints = [
            await buildHint(true, 10),
            await buildHint(false, 11),
            await buildHint(false, 12),
        ];

        const { notes, tagFiltered } = decryptHintBatch(hints, {
            ...KEYS,
            viewTagActivationLeaf: 0,
        });

        expect(notes[0]).not.toBeNull();
        expect(notes[0]!.value).toBe(1010n);
        expect(notes[1]).toBeNull();
        expect(notes[2]).toBeNull();
        // 2 ajenas menos posibles colisiones 1/256 (que caen al decrypt y fallan MAC).
        expect(tagFiltered).toBeGreaterThanOrEqual(1);
        expect(tagFiltered).toBeLessThanOrEqual(2);
    });

    it('boundary: hints bajo viewTagActivationLeaf van por el path completo', async () => {
        // Nota propia "legacy" simulada bajo el umbral: aunque su tag fuese basura,
        // debe encontrarse igual porque el filtro no aplica a su rango.
        const hints = [await buildHint(true, 4), await buildHint(false, 5)];

        const { notes, tagFiltered } = decryptHintBatch(hints, {
            ...KEYS,
            viewTagActivationLeaf: 5,
        });

        expect(notes[0]).not.toBeNull(); // leaf 4 < 5 → full path
        expect(notes[1]).toBeNull();
        expect(tagFiltered).toBeLessThanOrEqual(1); // solo el leaf 5 pudo filtrarse
    });

    it('filtro apagado (default): todo va por el path completo, tagFiltered = 0', async () => {
        const hints = [await buildHint(true, 100), await buildHint(false, 101)];

        const { notes, tagFiltered } = decryptHintBatch(hints, KEYS);

        expect(notes[0]).not.toBeNull();
        expect(notes[1]).toBeNull();
        expect(tagFiltered).toBe(0);
    });
});
