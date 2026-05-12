import { describe, it, expect } from 'vitest';
import { applyNoteStatus, encryptNote, decryptNoteRecord } from '../../src/vault/noteOps';
import { deriveVaultKey } from '../../src/vault/VaultCrypto';
import type { ZkNote } from '../../src/shielded-pool/protocol/types';

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const COMMIT_HEX = '0x' + 'ab'.repeat(32);
const NULL_HEX   = '0x' + 'cd'.repeat(32);

function makeNote(overrides: Partial<ZkNote> = {}): ZkNote {
    return {
        value: 1000n,
        assetId: 1n,
        ownerPk: 0n,
        blinding: 99n,
        spendingKey: 7n,
        commitment: BigInt(`0x${'ab'.repeat(32)}`),
        nullifier: BigInt(`0x${'cd'.repeat(32)}`),
        commitmentHex: COMMIT_HEX,
        nullifierHex: NULL_HEX,
        memo: [],
        counterpartyPk: 0n,
        spent: false,
        spentAt: null,
        ...overrides,
    };
}

async function makeKey(seed: number): Promise<CryptoKey> {
    return deriveVaultKey(new Uint8Array(32).fill(seed));
}

// ─── applyNoteStatus ──────────────────────────────────────────────────────────

describe('applyNoteStatus', () => {
    it('aplica spent=true y spentAt cuando se pasan', () => {
        const note = makeNote({ spent: false, spentAt: null });
        const result = applyNoteStatus(note, { spent: true, spentAt: 1234567890 });
        expect(result.spent).toBe(true);
        expect(result.spentAt).toBe(1234567890);
    });

    it('usa valores del note cuando status no tiene el campo', () => {
        const note = makeNote({ spent: true, spentAt: 999 });
        const result = applyNoteStatus(note, {});
        expect(result.spent).toBe(true);
        expect(result.spentAt).toBe(999);
    });

    it('defaults a spent=false, spentAt=null cuando ambos están ausentes', () => {
        const note = { ...makeNote(), spent: undefined as unknown as boolean, spentAt: undefined as unknown as null };
        const result = applyNoteStatus(note);
        expect(result.spent).toBe(false);
        expect(result.spentAt).toBe(null);
    });

    it('no muta el objeto original', () => {
        const note = makeNote({ spent: false, spentAt: null });
        const result = applyNoteStatus(note, { spent: true });
        expect(result).not.toBe(note);
        expect(note.spent).toBe(false);
    });

    it('copia todos los campos del note sin modificar', () => {
        const note = makeNote({ value: 5000n });
        const result = applyNoteStatus(note);
        expect(result.value).toBe(5000n);
        expect(result.commitmentHex).toBe(COMMIT_HEX);
    });
});

// ─── encryptNote ──────────────────────────────────────────────────────────────

describe('encryptNote', () => {
    it('devuelve EncryptedNoteRecord con todos los campos', async () => {
        const key = await makeKey(1);
        const note = makeNote();
        const rec = await encryptNote(key, note);

        expect(rec.commitmentHex).toBe(note.commitmentHex);
        expect(rec.nullifierHex).toBe(note.nullifierHex);
        expect(rec.assetId).toBe(note.assetId.toString());
        expect(rec.spent).toBe(note.spent);
        expect(rec.spentAt).toBe(note.spentAt);
        expect(typeof rec.updatedAt).toBe('number');
    });

    it('assetId es string, no bigint', async () => {
        const key = await makeKey(1);
        const rec = await encryptNote(key, makeNote({ assetId: 42n }));
        expect(typeof rec.assetId).toBe('string');
        expect(rec.assetId).toBe('42');
    });

    it('iv y ciphertext son strings base64 no vacíos', async () => {
        const key = await makeKey(1);
        const rec = await encryptNote(key, makeNote());
        expect(rec.iv.length).toBeGreaterThan(0);
        expect(rec.ciphertext.length).toBeGreaterThan(0);
    });

    it('genera IV distinto en cada llamada (no reutiliza IV)', async () => {
        const key = await makeKey(1);
        const note = makeNote();
        const rec1 = await encryptNote(key, note);
        const rec2 = await encryptNote(key, note);
        expect(rec1.iv).not.toBe(rec2.iv);
    });
});

// ─── decryptNoteRecord ────────────────────────────────────────────────────────

describe('decryptNoteRecord', () => {
    it('roundtrip: encryptNote → decryptNoteRecord reproduce la nota original', async () => {
        const key = await makeKey(2);
        const note = makeNote({ value: 9999n });
        const rec = await encryptNote(key, note);
        const decrypted = await decryptNoteRecord(key, rec);

        expect(decrypted.value).toBe(note.value);
        expect(decrypted.commitmentHex).toBe(note.commitmentHex);
        expect(decrypted.nullifierHex).toBe(note.nullifierHex);
        expect(decrypted.assetId).toBe(note.assetId);
        expect(decrypted.blinding).toBe(note.blinding);
        expect(decrypted.spendingKey).toBe(note.spendingKey);
    });

    it('aplica spent/spentAt del record sobre la nota descifrada', async () => {
        const key = await makeKey(2);
        const note = makeNote({ spent: false, spentAt: null });
        const rec = await encryptNote(key, note);
        // Simular que el record fue actualizado por un scan posterior
        const updatedRec = { ...rec, spent: true, spentAt: 1700000000000 };
        const decrypted = await decryptNoteRecord(key, updatedRec);
        expect(decrypted.spent).toBe(true);
        expect(decrypted.spentAt).toBe(1700000000000);
    });

    it('lanza con clave incorrecta (DOMException)', async () => {
        const key1 = await makeKey(1);
        const key2 = await makeKey(2);
        const rec = await encryptNote(key1, makeNote());
        await expect(decryptNoteRecord(key2, rec)).rejects.toBeInstanceOf(Error);
    });

    it('bigints sobreviven el ciclo completo', async () => {
        const key = await makeKey(3);
        const note = makeNote({
            value: 21888242871839275222246405745257275088548364400416034343698204186575808495617n,
            assetId: 99999999999999999999n,
            ownerPk: 11111111111111111111n,
            blinding: 22222222222222222222n,
            commitment: 33333333333333333333n,
            nullifier: 44444444444444444444n,
            counterpartyPk: 55555555555555555555n,
        });
        const rec = await encryptNote(key, note);
        const decrypted = await decryptNoteRecord(key, rec);
        expect(decrypted.value).toBe(note.value);
        expect(decrypted.assetId).toBe(note.assetId);
        expect(decrypted.ownerPk).toBe(note.ownerPk);
        expect(decrypted.blinding).toBe(note.blinding);
        expect(decrypted.commitment).toBe(note.commitment);
        expect(decrypted.nullifier).toBe(note.nullifier);
        expect(decrypted.counterpartyPk).toBe(note.counterpartyPk);
    });
});
