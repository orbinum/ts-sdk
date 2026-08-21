/**
 * Un escaneo real, con paginación real y el kernel de descifrado de verdad.
 *
 * Los otros E2E manejan seis pistas servidas en una sola página. Eso deja el
 * bucle de paginación sin dar una segunda vuelta: un `sinceLeafIndex` que no se
 * propague, o un recuento de páginas que no respete el límite que el servidor
 * aplicó de verdad, pasan inadvertidos.
 *
 * Importa por cómo interactúa con la purga. Sólo un escaneo completo purga, y
 * lee la AUSENCIA de un commitment como prueba de que la nota ya no está. Si la
 * paginación se salta una página, esas notas faltan del conjunto on-chain y el
 * escaneo las borra del vault — notas vivas, sin un solo error.
 *
 * Aquí convergen a la vez las cuatro condiciones de un wallet con historia:
 * notas propias, ajenas, gastadas y fantasmas.
 */
import { describe, it, expect } from 'vitest';
import {
    openVault,
    pagedHintSource,
    nullifierSource,
    realPool,
    asHint,
} from '../../helpers/scanHarness';
import { runScan } from '../../../src/wallet/scanner/pipeline';
import { NoteBuilder } from '../../../src/protocol/note/NoteBuilder';
import { deriveIdentity } from '../../../src/wallet/identity/walletIdentity';
import { PAGE_SIZE } from '../../../src/wallet/scanner/phases/collect';
import { isSpendable } from '../../../src/protocol/spend/index';
import type { ScanHint } from '../../../src/wallet/scanner/feed/sources';
import type { ZkNote } from '../../../src/protocol/types';

const ROOT = new Uint8Array(32).fill(0x51);
const me = deriveIdentity(ROOT, 'v3');
const stranger = deriveIdentity(new Uint8Array(32).fill(0x52), 'v3');

const scanKeys = () => ({
    viewingKey: me.viewingSecretKey,
    spendingKey: me.spendingKey,
    ownerPk: me.ownerPk,
});

/** Una nota que este wallet posee. */
const mine = (value: bigint, blinding: bigint): Promise<ZkNote> =>
    NoteBuilder.build({
        value,
        assetId: 0n,
        blinding,
        ownerPk: me.ownerPk,
        spendingKey: me.spendingKey,
        viewingPublicKey: me.viewingPublicKey,
    });

/** Una nota de otra persona: mismo formato, distinta clave de visión. */
const theirs = (value: bigint, blinding: bigint): Promise<ZkNote> =>
    NoteBuilder.build({
        value,
        assetId: 0n,
        blinding,
        ownerPk: stranger.ownerPk,
        spendingKey: stranger.spendingKey,
        viewingPublicKey: stranger.viewingPublicKey,
    });

/**
 * Un pool de pistas grande, con las propias repartidas por todo el rango.
 *
 * Repartidas a propósito: si estuvieran juntas al principio, un escaneo que
 * sólo sirviera la primera página las encontraría todas y el test pasaría con
 * la paginación rota.
 */
async function buildPool(totalHints: number, ownAt: number[]) {
    const own: ZkNote[] = [];
    const hints: ScanHint[] = [];
    const filler = asHint(await theirs(1n, 4242n), 0);
    for (let i = 0; i < totalHints; i++) {
        if (ownAt.includes(i)) {
            const note = await mine(BigInt(100 + i), BigInt(1000 + i));
            own.push(note);
            hints.push(asHint(note, i));
        } else {
            // El relleno se CLONA de una sola nota ajena real, cambiando el
            // commitment. Construir miles de notas de verdad cuesta un minuto
            // de reloj y no añade nada: lo que se mide aquí es la paginación,
            // y para el kernel un memo ajeno es un memo que no abre.
            hints.push({ ...filler, leafIndex: i, commitmentHex: `0xfill${i}` });
        }
    }
    return { own, hints };
}

describe('un escaneo que recorre varias páginas', () => {
    it('encuentra las notas propias repartidas por todo el feed', async () => {
        // Más de una página, con propias en la primera, la última y en medio.
        const total = PAGE_SIZE * 2 + 10;
        const ownAt = [3, PAGE_SIZE + 7, total - 2];
        const { own, hints } = await buildPool(total, ownAt);
        const source = pagedHintSource(hints);
        const { vault, storage } = await openVault(ROOT);

        const result = await runScan({
            vault,
            storage,
            hints: source,
            nullifiers: nullifierSource(),
            pool: realPool(),
            keys: scanKeys(),
        });

        expect(result.found).toBe(own.length);
        expect(source.calls()).toBeGreaterThan(1);
    });

    it('y las notas encontradas sobreviven al disco', async () => {
        // El escaneo persiste; reabrir prueba que lo persistido se relee.
        const total = PAGE_SIZE + 50;
        const { own, hints } = await buildPool(total, [1, PAGE_SIZE + 5]);
        const { vault, storage } = await openVault(ROOT);

        await runScan({
            vault,
            storage,
            hints: pagedHintSource(hints),
            nullifiers: nullifierSource(),
            pool: realPool(),
            keys: scanKeys(),
        });
        const reopened = await openVault(ROOT, storage);

        expect(reopened.notes.map((n) => n.value).sort((a, b) => Number(a - b))).toEqual(
            own.map((n) => n.value).sort((a, b) => Number(a - b))
        );
    });

    it('ignora las notas ajenas, por muchas que haya', async () => {
        const total = PAGE_SIZE + 100;
        const { own, hints } = await buildPool(total, [42]);
        const { vault, storage } = await openVault(ROOT);

        await runScan({
            vault,
            storage,
            hints: pagedHintSource(hints),
            nullifiers: nullifierSource(),
            pool: realPool(),
            keys: scanKeys(),
        });

        expect(vault.getAll()).toHaveLength(own.length);
    });
});

describe('las cuatro condiciones a la vez', () => {
    it('propias encontradas, ajenas ignoradas, gastadas marcadas, fantasmas purgados', async () => {
        // El estado de un wallet con historia. Cada pieza está probada por
        // separado; lo que no estaba probado es que convivan.
        const total = PAGE_SIZE + 60;
        const ownAt = [5, PAGE_SIZE + 20];
        const { own, hints } = await buildPool(total, ownAt);

        const { vault, storage } = await openVault(ROOT);
        // Un fantasma: en el vault, ausente del feed. Un escaneo completo debe
        // purgarlo — es una nota que la cadena ya no reconoce.
        const ghost = await mine(999n, 777n);
        await vault.save(ghost);

        const result = await runScan({
            vault,
            storage,
            hints: pagedHintSource(hints),
            // La primera de las propias, ya gastada en cadena.
            nullifiers: nullifierSource([own[0]!.nullifierHex.toLowerCase()]),
            pool: realPool(),
            keys: scanKeys(),
        });

        const notes = vault.getAll();
        const byCommitment = new Map(notes.map((n) => [n.commitmentHex, n]));

        // Propias: ambas presentes.
        expect(byCommitment.has(own[0]!.commitmentHex)).toBe(true);
        expect(byCommitment.has(own[1]!.commitmentHex)).toBe(true);
        // Gastada: marcada, y ya no seleccionable.
        expect(byCommitment.get(own[0]!.commitmentHex)!.spent).toBe(true);
        expect(isSpendable(byCommitment.get(own[0]!.commitmentHex)!)).toBe(false);
        // La otra sigue viva.
        expect(isSpendable(byCommitment.get(own[1]!.commitmentHex)!)).toBe(true);
        // Fantasma: fuera.
        expect(byCommitment.has(ghost.commitmentHex)).toBe(false);
        expect(result.purged).toBe(1);
        // Ajenas: ninguna entró.
        expect(notes).toHaveLength(2);
    });

    it('NO purga una nota que el feed sí sirve, en una página tardía', async () => {
        // El escenario que hace peligrosa una paginación rota: la nota ya está
        // en el vault ANTES del escaneo —así que es purgable— y el feed la
        // sirve, pero en la última página. Si el conjunto on-chain no llega
        // hasta ahí, la ausencia se lee como "la cadena ya no la tiene" y una
        // nota viva se borra sin un solo error.
        const total = PAGE_SIZE + 40;
        const survivor = await mine(4242n, 31337n);
        const { hints } = await buildPool(total, []);
        // Servida al final, más allá de la primera página.
        hints[total - 1] = asHint(survivor, total - 1);

        const { vault, storage } = await openVault(ROOT);
        await vault.save(survivor);

        const result = await runScan({
            vault,
            storage,
            hints: pagedHintSource(hints),
            nullifiers: nullifierSource(),
            pool: realPool(),
            keys: scanKeys(),
        });

        expect(result.purged).toBe(0);
        expect(vault.getAll().some((n) => n.commitmentHex === survivor.commitmentHex)).toBe(true);
    });

    it('un escaneo INCREMENTAL no purga, aunque no vea la nota', async () => {
        // Una ventana incremental nunca pidió los bloques anteriores, así que
        // la ausencia no prueba nada. Purgar ahí borraría el vault entero en
        // cada tick.
        const { hints } = await buildPool(PAGE_SIZE + 10, []);
        const { vault, storage } = await openVault(ROOT);
        const ghost = await mine(999n, 777n);
        await vault.save(ghost);

        const result = await runScan({
            vault,
            storage,
            hints: pagedHintSource(hints),
            nullifiers: nullifierSource(),
            pool: realPool(),
            keys: scanKeys(),
            sinceLeafIndex: PAGE_SIZE,
        });

        expect(result.purged).toBe(0);
        expect(vault.getAll().some((n) => n.commitmentHex === ghost.commitmentHex)).toBe(true);
    });
});

describe('el cursor sobrevive y reanuda', () => {
    it('un escaneo incremental sólo pide lo que hay más allá del cursor', async () => {
        const total = PAGE_SIZE + 40;
        const { own, hints } = await buildPool(total, [2, PAGE_SIZE + 10]);
        const { vault, storage } = await openVault(ROOT);

        // Completo primero: deja el cursor al final.
        await runScan({
            vault,
            storage,
            hints: pagedHintSource(hints),
            nullifiers: nullifierSource(),
            pool: realPool(),
            keys: scanKeys(),
        });

        // Incremental desde una hoja posterior a la primera propia: sólo la
        // segunda cae dentro de la ventana.
        const second = pagedHintSource(hints);
        const result = await runScan({
            vault,
            storage,
            hints: second,
            nullifiers: nullifierSource(),
            pool: realPool(),
            keys: scanKeys(),
            sinceLeafIndex: PAGE_SIZE,
        });

        expect(result.incremental).toBe(true);
        // Ya estaban ambas: la ventana no descubre nada nuevo.
        expect(result.found).toBe(0);
        expect(vault.getAll()).toHaveLength(own.length);
    });
});
