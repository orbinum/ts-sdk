/**
 * resolveSpentSet — the PIR-A spent-status resolution, exercised directly:
 * chunk sync, integrity resets and tail-consistency retry.
 *
 * The cache is a real MemoryVaultStorage rather than a mock, so these tests also
 * exercise the atomicity the NullifierCache contract requires — a chunk and the
 * sync-meta it produced must land together.
 */
import { vi, describe, it, expect, beforeEach } from 'vitest';
import { resolveSpentSet } from '../../../../src/wallet/scanner/phases/spentSet';
import { MemoryVaultStorage } from '../../../../src/index';
import type { NullifierSource } from '../../../../src/wallet/scanner/feed/sources';

interface SourceMock {
    manifest: ReturnType<typeof vi.fn>;
    chunk: ReturnType<typeof vi.fn>;
    tail: ReturnType<typeof vi.fn>;
}

const manifest = (
    chunks: Array<{ idx: number; count: number; digest: string }>,
    generation = '1'
) => ({ generation, chunks });

/** Chunk body: hexes + hex-aligned timestamps and tx hashes (default null). */
const chunkBody = (
    hexes: string[],
    ts: Array<number | null> = [],
    tx: Array<string | null> = []
) => ({
    data: hexes,
    timestampsMs: hexes.map((_, i) => ts[i] ?? null),
    txHashes: hexes.map((_, i) => tx[i] ?? null),
});

const tailBody = (
    afterChunks: number,
    hexes: string[] = [],
    ts: Array<number | null> = [],
    tx: Array<string | null> = []
) => ({
    afterChunks,
    data: hexes,
    timestampsMs: hexes.map((_, i) => ts[i] ?? null),
    txHashes: hexes.map((_, i) => tx[i] ?? null),
});

/** Mirrors resolveSpentSet's output shape. */
const spend = (spentAt: number | null, txHash: string | null = null) => ({ spentAt, txHash });

function makeSource(overrides: Partial<SourceMock> = {}): SourceMock {
    return {
        // Default: an empty manifest (the endpoint always returns one, never 404s).
        manifest: vi.fn().mockResolvedValue(manifest([])),
        chunk: vi.fn(),
        tail: vi.fn().mockResolvedValue(tailBody(0)),
        ...overrides,
    };
}

const asSource = (s: SourceMock) => s as unknown as NullifierSource;

const OWN = new Set(['0xmine1', '0xmine2']);

let cache: MemoryVaultStorage;

beforeEach(() => {
    vi.clearAllMocks();
    cache = new MemoryVaultStorage();
});

const resolve = (source: SourceMock, signal?: AbortSignal) =>
    resolveSpentSet({ source: asSource(source), cache, ownNullifiers: OWN, signal });

/** Pre-seeds the cache as a previous sync would have left it. */
async function seed(
    entries: Array<{ h: string; ts?: number | null; tx?: string | null }>,
    meta: { chunksDone: number; generation: string; totalStored: number }
) {
    await cache.putNullifierChunk(
        entries.map((e) => ({ h: e.h, ts: e.ts ?? null, tx: e.tx ?? null })),
        { id: 'main', updatedAt: 0, ...meta }
    );
}

describe('resolveSpentSet — cache failure throws (caller degrades)', () => {
    it('local cache failure (put throws) → throws, no fallback', async () => {
        vi.spyOn(cache, 'putNullifierChunk').mockRejectedValue(new Error('quota exceeded'));
        const source = makeSource({
            manifest: vi.fn().mockResolvedValue(manifest([{ idx: 0, count: 1, digest: 'd0' }])),
            chunk: vi.fn().mockResolvedValue(chunkBody(['0xmine1'])),
        });

        await expect(resolve(source)).rejects.toThrow('quota exceeded');
    });

    it('short chunk (lagging replica) → not persisted, throws', async () => {
        const put = vi.spyOn(cache, 'putNullifierChunk');
        const source = makeSource({
            manifest: vi.fn().mockResolvedValue(manifest([{ idx: 0, count: 2, digest: 'd0' }])),
            chunk: vi.fn().mockResolvedValue(chunkBody(['0xonly-one'])), // 1 ≠ count 2
        });

        await expect(resolve(source)).rejects.toThrow('incomplete');
        expect(put).not.toHaveBeenCalled();
    });
});

describe('resolveSpentSet — chunk sync', () => {
    it('first sync: downloads missing chunks and resolves membership from the cache', async () => {
        const source = makeSource({
            manifest: vi.fn().mockResolvedValue(
                manifest([
                    { idx: 0, count: 2, digest: 'd0' },
                    { idx: 1, count: 1, digest: 'd1' },
                ])
            ),
            chunk: vi
                .fn()
                .mockResolvedValueOnce(chunkBody(['0xa', '0xmine1'], [1000, 2000]))
                .mockResolvedValueOnce(chunkBody(['0xb'])),
            tail: vi.fn().mockResolvedValue(tailBody(2, ['0xmine2'], [3000])),
        });

        const spent = await resolve(source);

        // mine1 from the cache (chunk) with its timestamp, mine2 from the tail.
        expect(spent).toEqual(
            new Map([
                ['0xmine1', spend(2000)],
                ['0xmine2', spend(3000)],
            ])
        );
        expect(source.chunk).toHaveBeenNthCalledWith(1, 0, 'd0');
        expect(source.chunk).toHaveBeenNthCalledWith(2, 1, 'd1');
        expect(await cache.getNullifierSyncMeta()).toMatchObject({
            chunksDone: 2,
            generation: '1',
            totalStored: 3,
        });
    });

    it('cache up to date: no chunk downloads, tail only', async () => {
        await seed([{ h: '0xa' }], { chunksDone: 1, generation: '1', totalStored: 1 });
        const source = makeSource({
            manifest: vi.fn().mockResolvedValue(manifest([{ idx: 0, count: 1, digest: 'd0' }])),
            tail: vi.fn().mockResolvedValue(tailBody(1)),
        });

        await resolve(source);

        expect(source.chunk).not.toHaveBeenCalled();
    });

    it('generation changed → clear + resync from zero', async () => {
        await seed([{ h: '0xa' }, { h: '0xb' }], {
            chunksDone: 2,
            generation: '1',
            totalStored: 2,
        });
        const clear = vi.spyOn(cache, 'clearNullifierCache');
        const source = makeSource({
            manifest: vi
                .fn()
                .mockResolvedValue(manifest([{ idx: 0, count: 1, digest: 'dA' }], '2')),
            chunk: vi.fn().mockResolvedValue(chunkBody(['0xnew'])),
            tail: vi.fn().mockResolvedValue(tailBody(1)),
        });

        await resolve(source);

        expect(clear).toHaveBeenCalledOnce();
        expect(await cache.getNullifierSyncMeta()).toMatchObject({
            chunksDone: 1,
            generation: '2',
            totalStored: 1,
        });
    });

    it('broken integrity (stored count != totalStored) → clear + resync', async () => {
        // totalStored claims 5 but only one entry survived (partial eviction).
        await seed([{ h: '0xa' }], { chunksDone: 1, generation: '1', totalStored: 5 });
        const clear = vi.spyOn(cache, 'clearNullifierCache');
        const source = makeSource({
            manifest: vi.fn().mockResolvedValue(manifest([{ idx: 0, count: 1, digest: 'd0' }])),
            chunk: vi.fn().mockResolvedValue(chunkBody(['0xa'])),
            tail: vi.fn().mockResolvedValue(tailBody(1)),
        });

        await resolve(source);

        expect(clear).toHaveBeenCalledOnce();
        expect(source.chunk).toHaveBeenCalledOnce();
    });
});

describe('resolveSpentSet — tail', () => {
    it('afterChunks > chunksDone (chunk sealed mid-sync) → refetch manifest + retry', async () => {
        const source = makeSource({
            manifest: vi
                .fn()
                .mockResolvedValueOnce(manifest([{ idx: 0, count: 1, digest: 'd0' }]))
                .mockResolvedValueOnce(
                    manifest([
                        { idx: 0, count: 1, digest: 'd0' },
                        { idx: 1, count: 1, digest: 'd1' },
                    ])
                ),
            chunk: vi
                .fn()
                .mockResolvedValueOnce(chunkBody(['0xa']))
                .mockResolvedValueOnce(chunkBody(['0xmine1'], [7000])),
            tail: vi.fn().mockResolvedValueOnce(tailBody(2)).mockResolvedValueOnce(tailBody(2)),
        });

        const spent = await resolve(source);

        expect(source.tail).toHaveBeenCalledTimes(2);
        expect(spent).toEqual(new Map([['0xmine1', spend(7000)]])); // arrived in the retry's chunk 1
    });

    it('tail still inconsistent after the retry → throws (caller degrades)', async () => {
        const source = makeSource({
            manifest: vi.fn().mockResolvedValue(manifest([{ idx: 0, count: 1, digest: 'd0' }])),
            chunk: vi.fn().mockResolvedValue(chunkBody(['0xa'])),
            // The server insists on afterChunks=5 but the manifest holds one chunk.
            tail: vi.fn().mockResolvedValue(tailBody(5)),
        });

        await expect(resolve(source)).rejects.toThrow('tail inconsistent');
    });

    it('afterChunks < chunksDone (stale cached tail) → accepted (union, no gap)', async () => {
        await seed([{ h: '0xa' }, { h: '0xmine1', ts: 4000 }], {
            chunksDone: 2,
            generation: '1',
            totalStored: 2,
        });
        const source = makeSource({
            manifest: vi.fn().mockResolvedValue(
                manifest([
                    { idx: 0, count: 1, digest: 'd0' },
                    { idx: 1, count: 1, digest: 'd1' },
                ])
            ),
            tail: vi.fn().mockResolvedValue(tailBody(1, ['0xa'])),
        });

        expect(await resolve(source)).toEqual(new Map([['0xmine1', spend(4000)]]));
    });
});

describe('resolveSpentSet — abort', () => {
    it('already-aborted signal → immediate AbortError, no requests', async () => {
        const controller = new AbortController();
        controller.abort();
        const source = makeSource();

        await expect(resolve(source, controller.signal)).rejects.toMatchObject({
            name: 'AbortError',
        });
        expect(source.manifest).not.toHaveBeenCalled();
    });
});

describe('resolveSpentSet — privacy contract', () => {
    /**
     * The scanner must never ask the server about a specific nullifier: that
     * would tell whoever serves the feed exactly which notes the caller owns.
     * Every request here must be identical regardless of what OWN contains.
     */
    it('makes the same requests whatever the wallet owns', async () => {
        const calls = (own: Set<string>) => {
            const source = makeSource({
                manifest: vi.fn().mockResolvedValue(manifest([{ idx: 0, count: 1, digest: 'd0' }])),
                chunk: vi.fn().mockResolvedValue(chunkBody(['0xa'])),
                tail: vi.fn().mockResolvedValue(tailBody(1)),
            });
            return {
                source,
                run: () =>
                    resolveSpentSet({
                        source: asSource(source),
                        cache: new MemoryVaultStorage(),
                        ownNullifiers: own,
                    }),
            };
        };

        const a = calls(new Set(['0xmine1']));
        await a.run();
        const b = calls(new Set(['0xtotally', '0xdifferent', '0xnullifiers']));
        await b.run();

        expect(b.source.manifest.mock.calls).toEqual(a.source.manifest.mock.calls);
        expect(b.source.chunk.mock.calls).toEqual(a.source.chunk.mock.calls);
        expect(b.source.tail.mock.calls).toEqual(a.source.tail.mock.calls);
    });
});

/**
 * The intersection is an exact string match, so both sides must agree on hex
 * casing. Callers lowercase their own nullifiers already; the feed's are
 * lowercased at ingestion.
 *
 * Getting this wrong is not a cosmetic miss. A lookup that fails reports a
 * SPENT note as unspent — the wallet keeps offering it, and every attempt to
 * spend it dies on a duplicate nullifier. A feed serving uppercase hex, or one
 * that changes casing between runs, is all it takes.
 */
describe('nullifier hex casing', () => {
    const OWN = '0xabcdef';

    const feed = (over: Partial<NullifierSource> = {}): NullifierSource => ({
        manifest: async () => ({ generation: 'g1', chunks: [] }),
        chunk: async () => ({ data: [] }),
        tail: async () => ({ data: [], afterChunks: 0 }),
        ...over,
    });

    it('SECURITY: matches an uppercase nullifier served in the tail', async () => {
        const spent = await resolveSpentSet({
            source: feed({
                tail: async () => ({
                    data: ['0xABCDEF'],
                    timestampsMs: [111],
                    txHashes: ['0xtx'],
                    afterChunks: 0,
                }),
            }),
            cache: new MemoryVaultStorage(),
            ownNullifiers: new Set([OWN]),
        });

        expect(spent.get(OWN)).toEqual({ spentAt: 111, txHash: '0xtx' });
    });

    it('SECURITY: matches an uppercase nullifier served in a sealed chunk', async () => {
        // The chunk path persists to the cache, so a mismatch here survives
        // across scans until the generation changes.
        const spent = await resolveSpentSet({
            source: feed({
                manifest: async () => ({
                    generation: 'g1',
                    chunks: [{ idx: 0, count: 1, digest: 'd0' }],
                }),
                chunk: async () => ({
                    data: ['0xABCDEF'],
                    timestampsMs: [222],
                    txHashes: ['0xtx2'],
                }),
                tail: async () => ({ data: [], afterChunks: 1 }),
            }),
            cache: new MemoryVaultStorage(),
            ownNullifiers: new Set([OWN]),
        });

        expect(spent.get(OWN)).toEqual({ spentAt: 222, txHash: '0xtx2' });
    });

    it('stores one entry when the feed changes casing between runs', async () => {
        // Two spellings of the same nullifier must not become two rows: the
        // second would be counted as a new nullifier and skew `totalStored`.
        const cache = new MemoryVaultStorage();
        const chunkFeed = (hex: string): NullifierSource =>
            feed({
                manifest: async () => ({
                    generation: 'g1',
                    chunks: [{ idx: 0, count: 1, digest: 'd0' }],
                }),
                chunk: async () => ({ data: [hex] }),
                tail: async () => ({ data: [], afterChunks: 1 }),
            });

        await resolveSpentSet({
            source: chunkFeed('0xABCDEF'),
            cache,
            ownNullifiers: new Set([OWN]),
        });

        expect(await cache.countNullifiers()).toBe(1);
        expect((await cache.getSpentNullifiers([OWN])).has(OWN)).toBe(true);
    });

    it('still matches a feed that already serves lowercase', async () => {
        const spent = await resolveSpentSet({
            source: feed({
                tail: async () => ({ data: [OWN], afterChunks: 0 }),
            }),
            cache: new MemoryVaultStorage(),
            ownNullifiers: new Set([OWN]),
        });

        expect(spent.has(OWN)).toBe(true);
    });
});
