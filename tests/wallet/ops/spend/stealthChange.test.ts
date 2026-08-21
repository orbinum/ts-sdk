/**
 * El cambio de una transferencia que gasta una nota SIGILOSA.
 *
 * Casi todo lo que un wallet gasta es una nota recibida, y una nota recibida es
 * sigilosa: su `spendingKey` es `stealthSk`, un escalar de un solo uso, y su
 * `ownerPk` es la clave sigilosa correspondiente — ninguno de los dos es la
 * identidad global del wallet.
 *
 * De ahí salen tres valores del cambio, y los tres tienen que apuntar a la
 * identidad GLOBAL o el cambio se vuelve invisible:
 *
 *   - la clave de visión que sella su memo — si sale del escalar sigiloso, el
 *     rescan (que usa la ivsk global) no puede abrirlo;
 *   - su `ownerPk` — si es la sigilosa, el commitment no coincide con lo que el
 *     rescan espera;
 *   - su `spendingKey` — de ella depende el nullifier.
 *
 * El fallo no se ve al enviar: el cambio se guarda en el vault desde memoria y
 * todo parece bien. Aparece al restaurar o rescanear, cuando el dinero
 * simplemente no está.
 */
import { describe, it, expect, vi } from 'vitest';
import { transferNotes } from '../../../../src/wallet/ops/spend/transfer';
import { NoteBuilder } from '../../../../src/protocol/note/NoteBuilder';
import { tryDecryptNote } from '../../../../src/protocol/note/NoteDecryptor';
import {
    deriveViewingSecretKey,
    deriveViewingPublicKey,
    deriveOwnerPk,
} from '../../../../src/protocol/keys/PrivacyKeys';
import { deriveStealthSk, deriveStealthOwnerPk } from '../../../../src/foundation/crypto/stealth';
import { recoverOwnerPkPoint } from '../../../../src/foundation/crypto/bjj';
import { toHex } from '../../../../src/foundation/encoding/hex';
import type { ZkNote } from '../../../../src/protocol/types';

const WALLET_SK = 111n;
const walletIvsk = deriveViewingSecretKey(WALLET_SK);
const walletOwnerPk = deriveOwnerPk(WALLET_SK);

/** Una nota recibida: sigilosa, con escalar y owner de un solo uso. */
async function receivedStealthNote(value: bigint): Promise<ZkNote> {
    const sharedSecret = new Uint8Array(32).fill(0x2b);
    const ownPoint = recoverOwnerPkPoint(walletOwnerPk)!;
    const stealthSk = deriveStealthSk(sharedSecret, walletOwnerPk, WALLET_SK);
    const stealthOwnerPk = deriveStealthOwnerPk(sharedSecret, walletOwnerPk, ownPoint);

    const note = await NoteBuilder.build({
        value,
        assetId: 0n,
        blinding: 4242n,
        ownerPk: stealthOwnerPk,
        spendingKey: stealthSk,
        viewingPublicKey: deriveViewingPublicKey(walletIvsk),
    });
    // Lo que el escaneo persiste: el escalar sigiloso, no el global.
    expect(note.spendingKey).not.toBe(WALLET_SK);
    expect(note.ownerPk).not.toBe(walletOwnerPk);
    return note;
}

/** Las deps mínimas para llegar a construir las salidas. */
function makeDeps(captured: { change?: ZkNote }) {
    return {
        privacy: {
            getNullifierStatus: vi.fn().mockResolvedValue({ isSpent: false }),
            getMerkleProofByCommitment: vi.fn().mockResolvedValue({
                root: '0x' + '11'.repeat(32),
                path: Array.from({ length: 20 }, () => '0x' + '00'.repeat(32)),
                leafIndex: 0,
            }),
        },
        // El proving real necesita artefactos de circuito que no existen aquí, y
        // no aporta nada: las salidas ya están construidas cuando se llega. Un
        // resolver que lanza corta justo después de construirlas.
        resolver: {
            resolve: vi.fn().mockRejectedValue(new Error('stop-after-outputs')),
        },
        // Modela `buildZkNote`: los campos que el llamador omite los rellena con
        // la identidad GLOBAL del wallet. Es justo el comportamiento del que
        // depende el arreglo, así que el falso tiene que tenerlo.
        buildNote: vi.fn().mockImplementation(async (p: Record<string, unknown>) => {
            const isOwnNote = p['recipientOwnerPk'] === undefined;
            const note = await NoteBuilder.build({
                value: p['value'] as bigint,
                assetId: p['assetId'] as bigint,
                blinding: 777n,
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
            return { note, outgoingIndex: undefined };
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
    } as unknown as Parameters<typeof transferNotes>[0];
}

describe('gastar una nota sigilosa deja un cambio que el rescan encuentra', () => {
    it('el memo del cambio se abre con la clave de visión GLOBAL', async () => {
        // La regresión: sellado con la clave derivada del escalar sigiloso, el
        // rescan no lo abría y el cambio quedaba invisible — dinero propio
        // perdido en cada transferencia que gastara una nota recibida.
        const captured: { change?: ZkNote } = {};
        const input = await receivedStealthNote(1000n);

        await transferNotes(makeDeps(captured), {
            inputNotes: [input],
            transferAmount: 400n,
            recipientPk: deriveOwnerPk(999n),
            recipientViewingPublicKey: deriveViewingPublicKey(deriveViewingSecretKey(999n)),
        }).catch(() => {});

        expect(captured.change).toBeDefined();
        const opened = tryDecryptNote(
            {
                commitmentHex: captured.change!.commitmentHex,
                leafIndex: 7,
                encryptedMemo: toHex(Uint8Array.from(captured.change!.memo)),
            },
            walletIvsk,
            WALLET_SK,
            walletOwnerPk
        );

        expect(opened).not.toBeNull();
        expect(opened!.value).toBe(600n);
    });

    it('el cambio pertenece a la identidad global, no a la sigilosa', async () => {
        // El commitment cubre el ownerPk. Uno sigiloso lo ataría a un escalar de
        // un solo uso que el wallet no vuelve a derivar.
        const captured: { change?: ZkNote } = {};
        const input = await receivedStealthNote(1000n);

        await transferNotes(makeDeps(captured), {
            inputNotes: [input],
            transferAmount: 400n,
            recipientPk: deriveOwnerPk(999n),
            recipientViewingPublicKey: deriveViewingPublicKey(deriveViewingSecretKey(999n)),
        }).catch(() => {});

        expect(captured.change!.ownerPk).toBe(walletOwnerPk);
        expect(captured.change!.spendingKey).toBe(WALLET_SK);
    });

    it('y el par clave/owner del cambio es coherente, así que es gastable', async () => {
        // `checkSpendableInputs` exige BabyPbk(spendingKey).Ax === ownerPk. Un
        // cambio incoherente se guarda bien y falla al intentar gastarlo.
        const captured: { change?: ZkNote } = {};
        const input = await receivedStealthNote(1000n);

        await transferNotes(makeDeps(captured), {
            inputNotes: [input],
            transferAmount: 400n,
            recipientPk: deriveOwnerPk(999n),
            recipientViewingPublicKey: deriveViewingPublicKey(deriveViewingSecretKey(999n)),
        }).catch(() => {});

        expect(deriveOwnerPk(captured.change!.spendingKey)).toBe(captured.change!.ownerPk);
    });
});
