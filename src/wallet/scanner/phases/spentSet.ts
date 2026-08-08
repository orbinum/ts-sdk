/**
 * Spent-status resolution — decides which of the wallet's own nullifiers are
 * spent WITHOUT ever asking the server about a specific nullifier.
 *
 * This is the most important privacy property in the scanner. The obvious
 * implementation — ask the indexer "is nullifier X spent?" — tells the server
 * exactly which notes the caller owns, and it is what a re-implementation
 * reaches for by default. Instead the whole set is downloaded and intersected
 * locally, so every request the server sees is identical for every caller.
 *
 * Sealed chunks make that affordable: the manifest is universal, only missing
 * chunks are fetched, and the set persists in the injected cache. Per scan this
 * transfers roughly one chunk plus the tail rather than the entire set.
 *
 * On any hard failure the caller degrades: notes stay unspent and are
 * re-verified on the next pass.
 *
 * ## Hex casing
 *
 * The intersection is an exact string match, so both sides must agree on
 * casing. The wallet lowercases its own nullifiers before asking; the feed's
 * are lowercased HERE, on the way in. Skipping that makes an uppercase-serving
 * indexer report every spent note as unspent — the wallet then offers notes it
 * cannot spend, and each attempt dies on a duplicate nullifier. Normalising at
 * ingestion means the cache only ever holds one form, so a feed that changes
 * casing between runs cannot split one nullifier into two entries.
 */
import type { NullifierCache, SpendDetails } from '../../vault/index';
import type { NullifierManifest, NullifierSource } from '../feed/sources';
import { scanAbortError } from '../../../foundation/errors/abort';

/**
 * The casing the local cache stores and queries nullifiers in.
 *
 * Applied to everything arriving from the feed. Callers lowercase their own
 * side already; this closes the other half so the two can never disagree.
 */
function normalizeNullifierHex(hex: string): string {
    return hex.toLowerCase();
}

export interface ResolveSpentSetParams {
    source: NullifierSource;
    cache: NullifierCache;
    /** The wallet's own nullifiers, lowercase hex. */
    ownNullifiers: Set<string>;
    signal?: AbortSignal | undefined;
    onWarning?: ((message: string, cause?: unknown) => void) | undefined;
}

/**
 * Returns ONLY the spent members of `ownNullifiers` as a Map hex → spend details
 * (block timestamp + spending tx hash, each null when the row carried none).
 * Throws on network/consistency failure; the caller degrades.
 */
export async function resolveSpentSet(
    params: ResolveSpentSetParams
): Promise<Map<string, SpendDetails>> {
    const { source, cache, ownNullifiers, signal } = params;
    const throwIfAborted = () => {
        if (signal?.aborted) throw scanAbortError();
    };
    throwIfAborted();

    const manifest = await source.manifest();
    await syncNullifierCache(params, manifest, throwIfAborted);

    throwIfAborted();
    const tail = await getConsistentTail(params, throwIfAborted);
    const stored = await cache.getSpentNullifiers([...ownNullifiers]);
    const tailMap = new Map<string, SpendDetails>(
        tail.data.map((h, i) => [
            normalizeNullifierHex(h),
            { spentAt: tail.timestampsMs?.[i] ?? null, txHash: tail.txHashes?.[i] ?? null },
        ])
    );
    const spent = new Map<string, SpendDetails>();
    const unknown: SpendDetails = { spentAt: null, txHash: null };
    for (const h of ownNullifiers) {
        if (stored.has(h)) spent.set(h, stored.get(h) ?? unknown);
        else if (tailMap.has(h)) spent.set(h, tailMap.get(h) ?? unknown);
    }
    return spent;
}

/**
 * Brings the local cache up to date with the manifest: integrity check
 * (generation + stored count), then download of the missing chunks, each
 * persisted atomically together with its sync-meta update.
 */
async function syncNullifierCache(
    params: ResolveSpentSetParams,
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
    params: ResolveSpentSetParams,
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
