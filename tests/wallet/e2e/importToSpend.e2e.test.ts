/**
 * De la importación al gasto: el tramo que ningún test cubría.
 *
 * `importPaymentSlip` e `importNotesFromBackup` devuelven una `ZkNote`, y ahí
 * se paraban todos los tests. Que la nota se DEVUELVA no prueba que sirva: aún
 * tiene que sobrevivir el cifrado y la normalización del vault, volver a salir
 * con sus escalares intactos, y ser aceptada por las guardas de gasto.
 *
 * Ese trayecto es donde un campo mal serializado no se nota: la nota se guarda
 * sin error, se lee sin error, y sólo falla al construir la prueba — con un
 * mensaje que no señala la importación.
 *
 * `noteMatchesCommitment` es la comprobación que lo ata: recomputa
 * `Poseidon4(value, assetId, ownerPk, blinding)` desde la nota tal como salió
 * del vault. Si cualquiera de los cuatro se corrompió por el camino, no cuadra.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { NoteBuilder } from '../../../src/protocol/note/NoteBuilder';
import { sealPaymentSlip, encodePaymentSlip } from '../../../src/protocol/memo/PaymentSlip';
import { importPaymentSlip } from '../../../src/wallet/ops/notes/paymentSlipImport';
import {
    encodeNoteBackup,
    decodeNoteBackup,
    importNotesFromBackup,
} from '../../../src/wallet/ops/notes/noteBackup';
import { checkSpendableInputs, noteMatchesCommitment } from '../../../src/wallet/ops/spend/guards';
import { deriveIdentity } from '../../../src/wallet/identity/walletIdentity';
import { toHex } from '../../../src/foundation/encoding/hex';
import { freshVault } from '../../helpers/scanHarness';
import type { VaultStore, MemoryVaultStorage } from '../../../src/index';
import type { ZkNote } from '../../../src/protocol/types';

const ROOT = new Uint8Array(32).fill(0xa1);
const recipient = deriveIdentity(ROOT, 'v3');
const sender = deriveIdentity(new Uint8Array(32).fill(0x5e), 'v3');

const importKeys = () => ({
    viewingSecretKey: recipient.viewingSecretKey,
    spendingKey: recipient.spendingKey,
    ownerPk: recipient.ownerPk,
});

/** Un pago real hacia el receptor, con criptografía de verdad. */
async function payment(value: bigint): Promise<ZkNote> {
    return NoteBuilder.build({
        value,
        assetId: 0n,
        ownerPk: recipient.ownerPk,
        recipientOwnerPk: recipient.ownerPk,
        viewingPublicKey: recipient.viewingPublicKey,
        sourcePk: sender.ownerPk,
    });
}

/** El slip tal como viaja: cadena `orbslip1:`. */
const slipFor = (note: ZkNote, leafIndex: number): string =>
    encodePaymentSlip(
        sealPaymentSlip(recipient.viewingPublicKey, {
            commitmentHex: note.commitmentHex,
            encryptedMemo: toHex(Uint8Array.from(note.memo)),
            leafIndex,
        })
    );

describe('slip → import → vault → gastable', () => {
    let vault: VaultStore;
    let storage: MemoryVaultStorage;

    beforeEach(async () => {
        ({ vault, storage } = await freshVault(ROOT));
    });

    it('la nota importada sobrevive el viaje por el vault', async () => {
        const note = await payment(4200n);

        const imported = importPaymentSlip(slipFor(note, 7), importKeys());
        expect(imported).not.toBeNull();
        await vault.save(imported!);

        // Releída desde el almacenamiento cifrado, no desde la caché en memoria.
        const stored = vault.getAll().find((n) => n.commitmentHex === note.commitmentHex);
        expect(stored).toBeDefined();
        expect(stored!.value).toBe(4200n);
        // El commitment se recomputa desde los cuatro escalares almacenados:
        // si alguno se corrompió al cifrar o normalizar, esto no cuadra.
        expect(noteMatchesCommitment(stored!)).toBe(true);
    });

    it('y las guardas de gasto la aceptan', async () => {
        const note = await payment(4200n);
        await vault.save(importPaymentSlip(slipFor(note, 7), importKeys())!);

        const stored = vault.getAll()[0]!;

        expect(checkSpendableInputs([stored]).ok).toBe(true);
    });

    it('la clave de gasto stealth se conserva a través del vault', async () => {
        // Es la que gasta la nota, y se DERIVA al importar — no viaja en el
        // slip. Si el vault no la persistiera, la nota se vería en el saldo y
        // no se podría mover.
        const note = await payment(4200n);
        const imported = importPaymentSlip(slipFor(note, 7), importKeys())!;
        await vault.save(imported);

        const stored = vault.getAll()[0]!;

        expect(stored.spendingKey).toBe(imported.spendingKey);
        expect(stored.spendingKey).not.toBe(recipient.spendingKey);
        expect(stored.nullifierHex).toBe(imported.nullifierHex);
    });

    it('reimportar el mismo slip no duplica la nota', async () => {
        const note = await payment(4200n);
        const slip = slipFor(note, 7);

        await vault.save(importPaymentSlip(slip, importKeys())!);
        await vault.save(importPaymentSlip(slip, importKeys())!);

        expect(vault.getAll()).toHaveLength(1);
    });

    it('una nota ajena no entra aunque el slip esté bien formado', async () => {
        // Sellado hacia OTRA persona: el sobre abre (lo selló quien tenía su
        // dirección) pero el memo no, así que no hay nota que guardar.
        const other = deriveIdentity(new Uint8Array(32).fill(0xb0), 'v3');
        const note = await NoteBuilder.build({
            value: 999n,
            assetId: 0n,
            ownerPk: other.ownerPk,
            recipientOwnerPk: other.ownerPk,
            viewingPublicKey: other.viewingPublicKey,
        });
        const slip = encodePaymentSlip(
            sealPaymentSlip(recipient.viewingPublicKey, {
                commitmentHex: note.commitmentHex,
                encryptedMemo: toHex(Uint8Array.from(note.memo)),
            })
        );

        expect(importPaymentSlip(slip, importKeys())).toBeNull();
        expect(vault.getAll()).toEqual([]);
        void storage;
    });
});

describe('backup → import → vault → gastable', () => {
    let vault: VaultStore;

    beforeEach(async () => {
        ({ vault } = await freshVault(ROOT));
    });

    it('el ciclo completo deja una nota que las guardas aceptan', async () => {
        const note = await payment(1500n);
        const original = importPaymentSlip(slipFor(note, 3), importKeys())!;

        // Exportar → JSON → reimportar, como haría una restauración real.
        const wire = JSON.stringify(encodeNoteBackup([original]));
        const recovered = importNotesFromBackup(decodeNoteBackup(wire), importKeys());

        expect(recovered).toHaveLength(1);
        await vault.save(recovered[0]!);

        const stored = vault.getAll()[0]!;
        expect(stored.value).toBe(1500n);
        expect(noteMatchesCommitment(stored)).toBe(true);
        expect(checkSpendableInputs([stored]).ok).toBe(true);
    });

    it('una nota gastada vuelve marcada como gastada', async () => {
        // Si volviera como disponible, la cartera intentaría gastarla y el
        // nodo rechazaría el nullifier — un fallo que el usuario ve como
        // «mi saldo miente».
        const note = await payment(1500n);
        const spent = { ...importPaymentSlip(slipFor(note, 3), importKeys())!, spent: true };

        const wire = JSON.stringify(encodeNoteBackup([spent]));
        const recovered = importNotesFromBackup(decodeNoteBackup(wire), importKeys());

        expect(recovered[0]!.spent).toBe(true);
    });
});
