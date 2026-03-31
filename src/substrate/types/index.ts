export type ChainInfo = {
    name: string;
    version: string;
    ss58Prefix: number;
    symbol: string;
    decimals: number;
};

export type SystemHealth = {
    peers: number;
    isSyncing: boolean;
    shouldHavePeers: boolean;
};

export interface EventPhase {
    isApplyExtrinsic: boolean;
    asApplyExtrinsic: {
        eq(n: number): boolean;
        toString(): string;
        toNumber(): number;
    };
}

export interface EventData extends ArrayLike<{
    toString(): string;
    toJSON(): unknown;
    toHuman(): unknown;
}> {
    toJSON(): unknown;
    toHuman(): unknown;
}

export interface EventRecord {
    phase: EventPhase;
    event: {
        section: string;
        method: string;
        data: EventData;
    };
}

/** Raw block header as returned by the chain_getBlock JSON-RPC call. */
export interface RawBlockHeader {
    parentHash: string;
    /** Hex-encoded block number, e.g. "0x1a2b". */
    number: string;
    stateRoot: string;
    extrinsicsRoot: string;
    digest: { logs: string[] };
}

/** Raw block body returned by chain_getBlock. */
export interface RawBlock {
    header: RawBlockHeader;
    /** SCALE-encoded extrinsics as 0x-hex strings. */
    extrinsics: string[];
}

/**
 * Enriched block info returned by `SubstrateClient.getBlock()`.
 * Timestamp is extracted from `Timestamp.Now` storage (with a fallback via `timestamp.set` arg).
 * Author is decoded from PreRuntime digest logs using the chain's SS58 prefix.
 */
export interface BlockInfo {
    header: RawBlockHeader;
    extrinsics: string[];
    /** Unix timestamp in milliseconds, or null if not determinable. */
    timestampMs: number | null;
    /** SS58-encoded block author, or null if not present in digest logs. */
    author: string | null;
}
