/**
 * El contrato de mayúsculas entre la ventana saliente y su búsqueda.
 *
 * La ventana guarda `ephPkHex → índice`, y el lado que consulta baja a
 * minúsculas SIEMPRE (`hintEphPkHex` en `decryptBatch`). Si el lado que guarda
 * no hace lo mismo, ningún pago propio vuelve a reconocerse.
 *
 * Y el fallo no da error: `outgoingByEphPk.get()` devuelve `undefined`, que se
 * lee como «este hint no es un pago mío». El escaneo termina limpio,
 * `sentNotes` vacío, y el emisor pierde el historial entero — exactamente el
 * mismo desenlace que el bug del offset del indexer.
 *
 * Hoy funciona porque `deriveOutgoingEphPk` termina en `.toLowerCase()`. Eso es
 * un invariante de OTRO módulo, no escrito en ningún sitio, y las dos ventanas
 * hermanas (self y pairwise) sí normalizan por su cuenta. Estos tests fijan el
 * contrato del lado que consulta, para que la garantía no dependa de un detalle
 * de implementación ajeno.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { decryptHintBatch } from '../../../../src/wallet/worker/kernel/decryptBatch';
import { clearKnownEphWindow } from '../../../../src/wallet/worker/kernel/ephWindow';
import { deriveOutgoingEphPk } from '../../../../src/protocol/eph/outgoingEph';
import {
    deriveViewingSecretKey,
    deriveOwnerPk,
    deriveOutgoingViewingKeyV3,
} from '../../../../src/protocol/keys/PrivacyKeys';
import type { ScanKeys } from '../../../../src/wallet/worker/kernel/types';
import type { ScanCommitment } from '../../../../src/protocol/types';

const SPENDING_KEY = 999n;
const OVK = deriveOutgoingViewingKeyV3(new Uint8Array(32).fill(0x7c));

const keys = (): ScanKeys => ({
    viewingKey: deriveViewingSecretKey(SPENDING_KEY),
    spendingKey: SPENDING_KEY,
    ownerPk: deriveOwnerPk(SPENDING_KEY),
    outgoingEph: true,
    outgoingViewingKey: OVK,
    outgoingEphWindowSize: 8,
});

/**
 * Un hint cuyo ephPk es el del índice `i` de la secuencia saliente.
 *
 * El memo son 180 bytes con el ephPk en los últimos 32, que es de donde lo lee
 * el escáner. El resto es relleno: el memo no llega a abrirse porque no hay
 * ninguna entrada de libreta, y lo que se mide aquí es el RECONOCIMIENTO.
 */
function outgoingHint(i: number): ScanCommitment {
    const ephPkHex = deriveOutgoingEphPk(OVK, i).slice(2);
    return {
        commitmentHex: '0x' + (i + 1).toString(16).padStart(64, '0'),
        leafIndex: i,
        encryptedMemo: '0x' + 'cd'.repeat(148) + ephPkHex,
    };
}

beforeEach(() => {
    clearKnownEphWindow();
});

describe('reconocimiento de pagos propios y mayúsculas', () => {
    it('reconoce un pago servido con el ephPk en MAYÚSCULAS', async () => {
        // Un feed que sirva hex en mayúsculas es válido — el hex no distingue
        // caso. Si eso bastara para dejar de reconocer los pagos, el emisor
        // perdería su historial según qué indexer le toque.
        const hint = outgoingHint(0);
        const upper: ScanCommitment = {
            ...hint,
            encryptedMemo: hint.encryptedMemo!.toUpperCase().replace('0X', '0x'),
        };

        const result = decryptHintBatch([upper], keys());

        // No se abre (no hay libreta), pero SÍ se reconoce como pago propio:
        // queda pendiente de abrir en vez de pasar por nota ajena.
        expect(result.unmatchedSent).toHaveLength(1);
        expect(result.maxOutgoingEphIndex).toBe(0);
    });

    it('reconoce el mismo pago en minúsculas', async () => {
        // El contraste: la forma que ya servía. Sin este caso el anterior no
        // demostraría nada — podría estar reconociendo por otro motivo.
        const result = decryptHintBatch([outgoingHint(0)], keys());

        expect(result.unmatchedSent).toHaveLength(1);
        expect(result.maxOutgoingEphIndex).toBe(0);
    });

    it('el índice saliente más alto se detecta con cualquier caso', async () => {
        // Este contador repara la secuencia guardada. Perderlo hace que el
        // siguiente pago reserve un índice ya publicado, y dos notas que
        // comparten ephPk quedan enlazadas en público como del mismo emisor.
        const mixed = [outgoingHint(1), outgoingHint(3)].map((h, i) => ({
            ...h,
            encryptedMemo:
                i === 0 ? h.encryptedMemo!.toUpperCase().replace('0X', '0x') : h.encryptedMemo,
        }));

        const result = decryptHintBatch(mixed, keys());

        expect(result.maxOutgoingEphIndex).toBe(3);
    });

    it('un ephPk que NO es de esta cartera no se reconoce', async () => {
        // La otra dirección: reconocer de más metería notas ajenas en el
        // historial de envíos del usuario.
        const foreign = deriveOutgoingEphPk(
            deriveOutgoingViewingKeyV3(new Uint8Array(32).fill(0x11)),
            0
        ).slice(2);

        const result = decryptHintBatch(
            [
                {
                    commitmentHex: '0x' + 'ff'.repeat(32),
                    leafIndex: 0,
                    encryptedMemo: '0x' + 'cd'.repeat(148) + foreign,
                },
            ],
            keys()
        );

        expect(result.unmatchedSent).toHaveLength(0);
        expect(result.maxOutgoingEphIndex).toBeNull();
    });
});
