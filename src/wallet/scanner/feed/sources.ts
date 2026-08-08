/**
 * The feed contracts the scanner reads from.
 *
 * Three narrow interfaces instead of one client type: the SDK must not know the
 * shape of any particular indexer's REST API, only what a scan needs from a
 * feed. A host implements these over whatever backend it has — the reference
 * indexer, its own node, a static export — and the scanner works unchanged.
 *
 * The split is by privacy property, not by convenience. `NullifierSource` in
 * particular must never gain a "is this nullifier spent?" method: the whole
 * point of downloading sealed chunks is that the server never learns which
 * nullifiers the caller owns. A per-nullifier lookup would be simpler to
 * implement and would silently destroy that property, so the contract does not
 * offer one.
 */

/** One commitment as published by the feed, with whatever memo it carries. */
export interface ScanHint {
    leafIndex: number;
    commitmentHex: string;
    /** Ephemeral public key (last 32 bytes of the memo), 0x-prefixed. Null when no memo. */
    ephPkHex: string | null;
    /** The encrypted memo, 0x-prefixed hex. Null when the commitment carries none. */
    encryptedMemo: string | null;
    /** Block time of the commitment (ms). Absent when the feed does not record it. */
    timestampMs?: number | null;
    /** Hash of the tx that created the commitment. Absent when unresolvable. */
    txHash?: string | null;
}

/** One page of hints plus the totals the scanner needs to size its progress. */
export interface ScanHintPage {
    data: ScanHint[];
    pagination: {
        total: number;
        /**
         * The limit the server actually applied, which may be lower than the one
         * requested. Page math must use this: dividing by the requested size
         * against a server that clamps it undercounts pages and skips hints.
         */
        limit: number;
    };
}

/** Descriptor of one sealed chunk. The digest addresses it and proves its content. */
export interface ChunkInfo {
    idx: number;
    /** Exact number of entries in the chunk. */
    count: number;
    /** Digest of the chunk's contents — part of its URL, so a fix is a new URL. */
    digest: string;
}

/**
 * Index of the sealed scan-hint chunks. Chunks cut on exact leaf ranges: chunk
 * `i` covers leaves [i·chunkSize, (i+1)·chunkSize).
 */
export interface ScanChunkManifest {
    chunkSize: number;
    chunks: ChunkInfo[];
    /** Highest leaf covered by a sealed chunk; -1 when none are sealed. */
    lastSealedLeaf: number;
    /** Commitments on-chain (sealed + tail) — sizes scan progress. */
    total: number;
}

/**
 * Where the scanner reads commitments from.
 *
 * `chunks` is optional: a feed without a sealed-chunk path is fully served by
 * `listHints`, just with more requests. Implement it when the backend can seal,
 * since immutable digest-addressed chunks are cacheable and the paginated tail
 * is not.
 */
export interface ScanHintSource {
    listHints(params: {
        page: number;
        limit: number;
        sinceLeafIndex?: number | undefined;
    }): Promise<ScanHintPage>;

    chunks?: {
        /** Never 404s: an empty `chunks` array is the pre-first-seal state. */
        manifest(): Promise<ScanChunkManifest>;
        chunk(idx: number, digest: string): Promise<ScanHint[]>;
    };
}

/** Index of the sealed nullifier chunks. */
export interface NullifierManifest {
    /**
     * Bumped by the operator on a semantic correction. A change means the local
     * cache describes a set that no longer exists and must be rebuilt from zero.
     */
    generation: string;
    chunks: ChunkInfo[];
}

/**
 * One sealed nullifier chunk.
 *
 * `timestampsMs` and `txHashes` are PARALLEL to `data` — index `i` addresses the
 * same nullifier in all three. A feed that records neither returns them empty,
 * which degrades to null metadata; misaligning them would attribute a spend to
 * the wrong note.
 */
export interface NullifierChunkBody {
    data: string[];
    timestampsMs?: Array<number | null>;
    txHashes?: Array<string | null>;
}

/** The mutable remainder of the nullifier set, after the last sealed chunk. */
export interface NullifierTail extends NullifierChunkBody {
    /**
     * How many sealed chunks this tail starts after. When it exceeds what the
     * caller has stored, a chunk was sealed between the manifest fetch and this
     * one, and the tail skips rows the caller does not hold.
     */
    afterChunks: number;
}

/**
 * Where the scanner reads the spent set from.
 *
 * Deliberately has no per-nullifier query. The scanner downloads the set and
 * intersects locally, so the server never learns which nullifiers belong to the
 * caller. Adding a status lookup here would make ownership observable to whoever
 * serves the feed.
 */
export interface NullifierSource {
    manifest(): Promise<NullifierManifest>;
    chunk(idx: number, digest: string): Promise<NullifierChunkBody>;
    tail(): Promise<NullifierTail>;
}

/** What an extrinsic contributes to tx-history reconstruction. */
export interface ExtrinsicRecord {
    /** Decoded call arguments as JSON, keyed by the pallet's parameter names. */
    argsJson: string | null;
    /** False only when the chain reported the extrinsic as failed. */
    success?: boolean;
}

/**
 * Where the scanner reads submitted-extrinsic facts from, for reconstructing
 * outgoing transfer history. Resolving to null for an unknown hash is expected —
 * a transfer may predate indexing.
 */
export interface TxFactsSource {
    byHash(hash: string): Promise<ExtrinsicRecord | null>;
}

/** One extrinsic that touched the queried identifiers, as the feed reports it. */
export interface TransferFactsRow {
    blockNumber: number;
    extrinsicIndex: number | null;
    /** Hash of the raw extrinsic, 0x-prefixed. Null when it was not decoded. */
    hash: string | null;
    timestampMs: number | null;
    /** Subset of the QUERIED nullifiers this extrinsic spent. */
    matchedNullifiers?: string[];
    /** Subset of the QUERIED commitments this extrinsic inserted. */
    matchedCommitments?: string[];
}

/**
 * Where history reconstruction reads transfer shapes from.
 *
 * Privacy note, stated honestly: unlike `NullifierSource`, these queries DO
 * send the wallet's own identifiers to the server — that linkage is the
 * documented trade-off history reconstruction makes, and it is why this is a
 * separate contract a host can decline to implement. Spent-STATUS never goes
 * through here.
 */
export interface TransferFactsSource {
    byNullifiers(nullifiers: string[]): Promise<TransferFactsRow[]>;
    byCommitments(commitments: string[]): Promise<TransferFactsRow[]>;
}
