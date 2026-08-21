/**
 * Spent-status resolution — which of the wallet's own nullifiers are spent,
 * WITHOUT ever asking the server about a specific one.
 *
 * The most important privacy property in the scanner, and the one a
 * re-implementation gets wrong by default: asking "is nullifier X spent?" tells
 * the server exactly which notes the caller owns. Instead the whole set is
 * downloaded and intersected locally, so every request looks identical for
 * every caller.
 *
 * Sealed chunks make that affordable — universal manifest, only missing chunks
 * fetched, the set persisted in the injected cache — so a scan transfers about
 * one chunk plus the tail rather than the entire set.
 *
 * On any hard failure the caller degrades: notes stay unspent and are
 * re-verified next pass.
 */
import type { NullifierCache, SpendDetails } from '../../vault/index';
import type { NullifierManifest, NullifierSource } from '../feed/sources';
import { scanAbortError } from '../../../foundation/errors/abort';

/**
 * The casing the cache stores and queries nullifiers in.
 *
 * The intersection is an exact string match, so both sides must agree. Callers
 * lowercase their own; this closes the other half, at INGESTION, so the cache
 * only ever holds one form and a feed that changes casing between runs cannot
 * split one nullifier into two entries.
 *
 * Skipped, an uppercase-serving indexer reports every spent note as unspent:
 * the wallet offers notes it cannot spend and each attempt dies on a duplicate.
 */
function normalizeNullifierHex(hex: string): string {
    return hex.toLowerCase();
}

export interface OpenSpentSetParams {
    source: NullifierSource;
    cache: NullifierCache;
    signal?: AbortSignal | undefined;
    onWarning?: ((message: string, cause?: unknown) => void) | undefined;
}

export interface ResolveSpentSetParams extends OpenSpentSetParams {
    /** The wallet's own nullifiers, lowercase hex. */
    ownNullifiers: Set<string>;
}

export interface SpentSetHandle {
    /** Spent members of `ownNullifiers` (lowercase hex) → spend details. */
    query(ownNullifiers: Set<string>): Promise<Map<string, SpendDetails>>;
}

/**
 * Syncs the local nullifier cache once (chunks + a consistent tail snapshot)
 * and returns a handle for repeated LOCAL membership queries — this is what
 * lets a scan checkpoint notes with their spent status batch by batch without
 * re-fetching anything per batch. The tail is frozen at open time; spends that
 * land while the handle lives are caught by the authoritative pass at the end
 * of the scan.
 */
export async function openSpentSet(params: OpenSpentSetParams): Promise<SpentSetHandle> {
    const { source, cache, signal } = params;
    const throwIfAborted = () => {
        if (signal?.aborted) throw scanAbortError();
    };
    throwIfAborted();

    const manifest = await source.manifest();
    await syncNullifierCache(params, manifest, throwIfAborted);

    throwIfAborted();
    const tail = await getConsistentTail(params, throwIfAborted);
    const tailMap = new Map<string, SpendDetails>(
        tail.data.map((h, i) => [
            normalizeNullifierHex(h),
            { spentAt: tail.timestampsMs?.[i] ?? null, txHash: tail.txHashes?.[i] ?? null },
        ])
    );

    return {
        async query(ownNullifiers: Set<string>): Promise<Map<string, SpendDetails>> {
            if (ownNullifiers.size === 0) return new Map();
            const stored = await cache.getSpentNullifiers([...ownNullifiers]);
            const spent = new Map<string, SpendDetails>();
            const unknown: SpendDetails = { spentAt: null, txHash: null };
            for (const h of ownNullifiers) {
                if (stored.has(h)) spent.set(h, stored.get(h) ?? unknown);
                else if (tailMap.has(h)) spent.set(h, tailMap.get(h) ?? unknown);
            }
            return spent;
        },
    };
}

/**
 * Returns ONLY the spent members of `ownNullifiers` as a Map hex → spend details
 * (block timestamp + spending tx hash, each null when the row carried none).
 * Throws on network/consistency failure; the caller degrades.
 */
export async function resolveSpentSet(
    params: ResolveSpentSetParams
): Promise<Map<string, SpendDetails>> {
    const handle = await openSpentSet(params);
    return handle.query(params.ownNullifiers);
}

/**
 * Brings the local cache up to date with the manifest: integrity check
 * (generation + stored count), then download of the missing chunks, each
 * persisted atomically together with its sync-meta update.
 */
async function syncNullifierCache(
    params: OpenSpentSetParams,
    manifest: NullifierManifest,
    throwIfAborted: () => void
): Promise<void> {
    const { source, cache } = params;
    let meta = await cache.getNullifierSyncMeta();

    if (
        meta &&
        (meta.generation !== manifest.generation ||
            (await cache.countNullifiers()) !== meta.totalStored)
    ) {
        params.onWarning?.('nullifier cache reset (generation change or integrity mismatch)');
        await cache.clearNullifierCache();
        meta = null;
    }

    let chunksDone = meta?.chunksDone ?? 0;
    let totalStored = meta?.totalStored ?? 0;

    for (let i = chunksDone; i < manifest.chunks.length; i++) {
        throwIfAborted();
        const chunk = manifest.chunks[i]!;
        const body = await source.chunk(chunk.idx, chunk.digest);
        if (body.data.length !== chunk.count) {
            throw new Error(
                `nullifier chunk ${chunk.idx} incomplete: got ${body.data.length}, expected ${chunk.count}`
            );
        }
        chunksDone = i + 1;
        totalStored += body.data.length;
        // timestampsMs / txHashes are PARALLEL to data (hex-aligned), so index j
        // addresses the same nullifier in all three. Either may be absent on an
        // older feed — both degrade to null, never to a wrong pairing.
        const entries = body.data.map((h, j) => ({
            h: normalizeNullifierHex(h),
            ts: body.timestampsMs?.[j] ?? null,
            tx: body.txHashes?.[j] ?? null,
        }));
        await cache.putNullifierChunk(entries, {
            id: 'main',
            chunksDone,
            generation: manifest.generation,
            totalStored,
            updatedAt: Date.now(),
        });
    }
}

/**
 * Fetches the tail, retrying ONCE if the server sealed a chunk after the
 * manifest fetch — `afterChunks` above the local count would mean the tail skips
 * rows the cache does not hold. Still inconsistent after the retry → throw, and
 * the caller degrades until the next scan fetches a fresh manifest.
 */
async function getConsistentTail(
    params: OpenSpentSetParams,
    throwIfAborted: () => void
): Promise<Awaited<ReturnType<NullifierSource['tail']>>> {
    const { source, cache } = params;
    for (let attempt = 0; attempt < 2; attempt++) {
        throwIfAborted();
        const tail = await source.tail();
        const chunksDone = (await cache.getNullifierSyncMeta())?.chunksDone ?? 0;
        if (tail.afterChunks <= chunksDone) return tail;
        const manifest = await source.manifest();
        await syncNullifierCache(params, manifest, throwIfAborted);
    }
    throw new Error('nullifier tail inconsistent with local chunks after retry');
}
