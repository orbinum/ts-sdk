/**
 * decryptHintBatch × self-note discovery — integration against the REAL
 * @orbinum/sdk (file-linked): a cold restore recognizes deterministic
 * self-notes by ephPk lookup, foreign notes stay on the normal path, and the
 * flag off (incremental ticks) keeps everything on the legacy path.
 */
import { describe, it, expect } from 'vitest';
import {
    NoteBuilder,
    deriveSelfEphSk,
    deriveViewingSecretKey,
    deriveViewingPublicKey,
    deriveOwnerPk,
    toHex,
} from '@orbinum/sdk';
import { decryptHintBatch } from '../../../../src/index';

const SPENDING_KEY = 12345678901234567890n;
const ivsk = deriveViewingSecretKey(SPENDING_KEY);
const ivk = deriveViewingPublicKey(ivsk);
const ownerPk = deriveOwnerPk(SPENDING_KEY);

const FOREIGN_SK = 98765432109876543210n;
const foreignIvk = deriveViewingPublicKey(deriveViewingSecretKey(FOREIGN_SK));

const KEYS = { viewingKey: ivsk, spendingKey: SPENDING_KEY, ownerPk };

async function selfHint(index: number, leafIndex: number, value: bigint) {
    const note = await NoteBuilder.build({
        value,
        assetId: 0n,
        ownerPk,
        blinding: 100n + BigInt(index),
        spendingKey: SPENDING_KEY,
        viewingPublicKey: ivk,
        circuitVersion: 1,
        ephSkOverride: deriveSelfEphSk(SPENDING_KEY, index),
    });
    const memo = new Uint8Array(note.memo);
    return {
        commitmentHex: note.commitmentHex,
        leafIndex,
        encryptedMemo: toHex(memo),
        ephPkHex: toHex(memo.slice(-32)),
    };
}

async function foreignHint(leafIndex: number) {
    const note = await NoteBuilder.build({
        value: 5n,
        assetId: 0n,
        ownerPk: 999n,
        blinding: 7n,
        spendingKey: FOREIGN_SK,
        viewingPublicKey: foreignIvk,
        circuitVersion: 1,
    });
    const memo = new Uint8Array(note.memo);
    return {
        commitmentHex: note.commitmentHex,
        leafIndex,
        encryptedMemo: toHex(memo),
        ephPkHex: toHex(memo.slice(-32)),
    };
}

describe('decryptHintBatch × self-note discovery (real SDK)', () => {
    it('restore frío: notas propias deterministas se encuentran vía ventana, ajenas no', async () => {
        const hints = [
            await selfHint(0, 10, 1000n),
            await foreignHint(11),
            await selfHint(3, 12, 3000n),
        ];

        const { notes, selfMatched, maxSelfEphIndex } = decryptHintBatch(hints, {
            ...KEYS,
            selfEph: true,
            selfEphWindowSize: 16,
        });

        expect(notes[0]?.value).toBe(1000n);
        expect(notes[1]).toBeNull();
        expect(notes[2]?.value).toBe(3000n);
        expect(selfMatched).toBe(2);
        expect(maxSelfEphIndex).toBe(3);
    });

    it('sin ephPkHex en el hint, matchea usando la cola del memo', async () => {
        const hint = await selfHint(1, 20, 2000n);
        const { ephPkHex: _dropped, ...bare } = hint;

        const { notes, selfMatched } = decryptHintBatch([bare], {
            ...KEYS,
            selfEph: true,
            selfEphWindowSize: 16,
        });

        expect(notes[0]?.value).toBe(2000n);
        expect(selfMatched).toBe(1);
    });

    it('flag apagado (incremental): la nota propia igual se encuentra, por el path normal', async () => {
        const hint = await selfHint(2, 30, 4000n);

        const { notes, selfMatched } = decryptHintBatch([hint], KEYS);

        expect(notes[0]?.value).toBe(4000n);
        expect(selfMatched).toBe(0); // sin ventana — la encontró el trial-decrypt
    });

    it('nota propia LEGACY (ephSk aleatorio) se encuentra por el path normal aunque la ventana esté activa', async () => {
        const note = await NoteBuilder.build({
            value: 6000n,
            assetId: 0n,
            ownerPk,
            blinding: 55n,
            spendingKey: SPENDING_KEY,
            viewingPublicKey: ivk,
            circuitVersion: 1,
            // sin ephSkOverride → aleatorio, como todas las notas pre-Track-2
        });
        const memo = new Uint8Array(note.memo);
        const hint = {
            commitmentHex: note.commitmentHex,
            leafIndex: 40,
            encryptedMemo: toHex(memo),
            ephPkHex: toHex(memo.slice(-32)),
        };

        const { notes, selfMatched } = decryptHintBatch([hint], {
            ...KEYS,
            selfEph: true,
            selfEphWindowSize: 16,
        });

        expect(notes[0]?.value).toBe(6000n);
        expect(selfMatched).toBe(0); // no matcheó la ventana — cayó al trial-decrypt
    });
});
