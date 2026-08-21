/**
 * Dos carteras reales, ida y VUELTA.
 *
 * A→B estaba cubierto en varios sitios. B→A no lo estaba en ninguno: nada
 * tomaba una nota que B había RECIBIDO — descubierta escaneando, con su clave
 * de gasto stealth derivada, no fabricada por el test — y la volvía a gastar.
 *
 * Ese es el caso que más se parece al uso real y el que más piezas encadena:
 * la nota que B gasta es stealth, así que su `ownerPk` y su `spendingKey` son
 * valores de un solo uso que B no vuelve a derivar. Construir el cambio a
 * partir de ellos fue un fallo real, y sólo aparece cuando el gasto arranca de
 * una nota recibida en vez de una sintética.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { runScan } from '../../../src/wallet/scanner/pipeline';
import { NoteBuilder } from '../../../src/protocol/note/NoteBuilder';
import { clearKnownEphWindow } from '../../../src/wallet/worker/kernel/ephWindow';
import { deriveIdentity } from '../../../src/wallet/identity/walletIdentity';
import { deriveSelfEphSk } from '../../../src/protocol/eph/selfEph';
import { checkSpendableInputs, noteMatchesCommitment } from '../../../src/wallet/ops/spend/guards';
import { selectNotes } from '../../../src/protocol/spend/coinSelection';
import {
    freshVault,
    asHint,
    hintSource,
    nullifierSource,
    realPool,
} from '../../helpers/scanHarness';
import type { ZkNote } from '../../../src/protocol/types';

const A_ROOT = new Uint8Array(32).fill(0xaa);
const B_ROOT = new Uint8Array(32).fill(0xbb);
const alice = deriveIdentity(A_ROOT, 'v3');
const bob = deriveIdentity(B_ROOT, 'v3');

const scanKeys = (id: typeof alice) => ({
    viewingKey: id.viewingSecretKey,
    spendingKey: id.spendingKey,
    ownerPk: id.ownerPk,
    outgoingViewingKey: id.outgoingViewingKey!,
});

/** Un pago de `from` hacia `to`, tal como lo publica el wallet. */
const pay = (to: typeof bob, value: bigint, from: typeof alice): Promise<ZkNote> =>
    NoteBuilder.build({
        value,
        assetId: 0n,
        ownerPk: to.ownerPk,
        recipientOwnerPk: to.ownerPk,
        viewingPublicKey: to.viewingPublicKey,
        sourcePk: from.ownerPk,
    });

describe('A paga a B, B lo encuentra, B lo devuelve', () => {
    beforeEach(() => clearKnownEphWindow());

    it('B descubre el pago escaneando, sin que nadie se lo diga', async () => {
        const { vault, storage } = await freshVault(B_ROOT);
        const note = await pay(bob, 4200n, alice);

        await runScan({
            vault,
            storage,
            hints: hintSource([asHint(note, 0)]),
            nullifiers: nullifierSource(),
            pool: realPool(),
            keys: scanKeys(bob),
        });

        expect(vault.getAll().map((n) => n.value)).toEqual([4200n]);
    });

    it('la nota que B encontró es gastable de verdad', async () => {
        // No basta con que aparezca en el saldo: su clave de gasto es un
        // `stealthSk` derivado del secreto compartido, y las guardas
        // recomputan el commitment desde los escalares almacenados.
        const { vault, storage } = await freshVault(B_ROOT);
        const note = await pay(bob, 4200n, alice);

        await runScan({
            vault,
            storage,
            hints: hintSource([asHint(note, 0)]),
            nullifiers: nullifierSource(),
            pool: realPool(),
            keys: scanKeys(bob),
        });

        const found = vault.getAll()[0]!;
        expect(noteMatchesCommitment(found)).toBe(true);
        expect(checkSpendableInputs([found]).ok).toBe(true);
        // Stealth: la clave que la gasta NO es la identidad global de B.
        expect(found.spendingKey).not.toBe(bob.spendingKey);
        expect(found.ownerPk).not.toBe(bob.ownerPk);
    });

    it('B la gasta de vuelta hacia A, y A encuentra el pago', async () => {
        // El viaje completo. La entrada de B es una nota RECIBIDA (stealth), que
        // es de donde salía el fallo del cambio heredado.
        const bobVault = await freshVault(B_ROOT);
        const incoming = await pay(bob, 4200n, alice);
        await runScan({
            vault: bobVault.vault,
            storage: bobVault.storage,
            hints: hintSource([asHint(incoming, 0)]),
            nullifiers: nullifierSource(),
            pool: realPool(),
            keys: scanKeys(bob),
        });

        // `selectNotes` devuelve una unión: un par de notas, «hay que
        // consolidar», o nada. Estrecharla aquí es parte de lo que se prueba —
        // que la nota recibida es elegible como entrada de gasto.
        const selection = selectNotes(bobVault.vault.getAll(), 1000n);
        expect(Array.isArray(selection)).toBe(true);
        const input = (selection as [ZkNote, ZkNote | null])[0];
        expect(input.value).toBe(4200n);

        // B construye el pago de vuelta y su cambio. El cambio va a la
        // identidad GLOBAL de B, nunca a los valores de un solo uso de la
        // entrada — si los heredara, un reescaneo de B no volvería a abrirlo.
        const backToAlice = await pay(alice, 1000n, bob);
        const change = await NoteBuilder.build({
            value: input.value - 1000n,
            assetId: 0n,
            ownerPk: bob.ownerPk,
            spendingKey: bob.spendingKey,
            viewingPublicKey: bob.viewingPublicKey,
            ephSkOverride: deriveSelfEphSk(bob.viewingSecretKey, 0),
        });

        clearKnownEphWindow();
        const aliceVault = await freshVault(A_ROOT);
        await runScan({
            vault: aliceVault.vault,
            storage: aliceVault.storage,
            hints: hintSource([asHint(backToAlice, 10), asHint(change, 11)]),
            nullifiers: nullifierSource(),
            pool: realPool(),
            keys: scanKeys(alice),
        });

        // A ve SÓLO su pago: el cambio de B no es suyo.
        expect(aliceVault.vault.getAll().map((n) => n.value)).toEqual([1000n]);
    });

    it('y el cambio de B vuelve a abrirse en un reescaneo de B', async () => {
        // La otra mitad del mismo fallo: el cambio se sella hacia la clave de
        // visión GLOBAL de B, así que B lo recupera desde la semilla sola.
        const change = await NoteBuilder.build({
            value: 3200n,
            assetId: 0n,
            ownerPk: bob.ownerPk,
            spendingKey: bob.spendingKey,
            viewingPublicKey: bob.viewingPublicKey,
            ephSkOverride: deriveSelfEphSk(bob.viewingSecretKey, 0),
        });

        clearKnownEphWindow();
        const { vault, storage } = await freshVault(B_ROOT);
        await runScan({
            vault,
            storage,
            hints: hintSource([asHint(change, 0)]),
            nullifiers: nullifierSource(),
            pool: realPool(),
            keys: scanKeys(bob),
        });

        expect(vault.getAll().map((n) => n.value)).toEqual([3200n]);
    });
});

describe('ninguna cartera puede tocar lo de la otra', () => {
    beforeEach(() => clearKnownEphWindow());

    it('A no encuentra el pago dirigido a B', async () => {
        const { vault, storage } = await freshVault(A_ROOT);
        const toBob = await pay(bob, 4200n, alice);

        await runScan({
            vault,
            storage,
            hints: hintSource([asHint(toBob, 0)]),
            nullifiers: nullifierSource(),
            pool: realPool(),
            keys: scanKeys(alice),
        });

        // A lo envió, así que puede RECONOCERLO como propio saliente, pero no
        // lo posee: no entra en su saldo.
        expect(vault.getAll()).toEqual([]);
    });

    it('B no encuentra el cambio de A', async () => {
        const aliceChange = await NoteBuilder.build({
            value: 800n,
            assetId: 0n,
            ownerPk: alice.ownerPk,
            spendingKey: alice.spendingKey,
            viewingPublicKey: alice.viewingPublicKey,
            ephSkOverride: deriveSelfEphSk(alice.viewingSecretKey, 0),
        });

        const { vault, storage } = await freshVault(B_ROOT);
        await runScan({
            vault,
            storage,
            hints: hintSource([asHint(aliceChange, 0)]),
            nullifiers: nullifierSource(),
            pool: realPool(),
            keys: scanKeys(bob),
        });

        expect(vault.getAll()).toEqual([]);
    });
});
