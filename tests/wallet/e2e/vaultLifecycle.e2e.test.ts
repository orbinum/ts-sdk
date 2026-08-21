/**
 * El vault de punta a punta: guardar, CERRAR, y volver a abrir.
 *
 * Todo lo demás prueba el vault por piezas. Esto prueba la única promesa que
 * un usuario nota: las notas siguen ahí mañana, y siguen siendo gastables.
 *
 * La diferencia con los otros E2E es que aquí se pasa por `unlock()` de
 * verdad. El resto del andamiaje abre la sesión a mano, lo que se salta el
 * descifrado de cada registro, la normalización y la comprobación de esquema
 * — y `getAll()` tras un `save()` lee la CACHÉ EN MEMORIA, así que pasaría
 * igual con el cifrado roto.
 *
 * Reabrir sobre el mismo `storage` es lo que obliga a los bytes a viajar por
 * disco: `encryptNote` → registro cegado → `decryptNoteRecord` → `normalizeNote`.
 * Una nota que pierda `spendingKey` o `blinding` en ese viaje vuelve con
 * aspecto de gastable y muere segundos dentro del proving, en un assert que no
 * nombra nada.
 */
import { describe, it, expect } from 'vitest';
import { openVault, freshVault } from '../../helpers/scanHarness';
import { NoteBuilder } from '../../../src/protocol/note/NoteBuilder';
import { deriveIdentity } from '../../../src/wallet/identity/walletIdentity';
import { checkSpendableInputs } from '../../../src/wallet/ops/spend/guards';
import { reserveOutgoingIndex } from '../../../src/wallet/vault/index';
import { VAULT_SCHEMA_VERSION } from '../../../src/index';
import type { ZkNote } from '../../../src/protocol/types';

const ROOT = new Uint8Array(32).fill(0x11);
const OTHER_ROOT = new Uint8Array(32).fill(0x22);
const me = deriveIdentity(ROOT, 'v3');

/** Una nota propia con criptografía real: la que un shield deja en el vault. */
async function ownNote(value: bigint): Promise<ZkNote> {
    return NoteBuilder.build({
        value,
        assetId: 0n,
        ownerPk: me.ownerPk,
        spendingKey: me.spendingKey,
        viewingPublicKey: me.viewingPublicKey,
    });
}

describe('una nota sobrevive al disco', () => {
    it('vuelve tras cerrar y reabrir con la misma identidad', async () => {
        const note = await ownNote(4200n);
        const first = await openVault(ROOT);
        await first.vault.save(note);

        // Vault nuevo sobre el MISMO almacenamiento: nada en memoria se hereda.
        const second = await openVault(ROOT, first.storage);

        expect(second.wasReset).toBe(false);
        expect(second.notes).toHaveLength(1);
        expect(second.notes[0]!.commitmentHex).toBe(note.commitmentHex);
    });

    it('y vuelve GASTABLE, no sólo presente', async () => {
        // La comprobación que importa: `checkSpendableInputs` recomputa el
        // commitment desde los campos releídos. Un `spendingKey` o un
        // `blinding` dañado por el viaje da una nota que existe y no se puede
        // mover — y el fallo aparecería dentro del proving, sin nombrarla.
        const note = await ownNote(4200n);
        const first = await openVault(ROOT);
        await first.vault.save(note);

        const { notes } = await openVault(ROOT, first.storage);

        expect(checkSpendableInputs([notes[0]]).ok).toBe(true);
    });

    it('conserva el valor y el blinding exactos', async () => {
        const note = await ownNote(1337n);
        const first = await openVault(ROOT);
        await first.vault.save(note);

        const { notes } = await openVault(ROOT, first.storage);

        expect(notes[0]!.value).toBe(1337n);
        expect(notes[0]!.blinding).toBe(note.blinding);
        expect(notes[0]!.spendingKey).toBe(note.spendingKey);
    });

    it('varias notas vuelven todas', async () => {
        const first = await openVault(ROOT);
        for (const v of [100n, 200n, 300n]) await first.vault.save(await ownNote(v));

        const { notes } = await openVault(ROOT, first.storage);

        expect(notes.map((n) => n.value).sort((a, b) => Number(a - b))).toEqual([100n, 200n, 300n]);
    });

    it('una nota marcada como gastada vuelve gastada', async () => {
        const note = await ownNote(500n);
        const first = await openVault(ROOT);
        await first.vault.save(note);
        await first.vault.markSpent(note.commitmentHex);

        const { notes } = await openVault(ROOT, first.storage);

        expect(notes[0]!.spent).toBe(true);
    });
});

describe('el vault se resetea cuando ya no es suyo', () => {
    it('otra identidad no lee las notas: resetea', async () => {
        // Los registros están cifrados bajo la clave de vault de `ROOT`. Con
        // otra raíz no descifra ninguno, y eso es indistinguible de un vault
        // corrupto — resetear es la única salida segura.
        const first = await openVault(ROOT);
        await first.vault.save(await ownNote(4200n));

        const intruder = await openVault(OTHER_ROOT, first.storage);

        expect(intruder.wasReset).toBe(true);
        expect(intruder.notes).toEqual([]);
    });

    it('y el almacenamiento queda utilizable tras el reset', async () => {
        // Un reset que dejara el config a medias haría que el siguiente unlock
        // volviera a resetear, en bucle, y el wallet nunca guardaría nada.
        const first = await openVault(ROOT);
        await first.vault.save(await ownNote(4200n));
        const intruder = await openVault(OTHER_ROOT, first.storage);
        await intruder.vault.save(
            await NoteBuilder.build({
                value: 7n,
                assetId: 0n,
                ownerPk: deriveIdentity(OTHER_ROOT, 'v3').ownerPk,
                spendingKey: deriveIdentity(OTHER_ROOT, 'v3').spendingKey,
                viewingPublicKey: deriveIdentity(OTHER_ROOT, 'v3').viewingPublicKey,
            })
        );

        const reopened = await openVault(OTHER_ROOT, intruder.storage);

        expect(reopened.wasReset).toBe(false);
        expect(reopened.notes).toHaveLength(1);
    });

    it('una cadena distinta resetea aunque la identidad sea la misma', async () => {
        // Un commitment sólo existe en la cadena que lo acuñó. Llevar el vault
        // a otra red deja notas cuyo commitment no está, y el escaneo lee esa
        // ausencia como "gastadas o desaparecidas".
        const first = await openVault(ROOT, undefined, { chainFingerprint: '0xchainA' });
        await first.vault.save(await ownNote(4200n));

        const moved = await openVault(ROOT, first.storage, { chainFingerprint: '0xchainB' });

        expect(moved.wasReset).toBe(true);
        expect(moved.notes).toEqual([]);
    });

    it('un esquema anterior resetea en vez de leerse mal', async () => {
        // Un registro viejo cuyos campos casualmente descifren cargaría con una
        // forma que este build malinterpreta. Las notas vuelven de un rescan;
        // una nota mal leída no avisa.
        const first = await openVault(ROOT);
        await first.vault.save(await ownNote(4200n));
        const config = (await first.storage.getConfig())!;
        await first.storage.putConfig({ ...config, v: VAULT_SCHEMA_VERSION - 1 });

        const reopened = await openVault(ROOT, first.storage);

        expect(reopened.wasReset).toBe(true);
    });
});

describe('lo que el reset NO puede tirar', () => {
    it('el contador de efímeras salientes sobrevive al reset', async () => {
        // Las notas vuelven de la cadena; el contador no. Reiniciarlo hace que
        // el siguiente pago republique una efímera ya publicada, y eso enlaza
        // las dos notas en público como del mismo emisor.
        const first = await openVault(ROOT);
        await reserveOutgoingIndex(first.storage);
        await reserveOutgoingIndex(first.storage);

        // Reset por identidad ajena: lo más destructivo que hace el vault.
        await openVault(OTHER_ROOT, first.storage);
        const next = await reserveOutgoingIndex(first.storage);

        expect(next).toBeGreaterThanOrEqual(2);
    });
});

describe('un registro corrupto no se lleva el vault por delante', () => {
    it('abre con las notas sanas y avisa de la que no', async () => {
        // Los registros están sellados uno a uno, así que uno ilegible es una
        // fila corrupta y no evidencia sobre las demás. Fallar entero convierte
        // un byte malo en disco —una escritura a medias, una cuota agotada— en
        // un wallet vacío.
        const first = await openVault(ROOT);
        await first.vault.save(await ownNote(100n));
        await first.vault.save(await ownNote(200n));

        const records = await first.storage.getAllNoteRecords();
        await first.storage.putNote({ ...records[0]!, ciphertext: 'bm90LWEtY2lwaGVydGV4dA==' });

        let skipped = 0;
        const reopened = await openVault(ROOT, first.storage, {
            onRecordsSkipped: (n) => {
                skipped = n;
            },
        });

        expect(reopened.wasReset).toBe(false);
        expect(reopened.notes).toHaveLength(1);
        expect(skipped).toBe(1);
    });

    it('pero si NINGUNO descifra, resetea', async () => {
        // Que fallen todos no es "el disco está mal", es "esta no es la clave".
        const first = await openVault(ROOT);
        await first.vault.save(await ownNote(100n));
        const records = await first.storage.getAllNoteRecords();
        for (const r of records)
            await first.storage.putNote({ ...r, ciphertext: 'bm90LWEtY2lwaGVydGV4dA==' });

        const reopened = await openVault(ROOT, first.storage);

        expect(reopened.wasReset).toBe(true);
    });
});

describe('el contraste que da sentido a todo lo anterior', () => {
    it('`freshVault` NO ejercita nada de esto', async () => {
        // Documenta por qué los otros E2E no bastan: la sesión abierta a mano
        // deja `getAll()` leyendo la caché, así que una nota "sobrevive" sin
        // haber tocado el disco.
        const { vault } = await freshVault(ROOT);
        const note = await ownNote(4200n);
        await vault.save(note);

        expect(vault.getAll()).toHaveLength(1);
    });
});
