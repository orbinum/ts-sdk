/**
 * selectGhosts — qué notas puede borrar la purga de un full scan.
 *
 * Tres condiciones, y la tercera es la que arregla el bug reportado: una nota
 * creada por el usuario MIENTRAS el scan corría no es purgable por ese scan,
 * porque `onChainHexes` es un snapshot congelado que legítimamente no la
 * contiene (el indexer no la había servido todavía).
 */
import { describe, it, expect } from 'vitest';
import type { ZkNote } from '../../../../src/index';
import { selectGhosts, purgeIsTrustworthy } from '../../../../src/wallet/scanner/phases/persist';

/** Nota mínima: la purga sólo mira commitmentHex y spent. */
const note = (commitmentHex: string, spent = false) =>
    ({ commitmentHex, spent, spentAt: null }) as ZkNote;

describe('selectGhosts', () => {
    it('purga una nota previa que la cadena no tiene', () => {
        const ghost = note('0xghost');

        expect(selectGhosts([ghost], new Set(), new Set(['0xghost']))).toEqual(['0xghost']);
    });

    it('no purga una nota que sí está on-chain', () => {
        const real = note('0xreal');

        expect(selectGhosts([real], new Set(['0xreal']), new Set(['0xreal']))).toEqual([]);
    });

    // Una nota gastada ya no cuenta para el balance; borrarla perdería el
    // historial sin ganar nada.
    it('no purga una nota gastada aunque falte on-chain', () => {
        const spent = note('0xspent', true);

        expect(selectGhosts([spent], new Set(), new Set(['0xspent']))).toEqual([]);
    });

    // El caso del bug: guardada mid-scan, así que no está en el snapshot inicial.
    it('no purga una nota que no existía cuando el scan arrancó', () => {
        const born = note('0xnueva');

        expect(selectGhosts([born], new Set(), new Set(['0xvieja']))).toEqual([]);
    });

    it('purga sólo las previas cuando conviven con una nacida mid-scan', () => {
        const notes = [note('0xvieja'), note('0xnueva')];

        expect(selectGhosts(notes, new Set(), new Set(['0xvieja']))).toEqual(['0xvieja']);
    });

    // Sin snapshot no hay forma de distinguir, así que se conserva el
    // comportamiento anterior en vez de dejar de purgar del todo.
    it('sin snapshot purga toda nota ausente, como antes', () => {
        const notes = [note('0xa'), note('0xb')];

        expect(selectGhosts(notes, new Set(), undefined)).toEqual(['0xa', '0xb']);
    });

    it('sin notas devuelve lista vacía', () => {
        expect(selectGhosts([], new Set(), new Set())).toEqual([]);
    });
});

/**
 * purgeIsTrustworthy — the gate that keeps a silent feed from wiping a wallet.
 *
 * The purge reads `onChainHexes` INVERTED: a commitment missing from it is
 * treated as rolled back. That inference is only sound if the feed answered at
 * all. An indexer that was reset, misconfigured, or simply returns an empty page
 * with HTTP 200 confirms zero commitments — and the purge used to read that as
 * "every note you own is gone" and delete the whole vault.
 */
describe('purgeIsTrustworthy', () => {
    it('refuses a purge when the scan walked no hints at all', () => {
        expect(purgeIsTrustworthy(0, 3)).toBe(false);
    });

    it('allows a purge once the feed served hints', () => {
        // Serving hints proves the feed is answering, which is all this gate
        // asks. Whether it answered COMPLETELY is not locally decidable — a
        // wallet whose notes all legitimately moved confirms none of them too.
        expect(purgeIsTrustworthy(500, 3)).toBe(true);
    });

    it('is vacuously fine when there is nothing to purge', () => {
        expect(purgeIsTrustworthy(0, 0)).toBe(true);
    });
});
