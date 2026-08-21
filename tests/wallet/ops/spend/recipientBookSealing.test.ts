/**
 * El sellado de la libreta de receptores, desde `transferNotes`.
 *
 * Es la rama que corre en producción y la que ningún test de `ops/spend`
 * tocaba: `sentNoteRecovery.test.ts` prueba la recuperación, pero construye la
 * nota de cambio A MANO con `NoteBuilder`, así que nunca pasa por aquí. Entre
 * los dos quedaba un hueco por el que cabe justo el fallo que importa —
 * `transfer.ts` sellando la entrada contra el commitment equivocado.
 *
 * Qué se sella y por qué su clave es el commitment DEL PAGO:
 *
 *   - la entrada guarda la ivk del receptor, cifrada bajo el `ovk` del emisor;
 *   - viaja en el `sourcePk` de la nota de CAMBIO, que es propia y se reabre
 *     desde la semilla;
 *   - se abre con el commitment del PAGO, que es el único valor que las dos
 *     partes comparten y que un wallet restaurado tiene en el momento exacto en
 *     que lo necesita.
 *
 * Sellarla contra el commitment del cambio compilaría igual, se enviaría igual,
 * y sólo fallaría meses después al restaurar: la entrada nunca abriría, el
 * emisor no sabría a quién pagó y no podría reemitir el slip. Sin error.
 */
import { describe, it, expect, vi } from 'vitest';
import { transferNotes } from '../../../../src/wallet/ops/spend/transfer';
import { NoteBuilder } from '../../../../src/protocol/note/NoteBuilder';
import { openRecipientBookEntry } from '../../../../src/protocol/note/recipientBook';
import {
    deriveViewingSecretKey,
    deriveViewingPublicKey,
    deriveOwnerPk,
    deriveOutgoingViewingKeyV3,
} from '../../../../src/protocol/keys/PrivacyKeys';
import { toHex } from '../../../../src/foundation/encoding/hex';
import type { ZkNote } from '../../../../src/protocol/types';

const WALLET_SK = 111n;
const walletIvsk = deriveViewingSecretKey(WALLET_SK);
const walletOwnerPk = deriveOwnerPk(WALLET_SK);
const OVK = deriveOutgoingViewingKeyV3(new Uint8Array(32).fill(0x5a));

const RECIPIENT_SK = 777n;
const recipientOwnerPk = deriveOwnerPk(RECIPIENT_SK);
const recipientIvk = deriveViewingPublicKey(deriveViewingSecretKey(RECIPIENT_SK));

/** Una nota propia y corriente que la transferencia gasta. */
async function ownNote(value: bigint): Promise<ZkNote> {
    return NoteBuilder.build({
        value,
        assetId: 0n,
        blinding: 4242n,
        ownerPk: walletOwnerPk,
        spendingKey: WALLET_SK,
        viewingPublicKey: deriveViewingPublicKey(walletIvsk),
    });
}

/**
 * Deps que llegan justo hasta construir las salidas.
 *
 * `outgoingIndex` sale definido: es lo que hace que `transfer.ts` tome la rama
 * de la libreta en vez del respaldo. `stealthChange.test.ts` lo deja
 * `undefined` y por eso sólo recorre el respaldo.
 */
function makeDeps(captured: { payment?: ZkNote; change?: ZkNote }, withOvk = true) {
    return {
        privacy: {
            getNullifierStatus: vi.fn().mockResolvedValue({ isSpent: false }),
            getMerkleProofByCommitment: vi.fn().mockResolvedValue({
                root: '0x' + '11'.repeat(32),
                path: Array.from({ length: 20 }, () => '0x' + '00'.repeat(32)),
                leafIndex: 0,
            }),
        },
        // Cortar tras construir las salidas: el proving real necesita artefactos
        // de circuito que aquí no existen y no aportan nada a lo que se mide.
        resolver: { resolve: vi.fn().mockRejectedValue(new Error('stop-after-outputs')) },
        buildNote: vi.fn().mockImplementation(async (p: Record<string, unknown>) => {
            const isOwnNote = p['recipientOwnerPk'] === undefined;
            const note = await NoteBuilder.build({
                value: p['value'] as bigint,
                assetId: p['assetId'] as bigint,
                blinding: isOwnNote ? 999n : 31337n,
                ownerPk: (p['ownerPk'] as bigint | undefined) ?? walletOwnerPk,
                spendingKey: (p['spendingKey'] as bigint | undefined) ?? WALLET_SK,
                viewingPublicKey:
                    (p['viewingPublicKey'] as Uint8Array | undefined) ??
                    deriveViewingPublicKey(walletIvsk),
                ...(p['sourcePk'] !== undefined ? { sourcePk: p['sourcePk'] as bigint } : {}),
                ...(p['recipientOwnerPk'] !== undefined
                    ? { recipientOwnerPk: p['recipientOwnerPk'] as bigint }
                    : {}),
            });
            if (isOwnNote) captured.change = note;
            else captured.payment = note;
            // Un índice reservado de verdad para el pago: es la señal de que
            // este wallet publicó una efímera de su secuencia saliente.
            return { note, outgoingIndex: isOwnNote ? undefined : 0 };
        }),
        vault: { markSpent: vi.fn(), save: vi.fn() },
        recoverStealth: vi.fn().mockReturnValue(null),
        submit: vi.fn().mockResolvedValue({
            ok: true,
            txHash: '0xtx',
            blockHash: '0xb',
            blockNumber: 1,
        }),
        selfOwnerPk: walletOwnerPk,
        ...(withOvk ? { outgoingViewingKey: OVK } : {}),
    } as unknown as Parameters<typeof transferNotes>[0];
}

/** Ejecuta la transferencia y devuelve las notas que se construyeron. */
async function runTransfer(withOvk = true) {
    const captured: { payment?: ZkNote; change?: ZkNote } = {};
    const input = await ownNote(1000n);

    await transferNotes(makeDeps(captured, withOvk), {
        inputNotes: [input],
        transferAmount: 400n,
        recipientPk: recipientOwnerPk,
        recipientViewingPublicKey: recipientIvk,
        fee: 0n,
    }).catch(() => {
        // El resolver corta a propósito: las salidas ya están construidas.
    });

    return captured;
}

describe('transferNotes sella la libreta de receptores en el cambio', () => {
    it('la entrada abre con el commitment DEL PAGO y devuelve la ivk del receptor', async () => {
        // La prueba de extremo a extremo de la rama de producción: lo que
        // `transfer.ts` puso en `sourcePk` tiene que abrir con la clave que el
        // escaneo usará meses después.
        const { payment, change } = await runTransfer();

        expect(payment).toBeDefined();
        expect(change).toBeDefined();
        const opened = openRecipientBookEntry(change!.sourcePk!, OVK, payment!.commitmentHex);

        expect(toHex(opened)).toBe(toHex(recipientIvk));
    });

    it('NO abre con el commitment del cambio', async () => {
        // El error que compilaría igual y no fallaría hasta la restauración.
        // Sin este caso, sellar contra el commitment equivocado pasaría el test
        // anterior sólo si alguien lo escribiera con la clave equivocada también.
        const { change } = await runTransfer();

        const wrong = openRecipientBookEntry(change!.sourcePk!, OVK, change!.commitmentHex);

        expect(toHex(wrong)).not.toBe(toHex(recipientIvk));
    });

    it('el `ovk` de otro wallet no abre la entrada', async () => {
        // Va cifrada, no codificada: sin la rama saliente correcta no se saca
        // nada de ella. Es lo que impide que el indexer o un tercero lean con
        // quién comercia el usuario.
        const { payment, change } = await runTransfer();
        const otherOvk = deriveOutgoingViewingKeyV3(new Uint8Array(32).fill(0x99));

        const opened = openRecipientBookEntry(change!.sourcePk!, otherOvk, payment!.commitmentHex);

        expect(toHex(opened)).not.toBe(toHex(recipientIvk));
    });

    it('sin `ovk` cae al respaldo y NO sella libreta', async () => {
        // Una cartera watch-only o una identidad antigua: la transferencia
        // funciona igual y el emisor pierde ese historial, que es la decisión
        // deliberada — nunca romper el pago por no poder guardar la libreta.
        const { payment, change } = await runTransfer(false);

        expect(change!.sourcePk).toBe(payment!.ownerPk);
    });
});
