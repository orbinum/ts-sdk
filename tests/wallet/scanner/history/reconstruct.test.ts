/**
 * reconstruct — unit tests for the outgoing tx-history reconstruction
 * (previously only reachable through the full rescan and silently untested:
 * the service wraps it in a non-fatal try/catch).
 */
import { vi, describe, it, expect, beforeEach } from 'vitest';
import { reconstructOutgoingTxRecords } from '../../../../src/wallet/scanner/history/reconstruct';
import type { ReconstructDeps } from '../../../../src/wallet/scanner/history/reconstruct';
import type { ZkNote } from '../../../../src/protocol/types';

const mocks = {
    getAll: vi.fn(),
    getTxRecords: vi.fn(),
    saveTxRecord: vi.fn(),
    collectOutgoingFacts: vi.fn(),
};

// Real crypto stays; only the fact lookup is stubbed so the targeted-recovery
// wiring can be tested without sealing real blobs.
vi.mock('../../../../src/protocol/note/index', async (importOriginal) => ({
    ...(await importOriginal<object>()),
    collectOutgoingFacts: (...args: unknown[]) => mocks.collectOutgoingFacts(...args),
}));

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
            hash: '0xhash-100-2',
            blockNumber: 100,
            timestampMs: 1_000,
            direction: 'out',
            kind: 'private_transfer',
            origin: 'transfer-change',
            source: 'inferred',
            // Inferred from the change note, so a ONE-TIME key either way.
            peer: { pk: 0xabcn, scope: 'stealth' },
            // Derived, but the fee resolved — so the figure IS exact.
            amount: { value: expectedAmount, exact: true },
            assetId: 0n,
            status: 'success',
            feePlanck: REAL_FEE,
        });
        // Regresión: con el fee asumido el monto salía MIN_GASLESS_FEE*2 más alto.
        expect(mocks.saveTxRecord).not.toHaveBeenCalledWith(
            expect.objectContaining({
                amount: { value: INPUT.value - CHANGE.value - MIN_GASLESS_FEE, exact: true },
            })
        );
    });

    it('salta transfers cuyo LocalTxRecord ya tiene recipient conocido', async () => {
        mocks.getTxRecords.mockResolvedValue([
            { hash: '0xhash-100-2', peer: { pk: 0xabcn, scope: 'stealth' } },
        ]);

        await reconstructOutgoingTxRecords(makeIndexer());

        expect(mocks.saveTxRecord).not.toHaveBeenCalled();
    });

    it('backfillea el pk en un record witnessed sin pisar sus hechos (y rellena el fee ausente)', async () => {
        const existing = {
            id: '0xhash-100-2',
            hash: '0xhash-100-2',
            blockNumber: 100,
            timestampMs: 1_000,
            direction: 'out' as const,
            kind: 'private_transfer' as const,
            origin: 'transfer-change' as const,
            source: 'witnessed' as const,
            peer: null,
            amount: { value: 12345n, exact: true },
            assetId: 0n,
            status: 'success' as const,
        };
        mocks.getTxRecords.mockResolvedValue([existing]);

        await reconstructOutgoingTxRecords(makeIndexer());

        // El monto/estado witnessed quedan intactos (una fuente débil no los
        // pisa); el peer y el fee, que faltaban, se rellenan por la regla 2.
        expect(mocks.saveTxRecord).toHaveBeenCalledExactlyOnceWith({
            ...existing,
            peer: { pk: 0xabcn, scope: 'stealth' },
            feePlanck: REAL_FEE,
        });
    });

    it('backfillea aunque la change note ya esté gastada (transfers encadenados)', async () => {
        mocks.getTxRecords.mockResolvedValue([{ hash: '0xhash-100-2' }]);
        mocks.getAll.mockReturnValue([INPUT, { ...CHANGE, spent: true }]);

        await reconstructOutgoingTxRecords(makeIndexer());

        expect(mocks.saveTxRecord).toHaveBeenCalledExactlyOnceWith(
            expect.objectContaining({ peer: { pk: 0xabcn, scope: 'stealth' } })
        );
    });

    it('record existente sin pk y change note sin counterparty → no reescribe nada', async () => {
        mocks.getTxRecords.mockResolvedValue([{ hash: '0xhash-100-2' }]);
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
                amount: { value: expectedAmount, exact: true },
                peer: null,
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
                expect(saved.amount.exact).toBe(false);
                expect(saved.feePlanck).toBeUndefined();
                // Sin fee que restar el monto es la cota superior, no una cifra inventada.
                expect(saved.amount.value).toBe(INPUT.value - CHANGE.value);
            }
        );

        it('acepta un fee serializado como número (u128 chico)', async () => {
            await reconstructOutgoingTxRecords(
                makeIndexer({}, { byHash: vi.fn().mockResolvedValue(extrinsicRow({ fee: 12345 })) })
            );

            expect(mocks.saveTxRecord).toHaveBeenCalledExactlyOnceWith(
                expect.objectContaining({
                    feePlanck: 12345n,
                    amount: { value: INPUT.value - CHANGE.value - 12345n, exact: true },
                })
            );
        });

        it('un fee resuelto NO marca el monto como aproximado', async () => {
            await reconstructOutgoingTxRecords(makeIndexer());

            const saved = mocks.saveTxRecord.mock.calls[0]![0];
            expect(saved.amount.exact).toBe(true);
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

    // ─── Recuperación de hechos públicos (targeted) ───────────────────────────

    describe('public-facts recovery', () => {
        const RECIPIENT_OUTPUT = {
            blockNumber: 100,
            extrinsicIndex: 2,
            commitmentHex: '0xc-recipient',
            leafIndex: 42,
            encryptedMemo: '0xmemo',
        };

        function makeFactsIndexer(): ReconstructDeps {
            return makeIndexer({
                outputsByExtrinsics: vi
                    .fn()
                    .mockResolvedValue([
                        RECIPIENT_OUTPUT,
                        { ...RECIPIENT_OUTPUT, commitmentHex: '0xc-change' },
                    ]),
            });
        }

        it('records the memo so a slip can be re-issued, with source: chain', async () => {
            mocks.collectOutgoingFacts.mockReturnValue({
                commitmentHex: '0xc-recipient',
                leafIndex: 42,
                encryptedMemo: '0xmemo',
            });

            await reconstructOutgoingTxRecords(makeFactsIndexer());

            const saved = mocks.saveTxRecord.mock.calls[0]![0];
            expect(saved.source).toBe('chain');
            expect(saved.note).toMatchObject({ encryptedMemo: '0xmemo' });
        });

        it('carries no amount — a sender cannot read the sealed memo', async () => {
            // The load-bearing distinction: the memo is carried for
            // forwarding, never decrypted, so nothing secret comes back with it.
            mocks.collectOutgoingFacts.mockReturnValue({
                commitmentHex: '0xc-recipient',
                leafIndex: 42,
                encryptedMemo: '0xmemo',
            });

            await reconstructOutgoingTxRecords(makeFactsIndexer());

            const saved = mocks.saveTxRecord.mock.calls[0]![0];
            expect(saved.note).not.toHaveProperty('value');
            expect(saved.note).not.toHaveProperty('recipientStealthPk');
        });

        it('only OUR extrinsics are looked up — never a blind sweep', async () => {
            const deps = makeFactsIndexer();
            await reconstructOutgoingTxRecords(deps);
            expect(deps.transfers.outputsByExtrinsics).toHaveBeenCalled();
        });
    });
});
