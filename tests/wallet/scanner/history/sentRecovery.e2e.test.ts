/**
 * Recuperación del historial de envíos, de extremo a extremo.
 *
 * El recorrido completo con criptografía real: dos identidades derivadas de
 * semillas, un pago construido por `NoteBuilder`, un indexer simulado que sirve
 * lo que serviría el real, y un emisor RESTAURADO —vault vacío, sin contador,
 * sin registro local— que reconstruye su historial y reemite el slip.
 *
 * Lo que se valida no es que las funciones devuelvan algo, sino que el receptor
 * pueda GASTAR la nota que sale al otro extremo. Un test que solo comprobara
 * campos podría estar recuperando una nota que nadie puede usar.
 *
 * Los ataques de abajo parten de que el indexer es un tercero: sirve lo que
 * quiera, y el emisor tiene que distinguir lo suyo de lo inventado.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { reconstructOutgoingTxRecords } from '../../../../src/wallet/scanner/history/reconstruct';
import type {
    ReconstructDeps,
    ReconstructedTxRecord,
} from '../../../../src/wallet/scanner/history/reconstruct';
import { NoteBuilder } from '../../../../src/protocol/note/NoteBuilder';
import {
    deriveViewingSecretKey,
    deriveViewingPublicKey,
    deriveOwnerPk,
} from '../../../../src/protocol/keys/PrivacyKeys';
import {
    derivePairwiseSharedSecret,
    derivePairwiseEphSk,
} from '../../../../src/protocol/eph/index';
import { importPaymentSlip } from '../../../../src/wallet/ops/notes/paymentSlipImport';
import { toHex } from '../../../../src/foundation/encoding/hex';
import type { ZkNote } from '../../../../src/protocol/types';

// ─── Identidades ─────────────────────────────────────────────────────────────

const SENDER_SK = 0xabc123n;
const RECIPIENT_SK = 0xdef456n;
const STRANGER_SK = 0x999999n;

const senderIvsk = deriveViewingSecretKey(SENDER_SK);
const recipientIvsk = deriveViewingSecretKey(RECIPIENT_SK);
const recipientIvk = deriveViewingPublicKey(recipientIvsk);
const recipientOwnerPk = deriveOwnerPk(RECIPIENT_SK);
const pairSecret = derivePairwiseSharedSecret(senderIvsk, recipientIvk);

const recipientKeys = {
    viewingSecretKey: recipientIvsk,
    spendingKey: RECIPIENT_SK,
    ownerPk: recipientOwnerPk,
};

const BLOCK = 500;
const EXTRINSIC = 2;
const TX_HASH = '0x' + 'aa'.repeat(32);
const FEE = 1_000_000_000_000n;

// ─── El pago, tal como lo produce una transferencia ──────────────────────────

/** La salida hacia el receptor: dirección sigilosa y efímera pairwise. */
async function buildPayment(value: bigint, index: number): Promise<ZkNote> {
    return NoteBuilder.build({
        value,
        assetId: 0n,
        blinding: 424242n,
        ownerPk: recipientOwnerPk,
        sourcePk: deriveOwnerPk(SENDER_SK),
        viewingPublicKey: recipientIvk,
        recipientOwnerPk,
        ephSkOverride: derivePairwiseEphSk(pairSecret, index),
    });
}

/** La nota de entrada que el emisor gastó para pagar. */
const spentInput = (value: bigint): ZkNote =>
    ({
        commitmentHex: '0x' + '11'.repeat(32),
        nullifierHex: '0x' + '22'.repeat(32),
        value,
        assetId: 0n,
        spent: true,
    }) as unknown as ZkNote;

const saved = vi.fn();

/**
 * Un emisor RESTAURADO: el vault trae de vuelta la nota gastada (el rescan la
 * recupera) pero no tiene historial de envíos ni contador.
 */
function restoredSender(
    output: ZkNote,
    over: {
        counterparties?: Uint8Array[];
        outputs?: unknown;
        inputValue?: bigint;
        fee?: bigint | null;
    } = {}
): ReconstructDeps {
    const inputValue = over.inputValue ?? FEE * 10n;
    const fee = over.fee === undefined ? FEE : over.fee;

    return {
        vault: {
            getAll: () => [spentInput(inputValue)],
            getTxRecords: async () => [],
            saveTxRecord: saved,
        },
        transfers: {
            byNullifiers: async () => [
                {
                    blockNumber: BLOCK,
                    extrinsicIndex: EXTRINSIC,
                    hash: TX_HASH,
                    timestampMs: 1_700_000_000_000,
                    matchedNullifiers: [spentInput(inputValue).nullifierHex],
                },
            ],
            byCommitments: async () => [],
            outputsByExtrinsics: vi.fn().mockResolvedValue(
                over.outputs ?? [
                    {
                        blockNumber: BLOCK,
                        extrinsicIndex: EXTRINSIC,
                        commitmentHex: output.commitmentHex,
                        leafIndex: 17,
                        encryptedMemo: toHex(Uint8Array.from(output.memo)),
                    },
                ]
            ),
        },
        txFacts: {
            byHash: async () => ({
                hash: TX_HASH,
                blockNumber: BLOCK,
                success: true,
                argsJson: JSON.stringify({
                    fee: fee === null ? null : fee.toString(),
                    asset_id: 0,
                    circuit_version: 1,
                }),
            }),
        },
        keys: {
            viewingSecretKey: senderIvsk,
            counterpartyIvks: over.counterparties ?? [recipientIvk],
        },
    } as unknown as ReconstructDeps;
}

const written = (): ReconstructedTxRecord => saved.mock.calls[0]?.[0];

beforeEach(() => saved.mockClear());

// ─── El recorrido completo ───────────────────────────────────────────────────

describe('un emisor restaurado reconstruye su envío', () => {
    it('recupera el importe exacto y reemite un slip que el receptor gasta', async () => {
        // La prueba que resume el plan entero: el emisor perdió todo salvo su
        // semilla, y aun así el receptor termina con una nota gastable.
        const output = await buildPayment(3_500n, 6);

        await reconstructOutgoingTxRecords(restoredSender(output));

        const record = written();
        expect(record.amount).toBe('3500');
        expect(record.paymentSlip).toMatch(/^orbslip1:/);

        const rebuilt = importPaymentSlip(record.paymentSlip!, recipientKeys);
        expect(rebuilt).not.toBeNull();
        expect(rebuilt!.value).toBe(3_500n);
        expect(rebuilt!.commitmentHex).toBe(output.commitmentHex);
        // Clave de gasto DERIVADA por el receptor, no transportada en el slip.
        expect(rebuilt!.spendingKey).not.toBe(0n);
        expect(rebuilt!.spendingKey).not.toBe(RECIPIENT_SK);
    });

    it('el importe recuperado no coincide con el que daría la aritmética', async () => {
        // Si coincidieran, este test pasaría aunque la recuperación no hiciera
        // nada. La resta daría 10000 − 0 − fee; el memo dice 3500.
        const output = await buildPayment(3_500n, 6);

        await reconstructOutgoingTxRecords(restoredSender(output, { inputValue: FEE * 10n }));

        expect(written().amount).toBe('3500');
        expect(written().amount).not.toBe((FEE * 10n - FEE).toString());
    });

    it('sin fee legible el importe sigue siendo exacto', async () => {
        // La marca de aproximado existe porque la resta sobreestima por el fee.
        // Una cifra leída del memo no arrastra ese error.
        const output = await buildPayment(3_500n, 6);

        await reconstructOutgoingTxRecords(restoredSender(output, { fee: null }));

        expect(written().amount).toBe('3500');
        expect('amountApproximate' in written()).toBe(false);
    });

    it('funciona con índices altos y con huecos', async () => {
        // El emisor no sabe qué índices publicó: reservas no gastadas dejan
        // huecos, así que la recuperación busca en vez de asumir.
        for (const index of [0, 1, 33, 63]) {
            saved.mockClear();
            const output = await buildPayment(777n, index);

            await reconstructOutgoingTxRecords(restoredSender(output));

            expect(written()?.amount).toBe('777');
        }
    });

    it('encuentra la contraparte correcta entre muchas', async () => {
        const output = await buildPayment(3_500n, 6);
        const many = [
            ...[1n, 2n, 3n, 4n].map((s) =>
                deriveViewingPublicKey(deriveViewingSecretKey(s))
            ),
            recipientIvk,
        ];

        await reconstructOutgoingTxRecords(restoredSender(output, { counterparties: many }));

        expect(written().amount).toBe('3500');
    });
});

// ─── El indexer es un tercero ────────────────────────────────────────────────

describe('un indexer hostil no consigue plantar un envío', () => {
    it('no atribuye al emisor un pago entre dos desconocidos', async () => {
        // El indexer devuelve una salida real de OTRO par. El emisor no puede
        // derivar su efímera, así que no la reclama como suya.
        const strangerIvsk = deriveViewingSecretKey(STRANGER_SK);
        const strangerIvk = deriveViewingPublicKey(strangerIvsk);
        const strangerOwn = deriveOwnerPk(STRANGER_SK);
        const ajena = await NoteBuilder.build({
            value: 999_999n,
            blinding: 1n,
            ownerPk: strangerOwn,
            viewingPublicKey: strangerIvk,
            recipientOwnerPk: strangerOwn,
            ephSkOverride: derivePairwiseEphSk(
                derivePairwiseSharedSecret(strangerIvsk, strangerIvk),
                0
            ),
        });

        await reconstructOutgoingTxRecords(restoredSender(ajena));

        // Cae a la aritmética: la fila existe, pero no con el importe ajeno.
        expect(written()?.amount).not.toBe('999999');
        expect('paymentSlip' in written()).toBe(false);
    });

    it('un memo manipulado no produce un importe inventado', async () => {
        // Cambiar un byte del memo rompe el MAC. La alternativa —aceptar el
        // plaintext— dejaría al indexer elegir qué importe ve el usuario.
        const output = await buildPayment(3_500n, 6);
        const roto = Uint8Array.from(output.memo);
        roto.set([(roto[40] as number) ^ 0x01], 40);

        await reconstructOutgoingTxRecords(
            restoredSender(output, {
                outputs: [
                    {
                        blockNumber: BLOCK,
                        extrinsicIndex: EXTRINSIC,
                        commitmentHex: output.commitmentHex,
                        leafIndex: 17,
                        encryptedMemo: toHex(roto),
                    },
                ],
            })
        );

        expect(written()?.amount).not.toBe('3500');
        expect('paymentSlip' in written()).toBe(false);
    });

    it('un commitment cruzado con otro memo no se acepta', async () => {
        const [a, b] = await Promise.all([buildPayment(100n, 1), buildPayment(999n, 2)]);

        await reconstructOutgoingTxRecords(
            restoredSender(a, {
                outputs: [
                    {
                        blockNumber: BLOCK,
                        extrinsicIndex: EXTRINSIC,
                        commitmentHex: b.commitmentHex,
                        leafIndex: 17,
                        encryptedMemo: toHex(Uint8Array.from(a.memo)),
                    },
                ],
            })
        );

        expect('paymentSlip' in written()).toBe(false);
    });

    it('salidas basura no tumban la reconstrucción', async () => {
        // Un campo malformado no puede costar la fila entera: la operación ya
        // ocurrió y el usuario tiene que verla.
        const output = await buildPayment(3_500n, 6);

        await reconstructOutgoingTxRecords(
            restoredSender(output, {
                outputs: [
                    { blockNumber: BLOCK, extrinsicIndex: EXTRINSIC, commitmentHex: '0xzz', leafIndex: 1, encryptedMemo: '' },
                    { blockNumber: BLOCK, extrinsicIndex: EXTRINSIC, commitmentHex: '', leafIndex: -5, encryptedMemo: '0xnothex' },
                ],
            })
        );

        expect(saved).toHaveBeenCalled();
        expect('paymentSlip' in written()).toBe(false);
    });

    it('un feed caído deja la fila deducida por aritmética', async () => {
        const output = await buildPayment(3_500n, 6);
        const deps = restoredSender(output);
        deps.transfers.outputsByExtrinsics = vi.fn().mockRejectedValue(new Error('503'));

        await reconstructOutgoingTxRecords(deps);

        expect(saved).toHaveBeenCalled();
        expect('paymentSlip' in written()).toBe(false);
    });
});

// ─── Lo que el slip reemitido no puede conceder ──────────────────────────────

describe('el slip reemitido no filtra ni otorga de más', () => {
    it('un tercero no lo abre', async () => {
        const output = await buildPayment(3_500n, 6);
        await reconstructOutgoingTxRecords(restoredSender(output));

        const intruso = {
            viewingSecretKey: deriveViewingSecretKey(STRANGER_SK),
            spendingKey: STRANGER_SK,
            ownerPk: deriveOwnerPk(STRANGER_SK),
        };

        expect(importPaymentSlip(written().paymentSlip!, intruso)).toBeNull();
    });

    it('no lleva el importe ni la contraparte en claro', async () => {
        // Los campos del slip son públicos, pero emparejarlos fuera de cadena
        // revela que ESTE receptor espera ESTE pago.
        const output = await buildPayment(3_500n, 6);
        await reconstructOutgoingTxRecords(restoredSender(output));

        const slip = written().paymentSlip!;
        expect(slip).not.toContain(output.commitmentHex.slice(2));
        expect(slip).not.toContain('3500');
    });

    it('dos reconstrucciones producen slips distintos que abren igual', async () => {
        // Efímera y nonce nuevos por sobre: bytes idénticos significarían un
        // nonce reutilizado, el único fallo que este formato no sobrevive.
        const output = await buildPayment(3_500n, 6);

        await reconstructOutgoingTxRecords(restoredSender(output));
        const first = written().paymentSlip!;
        saved.mockClear();
        await reconstructOutgoingTxRecords(restoredSender(output));
        const second = written().paymentSlip!;

        expect(first).not.toBe(second);
        expect(importPaymentSlip(first, recipientKeys)!.commitmentHex).toBe(
            importPaymentSlip(second, recipientKeys)!.commitmentHex
        );
    });
});
