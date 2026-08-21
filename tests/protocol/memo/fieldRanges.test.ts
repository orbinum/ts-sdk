/**
 * Los campos del memo son de ancho fijo; el commitment no.
 *
 * `Poseidon4(value, assetId, ownerPk, blinding)` se calcula con el bigint
 * completo, mientras que el plaintext guarda `value` en 128 bits y `assetId` en
 * 32. Un valor que no quepa se enmascaraba en silencio, y entonces el memo
 * describía una nota DISTINTA de la comprometida.
 *
 * El resultado no es un importe corrupto: `tryDecryptNote` recomputa el
 * commitment, ve que no cuadra y da la nota por ajena. Nadie puede abrirla ni
 * gastarla nunca. Medido — `value = 2^128`, un valor negativo y
 * `assetId = 2^32 + 5` construían limpiamente y luego fallaban con
 * `commitment_mismatch`.
 */
import { describe, it, expect } from 'vitest';
import { NoteBuilder } from '../../../src/protocol/note/NoteBuilder';
import { serializeMemo } from '../../../src/protocol/memo/plaintext';
import { tryDecryptNoteVerbose } from '../../../src/protocol/note/NoteDecryptor';
import { deriveIdentity } from '../../../src/wallet/identity/walletIdentity';
import { toHex } from '../../../src/foundation/encoding/hex';

const alice = deriveIdentity(new Uint8Array(32).fill(0xa1), 'v3');

const build = (value: bigint, assetId = 0n) =>
    NoteBuilder.build({
        value,
        assetId,
        ownerPk: alice.ownerPk,
        recipientOwnerPk: alice.ownerPk,
        viewingPublicKey: alice.viewingPublicKey,
    });

describe('serializeMemo rechaza lo que no cabe', () => {
    const ownerPk = new Uint8Array(32);
    const blinding = new Uint8Array(32);
    const sourcePk = new Uint8Array(32);
    const ok = () => serializeMemo(1n, ownerPk, blinding, 0, sourcePk, 1);

    it('acepta el rango válido, incluido el máximo', () => {
        expect(ok).not.toThrow();
        expect(() =>
            serializeMemo((1n << 128n) - 1n, ownerPk, blinding, 0xffff_ffff, sourcePk, 1)
        ).not.toThrow();
    });

    it.each([
        ['justo por encima de 2^128', 1n << 128n],
        ['muy por encima', 1n << 200n],
        ['negativo', -1n],
    ])('rechaza un value %s', (_label, value) => {
        expect(() => serializeMemo(value, ownerPk, blinding, 0, sourcePk, 1)).toThrow(
            /128 unsigned bits/
        );
    });

    it.each([
        ['por encima de u32', 0x1_0000_0000],
        ['negativo', -1],
        ['no entero', 1.5],
    ])('rechaza un assetId %s', (_label, assetId) => {
        expect(() => serializeMemo(1n, ownerPk, blinding, assetId, sourcePk, 1)).toThrow(/u32/);
    });

    it('rechaza un circuitVersion fuera de u32', () => {
        expect(() => serializeMemo(1n, ownerPk, blinding, 0, sourcePk, -1)).toThrow(/u32/);
    });
});

describe('NoteBuilder no construye notas irrecuperables', () => {
    it.each([
        ['value 2^128', 1n << 128n, 0n],
        ['value negativo', -5n, 0n],
        ['assetId 2^32+5', 1n, (1n << 32n) + 5n],
    ])('rechaza %s', async (_label, value, assetId) => {
        await expect(build(value, assetId)).rejects.toThrow();
    });

    it('el valor máximo que SÍ cabe sigue funcionando de extremo a extremo', async () => {
        // El límite no debe morder lo legítimo: 2^127-1 está muy por encima de
        // cualquier supply real y tiene que sobrevivir el viaje completo.
        const value = (1n << 127n) - 1n;
        const note = await build(value);

        const result = tryDecryptNoteVerbose(
            {
                commitmentHex: note.commitmentHex,
                encryptedMemo: toHex(Uint8Array.from(note.memo)),
                leafIndex: 0,
            } as never,
            alice.viewingSecretKey,
            alice.spendingKey,
            alice.ownerPk
        );

        expect(result.note?.value).toBe(value);
    });

    it('LO QUE ESTO IMPEDÍA: la nota se construía y luego no abría nunca', async () => {
        // Documenta el modo de fallo. Sin la guarda, esto daba una nota con
        // `commitment_mismatch` — fondos enviados a algo que nadie puede gastar.
        await expect(build(1n << 128n)).rejects.toThrow(/128 unsigned bits/);
    });
});
