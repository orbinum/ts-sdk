/**
 * reconstruct — unit tests for the outgoing tx-history reconstruction
 * (previously only reachable through the full rescan and silently untested:
 * the service wraps it in a non-fatal try/catch).
 */
import { vi, describe, it, expect, beforeEach } from 'vitest';
import { reconstructOutgoingTxRecords } from '../../../../src/wallet/scanner/history/reconstruct';
import type { ReconstructDeps } from '../../../../src/wallet/scanner/history/reconstruct';
import type { ZkNote } from '../../../../src/protocol/types';
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
import { toHex, scalarToHex } from '../../../../src/foundation/encoding/hex';
import {
    openPaymentSlip,
    decodePaymentSlip,
} from '../../../../src/protocol/memo/PaymentSlip';
import { importPaymentSlip } from '../../../../src/wallet/ops/notes/paymentSlipImport';

const mocks = {
    getAll: vi.fn(),
    getTxRecords: vi.fn(),
    saveTxRecord: vi.fn(),
};

/** Stand-in for the app's configured minimum — any nonzero base works here. */
const MIN_GASLESS_FEE = 1_000_000_000_000n;

/**
 * The fee the sender actually chose, deliberately ABOVE the client's configured
 * minimum: reconstruction used to assume MIN_GASLESS_FEE, so any transfer that
 * paid more had its amount silently overstated by the difference. Every amount
 * assertion here is anchored to this value, so a regression to the constant
 * fails instead of passing by coincidence.
 */
const REAL_FEE = MIN_GASLESS_FEE * 3n;

// ─── Fixtures ─────────────────────────────────────────────────────────────────

function note(over: Partial<ZkNote>): ZkNote {
    return {
        value: 0n,
        assetId: 0n,
        ownerPk: 0n,
        blinding: 0n,
        spendingKey: 0n,
        commitment: 0n,
        nullifier: 0n,
        commitmentHex: '0xc',
        nullifierHex: '0xn',
        memo: [],
        sourcePk: 0n,
        spent: false,
        spentAt: null,
        ...over,
    } as ZkNote;
}

// Input gastado de 10 ORB-planck… usamos valores grandes para cubrir la fee real.
const INPUT = note({
    commitmentHex: '0xc-in',
    nullifierHex: '0xn-in',
    value: 5_000_000_000_000_000n,
    assetId: 0n,
    spent: true,
});
// Change sin gastar de la misma extrinsic, con el pk del destinatario.
const CHANGE = note({
    commitmentHex: '0xc-change',
    nullifierHex: '0xn-change',
    value: 1_000_000_000_000_000n,
    sourcePk: 0xabcn,
    spent: false,
});

const TRANSFER = {
    blockNumber: 100,
    extrinsicIndex: 2,
    hash: '0xhash-100-2',
    timestampMs: 1_000,
    matchedNullifiers: ['0xn-in'],
};

/** An indexer extrinsic row carrying decoded args, as `/extrinsics/:hash` serves it. */
function extrinsicRow(over: { fee?: unknown; success?: boolean } = {}) {
    const { fee = REAL_FEE.toString(), success = true } = over;
    return {
        hash: TRANSFER.hash,
        blockNumber: 100,
        success,
        // Balances decode to decimal strings (safeJson stringifies bigints).
        argsJson: JSON.stringify({ fee, asset_id: 0, circuit_version: 1 }),
    };
}

function makeIndexer(
    over: Partial<Record<string, unknown>> = {},
    extrinsics: Partial<Record<string, unknown>> = {}
): ReconstructDeps {
    return {
        vault: {
            getAll: mocks.getAll,
            getTxRecords: mocks.getTxRecords,
            saveTxRecord: mocks.saveTxRecord,
        },
        transfers: {
            byNullifiers: vi.fn().mockResolvedValue([TRANSFER]),
            byCommitments: vi
                .fn()
                .mockResolvedValue([
                    { blockNumber: 100, extrinsicIndex: 2, matchedCommitments: ['0xc-change'] },
                ]),
            ...over,
        },
        txFacts: {
            byHash: vi.fn().mockResolvedValue(extrinsicRow()),
            ...extrinsics,
        },
    } as unknown as ReconstructDeps;
}

beforeEach(() => {
    vi.clearAllMocks();
    mocks.getAll.mockReturnValue([INPUT, CHANGE]);
    mocks.getTxRecords.mockResolvedValue([]);
    mocks.saveTxRecord.mockResolvedValue(undefined);
});

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('reconstructOutgoingTxRecords', () => {
    it('sin notas gastadas → no consulta al indexer', async () => {
        mocks.getAll.mockReturnValue([CHANGE]); // nada spent
        const indexer = makeIndexer();

        await reconstructOutgoingTxRecords(indexer);

        expect(indexer.transfers.byNullifiers).not.toHaveBeenCalled();
        expect(mocks.saveTxRecord).not.toHaveBeenCalled();
    });

    it('reconstruye el record: amount = inputs − change − fee REAL, pk del change note', async () => {
        await reconstructOutgoingTxRecords(makeIndexer());

        const expectedAmount = INPUT.value - CHANGE.value - REAL_FEE;
        expect(mocks.saveTxRecord).toHaveBeenCalledExactlyOnceWith({
            id: '0xhash-100-2',
            type: 'private_transfer',
            blockNumber: 100,
            hash: '0xhash-100-2',
            assetId: '0',
            amount: expectedAmount.toString(),
            recipientPkHex: '0x' + 'abc'.padStart(64, '0'),
            status: 'success',
            feePlanck: REAL_FEE.toString(),
            timestampMs: 1_000,
        });
        // Regresión: con el fee asumido el monto salía MIN_GASLESS_FEE*2 más alto.
        expect(mocks.saveTxRecord).not.toHaveBeenCalledWith(
            expect.objectContaining({
                amount: (INPUT.value - CHANGE.value - MIN_GASLESS_FEE).toString(),
            })
        );
    });

    it('salta transfers cuyo LocalTxRecord ya tiene recipient conocido', async () => {
        mocks.getTxRecords.mockResolvedValue([
            {
                // `id` es la clave de almacenamiento, igual que la escribe
                // `saveTxRecord`; una fila sin él no existe en un vault real.
                id: '0xhash-100-2',
                hash: '0xhash-100-2',
                recipientPkHex: '0x' + 'abc'.padStart(64, '0'),
            },
        ]);

        await reconstructOutgoingTxRecords(makeIndexer());

        expect(mocks.saveTxRecord).not.toHaveBeenCalled();
    });

    it('backfillea el pk en un record existente con pk cero, sin tocar otros campos', async () => {
        const existing = {
            id: '0xhash-100-2',
            hash: '0xhash-100-2',
            type: 'private_transfer',
            blockNumber: 100,
            assetId: '0',
            amount: '12345',
            recipientPkHex: '0x' + '00'.repeat(32),
            status: 'success',
            timestampMs: 1_000,
        };
        mocks.getTxRecords.mockResolvedValue([existing]);

        await reconstructOutgoingTxRecords(makeIndexer());

        expect(mocks.saveTxRecord).toHaveBeenCalledExactlyOnceWith({
            ...existing,
            recipientPkHex: '0x' + 'abc'.padStart(64, '0'),
        });
    });

    it('backfillea aunque la change note ya esté gastada (transfers encadenados)', async () => {
        mocks.getTxRecords.mockResolvedValue([{ id: '0xhash-100-2', hash: '0xhash-100-2' }]);
        mocks.getAll.mockReturnValue([INPUT, { ...CHANGE, spent: true }]);

        await reconstructOutgoingTxRecords(makeIndexer());

        expect(mocks.saveTxRecord).toHaveBeenCalledExactlyOnceWith(
            expect.objectContaining({ recipientPkHex: '0x' + 'abc'.padStart(64, '0') })
        );
    });

    it('record existente sin pk y change note sin counterparty → no reescribe nada', async () => {
        mocks.getTxRecords.mockResolvedValue([{ id: '0xhash-100-2', hash: '0xhash-100-2' }]);
        mocks.getAll.mockReturnValue([INPUT, { ...CHANGE, sourcePk: 0n }]);

        await reconstructOutgoingTxRecords(makeIndexer());

        expect(mocks.saveTxRecord).not.toHaveBeenCalled();
    });

    it('salta transfers sin input notes propias (matchedNullifiers ajenos)', async () => {
        const indexer = makeIndexer({
            byNullifiers: vi
                .fn()
                .mockResolvedValue([{ ...TRANSFER, matchedNullifiers: ['0xn-desconocido'] }]),
        });

        await reconstructOutgoingTxRecords(indexer);

        expect(mocks.saveTxRecord).not.toHaveBeenCalled();
    });

    it('amount ≤ 0 (inputs no cubren change+fee) → no guarda registro basura', async () => {
        mocks.getAll.mockReturnValue([{ ...INPUT, value: REAL_FEE }, CHANGE]);

        await reconstructOutgoingTxRecords(makeIndexer());

        expect(mocks.saveTxRecord).not.toHaveBeenCalled();
    });

    it('sin change note (gasto total): amount = inputs − fee, pk en ceros', async () => {
        const indexer = makeIndexer({
            byCommitments: vi.fn().mockResolvedValue([]), // ningún change matcheado
        });

        await reconstructOutgoingTxRecords(indexer);

        const expectedAmount = INPUT.value - REAL_FEE;
        expect(mocks.saveTxRecord).toHaveBeenCalledExactlyOnceWith(
            expect.objectContaining({
                amount: expectedAmount.toString(),
                recipientPkHex: '0x' + '00'.repeat(32),
            })
        );
    });

    it('getTxRecords lanza (vault sin historial) → se trata como vacío y reconstruye', async () => {
        mocks.getTxRecords.mockRejectedValue(new Error('locked'));

        await reconstructOutgoingTxRecords(makeIndexer());

        expect(mocks.saveTxRecord).toHaveBeenCalledOnce();
    });

    it('hash null: usa block-index como id y hash vacío', async () => {
        const indexer = makeIndexer({
            byNullifiers: vi.fn().mockResolvedValue([{ ...TRANSFER, hash: null }]),
        });

        await reconstructOutgoingTxRecords(indexer);

        expect(mocks.saveTxRecord).toHaveBeenCalledExactlyOnceWith(
            expect.objectContaining({ id: '100-2', hash: '' })
        );
        // Sin hash no hay extrinsic que consultar → el monto queda aproximado.
        expect(indexer.txFacts.byHash).not.toHaveBeenCalled();
    });

    // ─── Fee real: resolución y fallback ────────────────────────────────────────

    describe('resolución del fee', () => {
        it.each([
            ['extrinsic ausente (404)', { byHash: vi.fn().mockResolvedValue(null) }],
            ['indexer inalcanzable', { byHash: vi.fn().mockRejectedValue(new Error('offline')) }],
            ['argsJson corrupto', { byHash: vi.fn().mockResolvedValue({ argsJson: '{no json' }) }],
            [
                'sin campo fee',
                { byHash: vi.fn().mockResolvedValue({ argsJson: '{"asset_id":0}' }) },
            ],
            [
                'fee no numérico',
                { byHash: vi.fn().mockResolvedValue(extrinsicRow({ fee: '12abc' })) },
            ],
            ['fee negativo', { byHash: vi.fn().mockResolvedValue(extrinsicRow({ fee: -5 })) }],
        ])(
            '%s → marca el monto como aproximado y no inventa feePlanck',
            async (_label, extrinsics) => {
                await reconstructOutgoingTxRecords(makeIndexer({}, extrinsics));

                const saved = mocks.saveTxRecord.mock.calls[0]![0];
                expect(saved.amountApproximate).toBe(true);
                expect(saved.feePlanck).toBeUndefined();
                // Sin fee que restar el monto es la cota superior, no una cifra inventada.
                expect(saved.amount).toBe((INPUT.value - CHANGE.value).toString());
            }
        );

        it('acepta un fee serializado como número (u128 chico)', async () => {
            await reconstructOutgoingTxRecords(
                makeIndexer({}, { byHash: vi.fn().mockResolvedValue(extrinsicRow({ fee: 12345 })) })
            );

            expect(mocks.saveTxRecord).toHaveBeenCalledExactlyOnceWith(
                expect.objectContaining({
                    feePlanck: '12345',
                    amount: (INPUT.value - CHANGE.value - 12345n).toString(),
                })
            );
        });

        it('un fee resuelto NO marca el monto como aproximado', async () => {
            await reconstructOutgoingTxRecords(makeIndexer());

            const saved = mocks.saveTxRecord.mock.calls[0]![0];
            expect(saved.amountApproximate).toBeUndefined();
        });

        it('consulta el extrinsic una sola vez por transfer', async () => {
            const indexer = makeIndexer();

            await reconstructOutgoingTxRecords(indexer);

            expect(indexer.txFacts.byHash).toHaveBeenCalledExactlyOnceWith('0xhash-100-2');
        });
    });

    // ─── Estado on-chain ────────────────────────────────────────────────────────

    it('extrinsic con success:false → status failed (antes toda tx decía success)', async () => {
        await reconstructOutgoingTxRecords(
            makeIndexer({}, { byHash: vi.fn().mockResolvedValue(extrinsicRow({ success: false })) })
        );

        expect(mocks.saveTxRecord).toHaveBeenCalledExactlyOnceWith(
            expect.objectContaining({ status: 'failed' })
        );
    });

    it('extrinsic irresoluble → status success, como las filas legacy sin estado', async () => {
        await reconstructOutgoingTxRecords(
            makeIndexer({}, { byHash: vi.fn().mockResolvedValue(null) })
        );

        expect(mocks.saveTxRecord).toHaveBeenCalledExactlyOnceWith(
            expect.objectContaining({ status: 'success' })
        );
    });
});

// ─── La clave con la que se guarda y la clave con la que se busca ────────────

describe('un registro sin hash se reconoce en la siguiente pasada', () => {
    it('no lo vuelve a escribir como si fuera nuevo', async () => {
        // `saveTxRecord` guarda por `id`, que cae a `{bloque}-{indice}` cuando
        // la extrinsic no trae hash. Buscar solo por `hash` no lo encuentra —
        // queda `''` — así que la reconstrucción siguiente lo trata como nuevo
        // y lo reescribe, perdiendo lo que la fila ya tuviera.
        const sinHash = { ...TRANSFER, hash: undefined };
        const deps = makeIndexer({ byNullifiers: vi.fn().mockResolvedValue([sinHash]) });

        // Primera pasada: crea la fila con id "100-2" y hash vacío.
        await reconstructOutgoingTxRecords(deps);
        const escrito = mocks.saveTxRecord.mock.calls[0]?.[0];
        expect(escrito?.id).toBe('100-2');
        expect(escrito?.hash).toBe('');

        // Segunda pasada, con esa fila ya guardada y su destinatario conocido.
        mocks.saveTxRecord.mockClear();
        mocks.getTxRecords.mockResolvedValue([escrito]);
        await reconstructOutgoingTxRecords(deps);

        expect(mocks.saveTxRecord).not.toHaveBeenCalled();
    });
});

// ─── El importe exacto, leído del memo que el emisor selló ───────────────────
//
// La aritmética (`Σ inputs − cambio − fee`) es una estimación: si el fee no se
// puede leer, el importe sobreestima exactamente por él. Cuando la contraparte
// está en el vault, el emisor re-deriva la efímera que usó y lee la cifra que
// escribió, sin nada nuevo en cadena.

describe('reconstrucción con recuperación del memo', () => {
    const SENDER_SK = 111n;
    const RECIPIENT_SK = 222n;
    const STRANGER_SK = 999n;

    const senderIvsk = deriveViewingSecretKey(SENDER_SK);
    const recipientIvsk = deriveViewingSecretKey(RECIPIENT_SK);
    const recipientIvk = deriveViewingPublicKey(recipientIvsk);
    const recipientOwnerPk = deriveOwnerPk(RECIPIENT_SK);
    const pairSecret = derivePairwiseSharedSecret(senderIvsk, recipientIvk);

    /** El pago real que la extrinsic publicó, con efímera derivada. */
    async function sentNote(value: bigint, index = 4) {
        return NoteBuilder.build({
            value,
            assetId: 0n,
            blinding: 777n,
            ownerPk: recipientOwnerPk,
            sourcePk: deriveOwnerPk(SENDER_SK),
            viewingPublicKey: recipientIvk,
            recipientOwnerPk,
            ephSkOverride: derivePairwiseEphSk(pairSecret, index),
        });
    }

    /** Las deps con el feed de salidas y las claves del emisor cableadas. */
    function withRecovery(note: ZkNote, counterparties = [recipientIvk]): ReconstructDeps {
        const base = makeIndexer();
        return {
            ...base,
            transfers: {
                ...base.transfers,
                outputsByExtrinsics: vi.fn().mockResolvedValue([
                    {
                        blockNumber: 100,
                        extrinsicIndex: 2,
                        commitmentHex: note.commitmentHex,
                        leafIndex: 9,
                        encryptedMemo: toHex(Uint8Array.from(note.memo)),
                    },
                ]),
            },
            keys: { viewingSecretKey: senderIvsk, counterpartyIvks: counterparties },
        } as ReconstructDeps;
    }

    it('usa el importe del memo, no el deducido por resta', async () => {
        // El importe real (5000) no coincide con lo que daría la aritmética
        // sobre las notas del fixture: si el test pasa, viene del memo.
        const note = await sentNote(5000n);

        await reconstructOutgoingTxRecords(withRecovery(note));

        const written = mocks.saveTxRecord.mock.calls[0]?.[0];
        expect(written.amount).toBe('5000');
    });

    it('un importe recuperado no se marca aproximado aunque falte el fee', async () => {
        // La marca existe porque la resta sobreestima por el fee que no se pudo
        // leer. Una cifra leída del memo no arrastra ese error.
        const note = await sentNote(5000n);
        const deps = withRecovery(note);
        deps.txFacts.byHash = vi.fn().mockResolvedValue(extrinsicRow({ fee: null }));

        await reconstructOutgoingTxRecords(deps);

        const written = mocks.saveTxRecord.mock.calls[0]?.[0];
        expect(written.amount).toBe('5000');
        expect('amountApproximate' in written).toBe(false);
    });

    it('el destinatario sale del memo sellado, no de la nota de cambio', async () => {
        const note = await sentNote(5000n);

        await reconstructOutgoingTxRecords(withRecovery(note));

        const written = mocks.saveTxRecord.mock.calls[0]?.[0];
        expect(written.recipientPkHex).toBe(scalarToHex(note.ownerPk));
    });

    it('vuelve a la aritmética cuando la contraparte no está en el vault', async () => {
        // Sin la clave correcta el barrido no encuentra nada, y el registro
        // tiene que seguir escribiéndose por la vía de siempre.
        const note = await sentNote(5000n);
        const strangerIvk = deriveViewingPublicKey(deriveViewingSecretKey(STRANGER_SK));

        await reconstructOutgoingTxRecords(withRecovery(note, [strangerIvk]));

        const written = mocks.saveTxRecord.mock.calls[0]?.[0];
        expect(written).toBeDefined();
        expect(written.amount).not.toBe('5000');
    });

    it('vuelve a la aritmética cuando el feed no sirve salidas', async () => {
        // `outputsByExtrinsics` es opcional: un host que no lo implemente
        // conserva exactamente el comportamiento anterior.
        const deps = makeIndexer();

        await reconstructOutgoingTxRecords(deps);

        expect(mocks.saveTxRecord).toHaveBeenCalled();
    });

    it('un feed que falla no impide escribir el registro', async () => {
        // Perder la cifra exacta es aceptable; perder la fila no.
        const note = await sentNote(5000n);
        const deps = withRecovery(note);
        deps.transfers.outputsByExtrinsics = vi.fn().mockRejectedValue(new Error('502'));

        await reconstructOutgoingTxRecords(deps);

        expect(mocks.saveTxRecord).toHaveBeenCalled();
    });

    it('encuentra la contraparte correcta entre varias', async () => {
        // Un monedero con varias contrapartes las prueba todas; la equivocada
        // no puede atribuir el pago a la persona incorrecta.
        const note = await sentNote(5000n);
        const otras = [
            deriveViewingPublicKey(deriveViewingSecretKey(777n)),
            recipientIvk,
            deriveViewingPublicKey(deriveViewingSecretKey(888n)),
        ];

        await reconstructOutgoingTxRecords(withRecovery(note, otras));

        expect(mocks.saveTxRecord.mock.calls[0]?.[0].amount).toBe('5000');
    });
    it('reemite un slip que el receptor puede abrir', async () => {
        // El objetivo final: tras restaurar, el emisor puede volver a entregar
        // un slip funcional sin pedirle nada al receptor. Se sella hacia la
        // contraparte que el barrido acaba de identificar.
        const note = await sentNote(5000n);

        await reconstructOutgoingTxRecords(withRecovery(note));

        const slip = mocks.saveTxRecord.mock.calls[0]?.[0].paymentSlip as string;
        expect(slip).toMatch(/^orbslip1:/);

        const opened = openPaymentSlip(recipientIvsk, decodePaymentSlip(slip)!);
        expect(opened).not.toBeNull();
        expect(opened!.commitmentHex).toBe(note.commitmentHex);
    });

    it('el slip reemitido reconstruye la nota gastable del receptor', async () => {
        // Abrir el sobre no basta: lo que importa es que el receptor recupere
        // una nota que puede gastar.
        const note = await sentNote(5000n);

        await reconstructOutgoingTxRecords(withRecovery(note));

        const slip = mocks.saveTxRecord.mock.calls[0]?.[0].paymentSlip as string;
        const rebuilt = importPaymentSlip(slip, {
            viewingSecretKey: recipientIvsk,
            spendingKey: RECIPIENT_SK,
            ownerPk: recipientOwnerPk,
        });

        expect(rebuilt).not.toBeNull();
        expect(rebuilt!.value).toBe(5000n);
        expect(rebuilt!.commitmentHex).toBe(note.commitmentHex);
    });

    it('sin recuperación no inventa un slip', async () => {
        // Un registro deducido por aritmética no sabe hacia quién sellar, y un
        // slip sellado hacia la contraparte equivocada no lo abriría nadie.
        await reconstructOutgoingTxRecords(makeIndexer());

        const written = mocks.saveTxRecord.mock.calls[0]?.[0];
        expect('paymentSlip' in written).toBe(false);
    });
});
