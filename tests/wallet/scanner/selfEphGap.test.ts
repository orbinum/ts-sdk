/**
 * resolveSelfEphCeiling — el sweep gap-limit que corrige el contador self-eph
 * tras un restore con notas más allá de la ventana de descubrimiento.
 *
 * Escenario del bug que previene: contador perdido + notas en índices ≥
 * ventana → el scan solo reporta el máximo DENTRO de la ventana → un bump
 * ingenuo reutilizaría índices ya publicados (mismo ephPk dos veces on-chain
 * = linkage de creador). Integración contra el SDK real.
 */
import { describe, it, expect } from 'vitest';
import {
    NoteBuilder,
    deriveSelfEphSk,
    deriveViewingSecretKey,
    deriveViewingPublicKey,
    deriveOwnerPk,
} from '../../../src/index';
import type { ZkNote } from '../../../src/index';
import {
    resolveSelfEphCeiling,
    windowSizeForCounter,
    gapMargin,
} from '../../../src/wallet/scanner/selfEphGap';
import { SELF_EPH_WINDOW } from '../../../src/index';

const SPENDING_KEY = 12345678901234567890n;
const ivsk = deriveViewingSecretKey(SPENDING_KEY);
const ivk = deriveViewingPublicKey(ivsk);
const ownerPk = deriveOwnerPk(SPENDING_KEY);

async function selfNote(index: number): Promise<ZkNote> {
    return NoteBuilder.build({
        value: 100n + BigInt(index),
        assetId: 0n,
        ownerPk,
        blinding: 500n + BigInt(index),
        spendingKey: SPENDING_KEY,
        viewingPublicKey: ivk,
        circuitVersion: 1,
        ephSkOverride: deriveSelfEphSk(SPENDING_KEY, index),
    });
}

// Ventana chica para que el test derive pocas EC; margen = 16/16 = 1.
const WINDOW = 16;

describe('resolveSelfEphCeiling', () => {
    it('contador perdido + notas más allá de la ventana → techo real vía sweep', async () => {
        // Notas en 5 y 15 (dentro de la ventana [0,16); 15 ≥ 16−1 dispara el
        // sweep) y en 20 y 35 (solo alcanzables por extensión).
        const notes = await Promise.all([5, 15, 20, 35].map(selfNote));

        const ceiling = resolveSelfEphCeiling({
            notes,
            spendingKey: SPENDING_KEY,
            viewingKey: ivsk,
            scanMaxIndex: 15, // lo único que el scan pudo ver
            windowSize: WINDOW,
        });

        // Extiende [16,32) → matchea 20; [32,48) → matchea 35; [48,64) → vacío.
        expect(ceiling).toBe(35);
    });

    it('máximo lejos del tope → devuelve el valor del scan sin barrer', async () => {
        const notes = await Promise.all([3, 7].map(selfNote));

        const ceiling = resolveSelfEphCeiling({
            notes,
            spendingKey: SPENDING_KEY,
            viewingKey: ivsk,
            scanMaxIndex: 7, // 7 < 16 − 1 → sin sweep
            windowSize: WINDOW,
        });

        expect(ceiling).toBe(7);
    });

    it('sin matches en la primera extensión → se detiene (gap limit), techo = scan', async () => {
        // Nota en el tope exacto de la ventana pero ninguna más allá.
        const notes = [await selfNote(15)];

        const ceiling = resolveSelfEphCeiling({
            notes,
            spendingKey: SPENDING_KEY,
            viewingKey: ivsk,
            scanMaxIndex: 15,
            windowSize: WINDOW,
        });

        expect(ceiling).toBe(15);
    });

    it('null in → null out; notas ajenas o sin memo no rompen el sweep', async () => {
        expect(
            resolveSelfEphCeiling({
                notes: [],
                spendingKey: SPENDING_KEY,
                viewingKey: ivsk,
                scanMaxIndex: null,
                windowSize: WINDOW,
            })
        ).toBeNull();

        const foreign = { memo: [] } as unknown as ZkNote; // sin memo válido
        const ceiling = resolveSelfEphCeiling({
            notes: [foreign, await selfNote(15)],
            spendingKey: SPENDING_KEY,
            viewingKey: ivsk,
            scanMaxIndex: 15,
            windowSize: WINDOW,
        });
        expect(ceiling).toBe(15);
    });
});

describe('windowSizeForCounter', () => {
    it('contador chico → ventana default; contador grande → redondeo hacia arriba', () => {
        expect(windowSizeForCounter(0)).toBe(SELF_EPH_WINDOW);
        expect(windowSizeForCounter(500)).toBe(SELF_EPH_WINDOW);
        // Contador justo bajo el tope pero dentro del margen → siguiente múltiplo.
        expect(windowSizeForCounter(SELF_EPH_WINDOW - 1)).toBe(SELF_EPH_WINDOW * 2);
        expect(windowSizeForCounter(SELF_EPH_WINDOW * 2 + 5)).toBe(SELF_EPH_WINDOW * 3);
    });

    it('gapMargin escala con la ventana (1024→64, 16→1)', () => {
        expect(gapMargin(1024)).toBe(64);
        expect(gapMargin(16)).toBe(1);
    });
});
