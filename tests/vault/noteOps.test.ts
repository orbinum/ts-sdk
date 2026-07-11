import { describe, it, expect } from 'vitest';
import {
    applyNoteStatus,
    encryptNote,
    decryptNoteRecord,
    noteBlindTag,
} from '../../src/vault/noteOps';
import { deriveVaultKey, deriveVaultBlindKey } from '../../src/vault/VaultCrypto';
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
        circuitVersion: 1,
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

async function makeBlindKey(seed: number): Promise<CryptoKey> {
    return deriveVaultBlindKey(new Uint8Array(32).fill(seed));
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

describe('encryptNote (v2, blinded identifiers)', () => {
    it('devuelve un record v2 con tags — NO los hex en claro', async () => {
        const key = await makeKey(1);
        const blindKey = await makeBlindKey(1);
        const note = makeNote();
        const rec = await encryptNote(key, blindKey, note);

        // Los identificadores on-chain NO aparecen en claro.
        expect(JSON.stringify(rec)).not.toContain(note.commitmentHex);
        expect(JSON.stringify(rec)).not.toContain(note.nullifierHex);
        expect(rec).not.toHaveProperty('commitmentHex');
        expect(rec).not.toHaveProperty('nullifierHex');
        expect(rec).not.toHaveProperty('assetId');
        // Tags presentes.
        expect(rec.commitmentTag).toBe(await noteBlindTag(blindKey, note.commitmentHex));
        expect(rec.nullifierTag).toBe(await noteBlindTag(blindKey, note.nullifierHex));
        expect(rec.assetTag).toBe(await noteBlindTag(blindKey, note.assetId.toString()));
        expect(rec.spent).toBe(note.spent);
        expect(typeof rec.updatedAt).toBe('number');
    });

    it('el tag es determinista (mismo blindKey + hex → mismo tag)', async () => {
        const blindKey = await makeBlindKey(1);
        const t1 = await noteBlindTag(blindKey, '0xabc');
        const t2 = await noteBlindTag(blindKey, '0xabc');
        expect(t1).toBe(t2);
    });

    it('distinto blindKey → distinto tag (no linkable entre vaults)', async () => {
        const t1 = await noteBlindTag(await makeBlindKey(1), '0xabc');
        const t2 = await noteBlindTag(await makeBlindKey(2), '0xabc');
        expect(t1).not.toBe(t2);
    });

    it('genera IV distinto en cada llamada (no reutiliza IV)', async () => {
        const key = await makeKey(1);
        const blindKey = await makeBlindKey(1);
        const note = makeNote();
        const rec1 = await encryptNote(key, blindKey, note);
        const rec2 = await encryptNote(key, blindKey, note);
        expect(rec1.iv).not.toBe(rec2.iv);
    });
});

// ─── decryptNoteRecord ────────────────────────────────────────────────────────

describe('decryptNoteRecord', () => {
    it('roundtrip: encryptNote → decryptNoteRecord reproduce la nota original', async () => {
        const key = await makeKey(2);
        const blindKey = await makeBlindKey(2);
        const note = makeNote({ value: 9999n });
        const rec = await encryptNote(key, blindKey, note);
        const decrypted = await decryptNoteRecord(key, rec);

        // Los identificadores se recuperan del ciphertext, no del record.
        expect(decrypted.value).toBe(note.value);
        expect(decrypted.commitmentHex).toBe(note.commitmentHex);
        expect(decrypted.nullifierHex).toBe(note.nullifierHex);
        expect(decrypted.assetId).toBe(note.assetId);
        expect(decrypted.blinding).toBe(note.blinding);
        expect(decrypted.spendingKey).toBe(note.spendingKey);
    });

    it('aplica spent/spentAt del record sobre la nota descifrada', async () => {
        const key = await makeKey(2);
        const blindKey = await makeBlindKey(2);
        const note = makeNote({ spent: false, spentAt: null });
        const rec = await encryptNote(key, blindKey, note);
        const updatedRec = { ...rec, spent: true, spentAt: 1700000000000 };
        const decrypted = await decryptNoteRecord(key, updatedRec);
        expect(decrypted.spent).toBe(true);
        expect(decrypted.spentAt).toBe(1700000000000);
    });

    it('lanza con clave incorrecta (DOMException)', async () => {
        const key1 = await makeKey(1);
        const key2 = await makeKey(2);
        const rec = await encryptNote(key1, await makeBlindKey(1), makeNote());
        await expect(decryptNoteRecord(key2, rec)).rejects.toBeInstanceOf(Error);
    });

    it('bigints sobreviven el ciclo completo', async () => {
        const key = await makeKey(3);
        const blindKey = await makeBlindKey(3);
        const note = makeNote({
            value: 21888242871839275222246405745257275088548364400416034343698204186575808495617n,
            assetId: 99999999999999999999n,
            ownerPk: 11111111111111111111n,
            blinding: 22222222222222222222n,
            commitment: 33333333333333333333n,
            nullifier: 44444444444444444444n,
            counterpartyPk: 55555555555555555555n,
        });
        const rec = await encryptNote(key, blindKey, note);
        const decrypted = await decryptNoteRecord(key, rec);
        expect(decrypted.value).toBe(note.value);
        expect(decrypted.assetId).toBe(note.assetId);
        expect(decrypted.ownerPk).toBe(note.ownerPk);
        expect(decrypted.blinding).toBe(note.blinding);
        expect(decrypted.commitment).toBe(note.commitment);
        expect(decrypted.nullifier).toBe(note.nullifier);
        expect(decrypted.counterpartyPk).toBe(note.counterpartyPk);
    });

    it('lanza si la nota descifrada no lleva circuitVersion (fail-closed, cero legacy)', async () => {
        const key = await makeKey(4);
        const blindKey = await makeBlindKey(4);
        // Encrypt a note with circuitVersion stripped — an invalid/foreign record.
        const noteNoVersion = makeNote();
        delete (noteNoVersion as Partial<ZkNote>).circuitVersion;
        const rec = await encryptNote(key, blindKey, noteNoVersion as ZkNote);
        await expect(decryptNoteRecord(key, rec)).rejects.toThrow(/missing circuitVersion/);
    });
});
