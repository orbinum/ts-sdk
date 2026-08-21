/**
 * collectScanEntries — feed walking, the bounded on-chain set, and the transport
 * choice between sealed chunks and pagination.
 *
 * `onChainHexes` must stay bounded by the WALLET, not by the pool. It used to
 * hold one hex string per hint in the window; a 1M-note scan peaked at 895 MB
 * RSS because of it, which extrapolates to ~9 GB at 10M. Every consumer only
 * ever probes the set with a commitment the vault already holds, so keeping the
 * rest bought nothing.
 *
 * The ghost purge reads the set INVERTED — absence means "gone from chain,
 * delete it" — so proving a confirmed note is always present matters as much as
 * proving pool commitments are excluded.
 */
import { describe, it, expect, vi } from 'vitest';
import { collectScanEntries } from '../../../../src/wallet/scanner/phases/collect';
import type { ScanHint, ScanHintSource } from '../../../../src/wallet/scanner/feed/sources';
import type { DecryptPool } from '../../../../src/index';
import type { ScanKeys, DecryptBatchResult } from '../../../../src/index';
import type { ZkNote } from '../../../../src/protocol/types';

// Una clave de visión de 32 bytes, como la que deriva un wallet real. Un
// valor más corto se cuela sin error —`getKnownEphWindow` se traga el fallo y
// devuelve «descubrimiento apagado»—, así que todo este archivo pasaría a
// probar una configuración que producción no produce nunca.
const KEYS: ScanKeys = {
    viewingKey: new Uint8Array(32).fill(1),
    spendingKey: 2n,
    ownerPk: 3n,
};

const EMPTY_COUNTS = {
    tagFiltered: 0,
    selfMatched: 0,
    pairwiseMatched: 0,
    maxSelfEphIndex: null,
    maxOutgoingEphIndex: null,
    sentNotes: [],
    learnedRecipients: [],
    unmatchedSent: [],
    sealedBookEntries: [],
};

/**
 * A pool that decrypts via `decrypt`, defaulting to "nothing is ours". Injected
 * rather than mocked at module level, which is the point of the pool being a
 * constructor parameter.
 */
function fakePool(decrypt: (hint: ScanHint) => ZkNote | null = () => null): DecryptPool {
    return {
        async decryptBatch(
            hints: ScanHint[],
            _keys: ScanKeys,
            signal?: AbortSignal
        ): Promise<DecryptBatchResult> {
            if (signal?.aborted) {
                const err = new Error('aborted');
                err.name = 'AbortError';
                throw err;
            }
            return { notes: hints.map((h) => decrypt(h)), ...EMPTY_COUNTS };
        },
        terminate() {},
    } as unknown as DecryptPool;
}

const hintAt = (i: number): ScanHint => ({
    leafIndex: i,
    commitmentHex: `0xc${i}`,
    ephPkHex: `0xe${i}`,
    encryptedMemo: `0xm${i}`,
    timestampMs: null,
    txHash: null,
});

/** A source serving `size` hints, paginated, with no sealed chunks. */
function pagedSource(size: number): ScanHintSource {
    const data = Array.from({ length: size }, (_, i) => hintAt(i));
    return {
        // Real pagination: the scan pages past 2500 hints, and serving the same
        // slice twice would double-count `scanned` and hide the property here.
        async listHints({ page, limit }) {
            return {
                data: data.slice((page - 1) * limit, page * limit),
                pagination: { limit, total: size },
            };
        },
    };
}

const run = (
    params: Partial<Parameters<typeof collectScanEntries>[0]> & { source: ScanHintSource }
) =>
    collectScanEntries({
        pool: fakePool(),
        keys: KEYS,
        existingHexes: new Set<string>(),
        ...params,
    });

describe('onChainHexes stays wallet-sized', () => {
    it('ignores pool commitments the wallet does not hold', async () => {
        const outcome = await run({ source: pagedSource(500), vaultHexes: new Set<string>() });

        expect(outcome.scanned).toBe(500);
        // The old behaviour would leave 500 here — one per hint in the window.
        expect(outcome.onChainHexes.size).toBe(0);
    });

    it('records exactly the vault notes the window confirmed', async () => {
        // Two are in the window (0xc3, 0xc7); the third never appears on-chain.
        const vaultHexes = new Set(['0xc3', '0xc7', '0xcNOTONCHAIN']);

        const outcome = await run({
            source: pagedSource(10),
            existingHexes: new Set(vaultHexes),
            vaultHexes,
        });

        expect([...outcome.onChainHexes].sort()).toEqual(['0xc3', '0xc7']);
        // Absent → the purge treats it as a ghost, which is the point.
        expect(outcome.onChainHexes.has('0xcNOTONCHAIN')).toBe(false);
    });

    it('scales with the vault, not the pool', async () => {
        const vaultHexes = new Set(['0xc1', '0xc2']);
        const args = { existingHexes: new Set(vaultHexes), vaultHexes };

        const small = await run({ source: pagedSource(100), ...args });
        const large = await run({ source: pagedSource(5000), ...args });

        // 50× the pool, same set size — that is the whole property.
        expect(large.scanned).toBe(50 * small.scanned);
        expect(large.onChainHexes.size).toBe(small.onChainHexes.size);
        expect(large.onChainHexes.size).toBe(2);
    });

    it('falls back to the existing-notes set when no filter is given', async () => {
        // Omitting the filter must not silently start hoarding the pool again.
        const outcome = await run({ source: pagedSource(300), existingHexes: new Set(['0xc5']) });

        expect(outcome.onChainHexes.size).toBe(1);
        expect(outcome.onChainHexes.has('0xc5')).toBe(true);
    });

    it('records a recovered note as on-chain', async () => {
        // A note decrypted during the scan is on-chain by definition; the vault
        // filter must not hide it from the reconciliation phases.
        const vaultHexes = new Set(['0xc2']);
        const outcome = await collectScanEntries({
            source: pagedSource(20),
            pool: fakePool((h) =>
                h.commitmentHex === '0xc2' ? ({ commitmentHex: '0xc2', value: 5n } as ZkNote) : null
            ),
            keys: KEYS,
            existingHexes: new Set(vaultHexes),
            vaultHexes,
        });

        expect(outcome.onChainHexes.has('0xc2')).toBe(true);
    });
});

describe('collectScanEntries — note filtering', () => {
    it('drops zero-value notes', async () => {
        // The change output of an exact-amount transfer. The transfer circuit
        // treats a value-0 input as a dummy and forces its nullifier to 0, so
        // storing one would only confuse the balance and break a proof.
        const outcome = await collectScanEntries({
            source: pagedSource(3),
            pool: fakePool((h) => ({ commitmentHex: h.commitmentHex, value: 0n }) as ZkNote),
            keys: KEYS,
            existingHexes: new Set<string>(),
        });

        expect(outcome.scanEntries).toEqual([]);
        expect(outcome.found).toBe(0);
    });

    it('counts hints without a memo as noMemo and never decrypts them', async () => {
        // The MEMO is the only thing a hint cannot be decrypted without. A
        // missing `ephPkHex` is NOT disqualifying: the field is nullable by
        // contract and the kernel reads the ephemeral from the memo's last 32
        // bytes instead. Skipping those hints here made a feed that omits the
        // field yield zero notes and a clean-looking scan.
        const source: ScanHintSource = {
            async listHints() {
                return {
                    data: [
                        { ...hintAt(0), encryptedMemo: null },
                        { ...hintAt(1), ephPkHex: null },
                        hintAt(2),
                    ],
                    pagination: { limit: 100, total: 3 },
                };
            },
        };
        const decrypt = vi.fn(() => null);

        const outcome = await collectScanEntries({
            source,
            pool: fakePool(decrypt),
            keys: KEYS,
            existingHexes: new Set<string>(),
        });

        expect(outcome.noMemo).toBe(1);
        expect(outcome.scanned).toBe(3);
        // Both memo-carrying hints reach the kernel, ephPkHex or not.
        expect(decrypt).toHaveBeenCalledTimes(2);
    });

    it('separates new notes from ones the vault already holds', async () => {
        const outcome = await collectScanEntries({
            source: pagedSource(3),
            pool: fakePool((h) => ({ commitmentHex: h.commitmentHex, value: 7n }) as ZkNote),
            keys: KEYS,
            existingHexes: new Set(['0xc1']),
        });

        expect(outcome.found).toBe(2);
        expect(outcome.alreadyPresent).toBe(1);
        expect(outcome.scanEntries.map((e) => e.isNew)).toEqual([true, false, true]);
    });
});

describe('collectScanEntries — sealed chunks', () => {
    /** A source with sealed chunks of `chunkSize`, plus an (empty) paginated tail. */
    function chunkedSource(total: number, chunkSize: number, tail: ScanHint[] = []) {
        const chunks = Array.from({ length: Math.ceil(total / chunkSize) }, (_, i) => ({
            idx: i,
            count: chunkSize,
            digest: `d${i}`,
        }));
        const fetched: number[] = [];
        const source: ScanHintSource = {
            async listHints({ limit }) {
                return { data: tail, pagination: { limit, total: tail.length } };
            },
            chunks: {
                async manifest() {
                    return {
                        chunkSize,
                        chunks,
                        lastSealedLeaf: total - 1,
                        total: total + tail.length,
                    };
                },
                async chunk(idx) {
                    fetched.push(idx);
                    return Array.from({ length: chunkSize }, (_, j) => hintAt(idx * chunkSize + j));
                },
            },
        };
        return { source, fetched };
    }

    it('reads the sealed bulk from chunks and the remainder from the tail', async () => {
        const { source } = chunkedSource(20, 10, [hintAt(20), hintAt(21)]);

        const outcome = await run({ source });

        expect(outcome.scanned).toBe(22);
        expect(outcome.maxLeafIndex).toBe(21);
    });

    it('skips chunks entirely below the incremental cursor', async () => {
        const { source, fetched } = chunkedSource(30, 10);

        await run({ source, sinceLeafIndex: 20 });

        // Chunks 0 and 1 cover leaves 0-19, all already scanned.
        expect(fetched).toEqual([2]);
    });

    it('drops already-scanned leaves from a chunk straddling the cursor', async () => {
        const { source } = chunkedSource(20, 10);

        const outcome = await run({ source, sinceLeafIndex: 15 });

        // Chunk 1 covers 10-19; only 15-19 are new.
        expect(outcome.scanned).toBe(5);
    });

    it('falls back to pagination when the chunk path breaks mid-way', async () => {
        const { source } = chunkedSource(20, 10, [hintAt(20)]);
        const warnings: string[] = [];
        source.chunks!.chunk = vi
            .fn()
            .mockResolvedValueOnce([hintAt(0), hintAt(1)])
            .mockRejectedValue(new Error('reseal race'));

        const outcome = await run({ source, onWarning: (m) => warnings.push(m) });

        // Chunk 0's hints survive, and paging resumes after the last leaf seen.
        expect(outcome.scanned).toBe(3);
        expect(warnings[0]).toContain('sealed-chunk path failed');
    });

    it('pages the whole window when the source has no chunk support', async () => {
        const outcome = await run({ source: pagedSource(7) });

        expect(outcome.scanned).toBe(7);
    });
});

describe('collectScanEntries — pagination correctness', () => {
    it('uses the limit the server applied, not the one requested', async () => {
        // A server that clamps the requested limit must not make the page math
        // undercount pages, which would silently skip hints.
        const SERVER_LIMIT = 5;
        const TOTAL = 12;
        const data = Array.from({ length: TOTAL }, (_, i) => hintAt(i));
        const source: ScanHintSource = {
            async listHints({ page }) {
                return {
                    data: data.slice((page - 1) * SERVER_LIMIT, page * SERVER_LIMIT),
                    pagination: { limit: SERVER_LIMIT, total: TOTAL },
                };
            },
        };

        const outcome = await run({ source });

        expect(outcome.scanned).toBe(TOTAL);
    });
});

describe('collectScanEntries — abort', () => {
    it('does not process a prefetched page after an abort', async () => {
        // Pages are fetched ahead of processing, so an abort must be checked
        // before each page is handed to the pool — a page already in memory is
        // exactly the one that would slip through.
        const SERVER_LIMIT = 2;
        const TOTAL = 6;
        const data = Array.from({ length: TOTAL }, (_, i) => hintAt(i));
        const controller = new AbortController();
        const source: ScanHintSource = {
            async listHints({ page }) {
                return {
                    data: data.slice((page - 1) * SERVER_LIMIT, page * SERVER_LIMIT),
                    pagination: { limit: SERVER_LIMIT, total: TOTAL },
                };
            },
        };
        const seen: string[] = [];

        await expect(
            collectScanEntries({
                source,
                pool: fakePool((h) => {
                    seen.push(h.commitmentHex);
                    controller.abort(); // abort while page 1 is being processed
                    return null;
                }),
                keys: KEYS,
                existingHexes: new Set<string>(),
                signal: controller.signal,
            })
        ).rejects.toMatchObject({ name: 'AbortError' });

        // Only page 1's hints were ever decrypted, though pages 2-3 were fetched.
        expect(seen).toEqual(['0xc0', '0xc1']);
    });

    it('already-aborted signal → immediate AbortError, no requests', async () => {
        const source = pagedSource(10);
        const listHints = vi.spyOn(source, 'listHints');
        const controller = new AbortController();
        controller.abort();

        await expect(run({ source, signal: controller.signal })).rejects.toMatchObject({
            name: 'AbortError',
        });
        expect(listHints).not.toHaveBeenCalled();
    });

    it('abort mid-scan propagates out of the pool', async () => {
        const controller = new AbortController();
        const source: ScanHintSource = {
            async listHints({ limit }) {
                controller.abort();
                return { data: [hintAt(0)], pagination: { limit, total: 1 } };
            },
        };

        await expect(run({ source, signal: controller.signal })).rejects.toMatchObject({
            name: 'AbortError',
        });
    });
});

/**
 * `maxLeafIndex` becomes the PERSISTED scan cursor, and it comes straight from
 * the feed. A hostile or broken indexer serving `Infinity` — or `NaN`, which
 * compares false against everything — poisons that cursor, and every later
 * incremental scan resumes past the end of the tree: no hint clears
 * `leafIndex >= startLeaf`, so the wallet silently stops finding notes with no
 * error anywhere.
 */
describe('collectScanEntries — hostile leaf indexes', () => {
    const withLeafIndex = (leafIndex: unknown): ScanHintSource => ({
        async listHints() {
            return {
                data: [{ ...hintAt(0), leafIndex } as ScanHint],
                pagination: { limit: 2500, total: 1 },
            };
        },
    });

    it.each([
        ['Infinity', Infinity],
        ['-Infinity', -Infinity],
        ['NaN', NaN],
        ['above u32', 2 ** 32],
        ['negative', -5],
        ['fractional', 1.5],
    ])('SECURITY: never advances the cursor to %s', async (_label, leafIndex) => {
        const outcome = await run({ source: withLeafIndex(leafIndex) });

        expect(outcome.maxLeafIndex).toBeUndefined();
    });

    it('still counts a hint whose leaf index it rejected', () => {
        // Dropping the index must not drop the hint: its commitment may still
        // be one of ours, and the scan's totals have to stay honest.
        return run({ source: withLeafIndex(Infinity) }).then((outcome) => {
            expect(outcome.scanned).toBe(1);
        });
    });

    it('takes the highest VALID index when poisoned ones are mixed in', async () => {
        const source: ScanHintSource = {
            async listHints() {
                return {
                    data: [
                        { ...hintAt(10), leafIndex: 10 },
                        { ...hintAt(1), leafIndex: Infinity } as ScanHint,
                        { ...hintAt(42), leafIndex: 42 },
                    ],
                    pagination: { limit: 2500, total: 3 },
                };
            },
        };

        const outcome = await run({ source });

        expect(outcome.maxLeafIndex).toBe(42);
    });

    it('accepts the largest legitimate leaf index', async () => {
        // The guard must not reject a real tree position near the u32 ceiling.
        const outcome = await run({ source: withLeafIndex(2 ** 32 - 1) });

        expect(outcome.maxLeafIndex).toBe(2 ** 32 - 1);
    });
});

/**
 * El orden estricto bajo la ventana de prefetch.
 *
 * `runPrefetched` mantiene hasta PREFETCH descargas en vuelo pero entrega los
 * lotes ESTRICTAMENTE en orden. El cursor depende de ello: los checkpoints
 * persisten las notas de un lote antes de avanzar, así que un lote fuera de
 * turno guardaría notas de una página posterior con el cursor aún atrás.
 *
 * Se mide con `onProgress`, que reporta el acumulado tras CADA lote: una
 * entrega desordenada procesa la misma página dos veces y se salta otra, y el
 * total acumulado deja de cuadrar con el número de hints únicos servidos.
 */
describe('el prefetch no reordena', () => {
    /**
     * Una fuente donde una página INTERMEDIA tarda de verdad.
     *
     * La primera no sirve: se pide antes de entrar en el prefetch y llega ya
     * resuelta. La página 2 sí compite con la 3, que es donde se vería.
     */
    function slowMiddlePageSource(size: number): ScanHintSource {
        const data = Array.from({ length: size }, (_, i) => hintAt(i));
        return {
            async listHints({ page, limit: lim }) {
                // Un macrotask, no un microtask: `await Promise.resolve()` no
                // deja que otra descarga se adelante.
                if (page === 2) await new Promise((r) => setTimeout(r, 20));
                return {
                    data: data.slice((page - 1) * lim, page * lim),
                    pagination: { limit: lim, total: size },
                };
            },
        };
    }

    it('escanea cada hint exactamente una vez, sin repetir ni saltarse una página', async () => {
        const outcome = await run({ source: slowMiddlePageSource(7500) });

        // 3 páginas de 2500. Reordenar entrega una dos veces y omite otra: el
        // total sigue siendo 7500, pero `onChainHexes` pierde una página entera.
        expect(outcome.scanned).toBe(7500);
        expect(outcome.maxLeafIndex).toBe(7499);
    });

    it('y el conjunto on-chain cubre las tres páginas, no dos', async () => {
        const vaultHexes = new Set(Array.from({ length: 7500 }, (_, i) => `0xc${i}`));

        const outcome = await run({
            source: slowMiddlePageSource(7500),
            existingHexes: new Set(vaultHexes),
            vaultHexes,
        });

        expect(outcome.onChainHexes.size).toBe(7500);
    });
});
