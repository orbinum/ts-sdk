import {
    createClient,
    Binary,
    type PolkadotClient,
    type TxFinalizedPayload,
    type PolkadotSigner as SubstrateSigner,
} from 'polkadot-api';
import { getWsProvider } from 'polkadot-api/ws';
import { getDynamicBuilder, getLookupFn } from '@polkadot-api/metadata-builders';
import { decAnyMetadata, unifyMetadata } from '@polkadot-api/substrate-bindings';
import { AccountId } from '@polkadot-api/substrate-bindings';
import { getExtrinsicDecoder } from '@polkadot-api/tx-utils';
import { fromHex, toHex } from '../../foundation/encoding/hex';
import { jsonRpcBatch, wsUrlToHttp, type JsonRpcCall } from '../../foundation/jsonRpcHttp';
import type { ChainInfo, SystemHealth, EventRecord, RawBlockHeader, BlockInfo } from './types';
import type { RawRuntimeVersion } from './types/raw';

/**
 * `pallet_timestamp`'s index in the runtime's `construct_runtime!`.
 *
 * Only used by the block-time fallback, which is a heuristic on raw extrinsic
 * bytes rather than a decode. A runtime that reorders its pallets makes the
 * fallback stop matching — it degrades to no timestamp, never a wrong one.
 */
const TIMESTAMP_PALLET = 0x01;

/**
 * SCALE compact integer at `offset`, or null when the bytes run out.
 *
 * Two low bits give the mode: 0 → one byte, 1 → two, 2 → four, 3 → a
 * length-prefixed big integer. Reading a compact as a raw little-endian word
 * yields a plausible wrong number rather than an error, which is why this is
 * spelled out rather than approximated.
 */
function decodeCompact(bytes: Uint8Array, offset: number): number | null {
    const first = bytes[offset];
    if (first === undefined) return null;
    const mode = first & 0b11;
    if (mode === 0) return first >>> 2;
    if (mode === 1) {
        const b1 = bytes[offset + 1];
        return b1 === undefined ? null : ((first >>> 2) | (b1 << 6)) >>> 0;
    }
    const width = mode === 2 ? 4 : (first >>> 2) + 5;
    if (offset + width > bytes.length) return null;
    let value = 0n;
    const start = mode === 2 ? offset : offset + 1;
    const end = mode === 2 ? offset + 4 : offset + width;
    for (let i = end - 1; i >= start; i--) value = (value << 8n) | BigInt(bytes[i] as number);
    if (mode === 2) value >>= 2n;
    // Milliseconds since the epoch stay far inside a double; anything larger is
    // not a block time.
    return value > BigInt(Number.MAX_SAFE_INTEGER) ? null : Number(value);
}

export type DynamicBuilder = ReturnType<typeof getDynamicBuilder>;
export type ExtrinsicDecoder = ReturnType<typeof getExtrinsicDecoder>;

/**
 * Thin wrapper over polkadot-api (PAPI) that provides:
 * - Raw JSON-RPC calls (custom Orbinum RPCs)
 * - Unsafe transaction building from call data
 * - Transaction submission with or without watching
 */
export class SubstrateClient {
    private constructor(
        private readonly _papi: PolkadotClient,
        /**
         * HTTP endpoint for `batchRequest`, derived from the WS URL. Absent when
         * the PAPI client was adopted rather than opened here — the caller's
         * transport may not be a WebSocket at all, and there is nothing to
         * derive it from.
         */
        private readonly _httpUrl: string | null,
        /**
         * Whether this instance opened the PAPI client. An adopted one belongs
         * to the caller: `destroy()` must not close a connection the rest of
         * their application is still using.
         */
        private readonly _owned: boolean
    ) {}

    private _dynamicBuilder: ReturnType<typeof getDynamicBuilder> | null = null;
    private _extDecoder: ExtrinsicDecoder | null = null;
    private _inflightTxCount = 0;

    /**
     * `true` while any submitted transaction is still waiting for finalization.
     * Connection managers use this to defer destroying the client — killing the
     * WS mid-submit rejects the pending tx with "Client destroyed" even though
     * it may still land on-chain.
     *
     * Only covers promise-based submits (`submit`, `submitUnsignedAndWatch`,
     * `signAndSubmit`); observable-based `submitAndWatch` callers are not tracked.
     */
    get hasInflightTx(): boolean {
        return this._inflightTxCount > 0;
    }

    private async trackTx<T>(p: Promise<T>): Promise<T> {
        this._inflightTxCount++;
        try {
            return await p;
        } finally {
            this._inflightTxCount--;
        }
    }

    /**
     * Connects to the Orbinum node via WebSocket.
     * Throws if the node does not respond within `timeoutMs`.
     */
    static async connect(wsUrl: string, timeoutMs = 15_000): Promise<SubstrateClient> {
        // Keep PAPI's WebSocket heartbeat active so idle connections are not dropped
        // by intermediaries (e.g. Cloudflare). A 30s heartbeat stays well below the
        // typical idle timeout and prevents unnecessary reconnects.
        const provider = getWsProvider(wsUrl, { heartbeatTimeout: 30_000 });
        const papi = createClient(provider);

        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
            await Promise.race([
                papi._request('system_name', []),
                new Promise<never>((_, reject) => {
                    timer = setTimeout(
                        () => reject(new Error(`Connection timeout (${timeoutMs}ms) to ${wsUrl}`)),
                        timeoutMs
                    );
                }),
            ]);
        } catch (err) {
            try {
                papi.destroy();
            } catch {
                /* ignore */
            }
            throw err;
        } finally {
            clearTimeout(timer);
        }

        return new SubstrateClient(papi, wsUrlToHttp(wsUrl), true);
    }

    /**
     * Wraps a PAPI client the caller already has, instead of opening one.
     *
     * An application that already talks to the chain — a dApp with its own
     * connection manager, a test harness with a mock — would otherwise end up
     * with two WebSockets and two views of chain state, since `connect()`
     * constructs its provider internally. This shares the one connection.
     *
     * The adopted client is **not** owned: `destroy()` leaves it running, because
     * the rest of the application is still using it. Closing it is the caller's
     * job, as is any reconnection policy.
     *
     * @param papi    An already-connected PAPI client.
     * @param httpUrl HTTP RPC endpoint enabling `batchRequest`. Optional — that
     *                method throws without it, and nothing else needs it.
     */
    static adopt(papi: PolkadotClient, httpUrl?: string): SubstrateClient {
        return new SubstrateClient(papi, httpUrl ?? null, false);
    }

    /**
     * Performs a raw JSON-RPC request. Use this for custom Orbinum RPCs
     * (`privacy_*`, `zkVerifier_*`, `relayer_*`, etc.).
     */
    async request<T>(method: string, params: unknown[] = []): Promise<T> {
        return this._papi._request<T, unknown[]>(method, params);
    }

    /**
     * Performs multiple JSON-RPC calls in a single HTTP request (batch). Results
     * are returned in the same order as `calls`, as a typed tuple. A `null`
     * result (or per-call error) maps to `null` in that slot — the call itself
     * only rejects on HTTP/transport failure.
     *
     * Uses the HTTP RPC endpoint (derived from the WS URL); PAPI's WS transport
     * does not expose batching. Ideal for high-throughput backfill: fetch many
     * block hashes / blocks / storage reads in one round-trip instead of N.
     */
    async batchRequest<T extends unknown[]>(calls: JsonRpcCall[]): Promise<T> {
        if (!this._httpUrl) {
            throw new Error(
                'batchRequest needs an HTTP RPC endpoint; pass one to SubstrateClient.adopt()'
            );
        }
        return jsonRpcBatch<T>(this._httpUrl, calls);
    }

    /**
     * Returns basic chain information from the node.
     * Combines `system_name`, `system_chain`, `system_properties`, and `state_getRuntimeVersion`.
     */
    async getChainInfo(): Promise<ChainInfo> {
        const [chainName, version, props] = await Promise.all([
            this.request<string>('system_chain', []),
            this.request<RawRuntimeVersion>('state_getRuntimeVersion', []),
            this.request<{ tokenSymbol?: string | string[]; tokenDecimals?: number | number[] }>(
                'system_properties',
                []
            ),
        ]);

        const rawSymbol = props.tokenSymbol;
        const rawDecimals = props.tokenDecimals;

        return {
            name: chainName,
            version: String(version.specVersion),
            ss58Prefix: version.ss58Prefix ?? 42,
            symbol: Array.isArray(rawSymbol) ? (rawSymbol[0] ?? 'ORB') : (rawSymbol ?? 'ORB'),
            decimals: Array.isArray(rawDecimals) ? (rawDecimals[0] ?? 18) : (rawDecimals ?? 18),
        };
    }

    /**
     * Returns the node's peer count and sync status.
     */
    async getHealth(): Promise<SystemHealth> {
        return this.request<SystemHealth>('system_health', []);
    }

    /**
     * Returns the node's software version string.
     */
    async getNodeVersion(): Promise<string> {
        return this.request<string>('system_version', []);
    }

    /**
     * Returns the genesis hash hex.
     */
    async getGenesisHash(): Promise<string> {
        return this.request<string>('chain_getBlockHash', [0]);
    }

    /**
     * Returns the block hash for a given block number.
     * Returns null when the block does not exist or has been pruned.
     */
    async getBlockHash(blockNumber: number): Promise<string | null> {
        const hash = await this.request<string>('chain_getBlockHash', [blockNumber]);
        if (!hash || /^0x0+$/.test(hash) || hash === '0x' + '00'.repeat(32)) return null;
        return hash;
    }

    /**
     * Fetches a block by hash or number, enriched with timestamp and block author.
     *
     * Uses `chain_getBlock` (works for all non-pruned blocks, unlike PAPI chainHead
     * which only pins recent blocks). Timestamp is read from `Timestamp.Now` storage
     * with a fallback via the `timestamp.set` extrinsic argument. Author is decoded
     * from PreRuntime digest logs using the chain's SS58 prefix.
     *
     * @param hashOrNumber - A `0x`-prefixed block hash or a block number (number or decimal string).
     * @returns `BlockInfo` or `null` if the block is not found.
     */
    async getBlock(hashOrNumber: string | number): Promise<BlockInfo | null> {
        try {
            let blockHash: string;
            if (typeof hashOrNumber === 'number' || /^\d+$/.test(String(hashOrNumber))) {
                const num =
                    typeof hashOrNumber === 'number'
                        ? hashOrNumber
                        : parseInt(hashOrNumber as string, 10);
                const h = await this.getBlockHash(num);
                if (!h) return null;
                blockHash = h;
            } else {
                blockHash = hashOrNumber as string;
            }

            const raw = await this.request<{
                block: { header: RawBlockHeader; extrinsics: string[] };
            }>('chain_getBlock', [blockHash]);
            if (!raw?.block) return null;
            const { header, extrinsics } = raw.block;

            // Resolve SS58 prefix and dynamic builder in parallel
            const builder = await this.getDynamicBuilder().catch(() => null);
            const ss58Prefix =
                (builder as unknown as { ss58Prefix?: number } | null)?.ss58Prefix ?? 42;

            // Fetch Timestamp.Now from storage
            let timestampMs: number | null = null;
            if (builder) {
                try {
                    const tsStore = builder.buildStorage('Timestamp', 'Now');
                    const tsRaw = await this.request<string | null>('state_getStorage', [
                        tsStore.keys.enc(),
                        blockHash,
                    ]);
                    if (tsRaw) {
                        timestampMs = Number(tsStore.value.dec(fromHex(tsRaw as `0x${string}`)));
                    }
                } catch {
                    /* fall through to extrinsic fallback */
                }
            }

            // Fallback: read the block time out of the `timestamp.set` call.
            //
            // An unsigned extrinsic is `Compact(len) || version || pallet ||
            // call || args`, so for this one — under 64 bytes, hence a 1-byte
            // compact prefix — the pallet index sits at b[2] and the call at
            // b[3]. The argument is a COMPACT u64, not a raw one.
            //
            // The previous version looked for 0x03 at b[4]: wrong index (3 is
            // Grandpa, Timestamp is 1), wrong offset, and it then read the
            // argument as raw little-endian. It never matched, so this fallback
            // silently did nothing.
            if (!timestampMs) {
                const ts = extrinsics.reduce<number | null>((found, hex) => {
                    if (found !== null) return found;
                    try {
                        const b = fromHex(hex as `0x${string}`);
                        if (b.length < 5 || b[2] !== TIMESTAMP_PALLET || b[3] !== 0x00) return null;
                        return decodeCompact(b, 4);
                    } catch {
                        return null;
                    }
                }, null);
                if (ts !== null && ts > 0) timestampMs = ts;
            }

            const author = SubstrateClient.extractAuthorFromLogs(header.digest.logs, ss58Prefix);

            return { header, extrinsics, timestampMs, author };
        } catch {
            return null;
        }
    }

    /**
     * Returns the underlying PolkadotClient instance.
     * Use for raw metadata access and advanced SCALE operations.
     */
    get polkadotClient(): PolkadotClient {
        return this._papi;
    }

    /**
     * Observable that emits a new entry each time a best-block is reported by the node.
     * Delegates to PAPI's `blocks$`.
     */
    get blocks$(): PolkadotClient['blocks$'] {
        return this._papi.blocks$;
    }

    /**
     * Returns the block header for a given tag or block hash.
     * Delegates to PAPI's `getBlockHeader`.
     */
    getBlockHeader(
        ...args: Parameters<PolkadotClient['getBlockHeader']>
    ): ReturnType<PolkadotClient['getBlockHeader']> {
        return this._papi.getBlockHeader(...args);
    }

    /**
     * Returns the PAPI UnsafeApi for dynamic, metadata-driven transaction building.
     * The first access triggers a metadata fetch from the node.
     *
     * Usage:
     * ```ts
     * const tx = client.unsafe.tx.shieldedPool.shield(...);
     * const result = await tx.signAndSubmit(signer);
     * ```
     */
    get unsafe() {
        return this._papi.getUnsafeApi();
    }

    /**
     * Wraps pre-built SCALE call bytes (from protocol-core TransactionBuilder)
     * into a PAPI UnsafeTransaction that can be signed and submitted.
     */
    async txFromCallData(callData: Uint8Array) {
        return this._papi.getUnsafeApi().txFromCallData(callData);
    }

    /**
     * Submits a pre-signed extrinsic (hex string) and waits for finalization.
     */
    async submit(signedHex: string): Promise<TxFinalizedPayload> {
        return this.trackTx(this._papi.submit(Binary.fromHex(signedHex)));
    }

    /**
     * Submits a pre-signed extrinsic and returns an Observable of tx lifecycle events.
     * Events: TxSigned → TxBroadcasted → TxBestBlocksState → TxFinalized
     */
    submitAndWatch(signedHex: string): ReturnType<PolkadotClient['submitAndWatch']> {
        return this._papi.submitAndWatch(Binary.fromHex(signedHex));
    }

    /**
     * Submits a bare (unsigned) extrinsic and waits for finalization.
     * Used for gasless private_transfer and unshield transactions.
     * The bare tx bytes are produced by `tx.getBareTx()` from polkadot-api.
     */
    async submitUnsignedAndWatch(bareTx: Uint8Array): Promise<TxFinalizedPayload> {
        return this.trackTx(this._papi.submit(bareTx));
    }

    /**
     * Convenience: wrap raw call bytes and sign+submit in one step.
     */
    async signAndSubmit(
        callData: Uint8Array,
        signer: SubstrateSigner
    ): Promise<TxFinalizedPayload> {
        const tx = await this.txFromCallData(callData);
        return this.trackTx(tx.signAndSubmit(signer));
    }

    /**
     * Closes the connection — but only if this instance opened it.
     *
     * A client passed to `adopt()` belongs to the caller and is left running:
     * tearing down a connection the rest of their application depends on would
     * be a surprising side effect of disposing an SDK object.
     */
    destroy(): void {
        if (this._owned) this._papi.destroy();
    }

    /**
     * Fetches and decodes all events for a given block hash.
     * Queries `System.Events` storage via SCALE codec built from on-chain metadata.
     *
     * @param blockHash - The `0x`-prefixed block hash string.
     * @returns Array of `EventRecord` or `null` if unavailable.
     */
    async queryBlockEvents(blockHash: string): Promise<EventRecord[] | null> {
        try {
            const builder = await this.getDynamicBuilder();
            const { keys, value } = builder.buildStorage('System', 'Events');
            const raw = await this.request<string | null>('state_getStorage', [
                keys.enc(),
                blockHash,
            ]);
            if (!raw) return null;
            const decoded = value.dec(fromHex(raw as `0x${string}`));
            return SubstrateClient._toEventRecords(decoded as unknown[]);
        } catch {
            return null;
        }
    }

    // ─── Internal helpers ─────────────────────────────────────────────────────

    async getDynamicBuilder(): Promise<ReturnType<typeof getDynamicBuilder>> {
        if (this._dynamicBuilder) return this._dynamicBuilder;
        const rawMetadata = await this._papi.getMetadata('best');
        const metadata = decAnyMetadata(rawMetadata);
        const unified = unifyMetadata(metadata);
        const lookup = getLookupFn(unified);
        this._dynamicBuilder = getDynamicBuilder(lookup);
        return this._dynamicBuilder;
    }

    async getExtrinsicDecoder(): Promise<ExtrinsicDecoder> {
        if (this._extDecoder) return this._extDecoder;
        const rawMetadata = await this._papi.getMetadata('best');
        this._extDecoder = getExtrinsicDecoder(rawMetadata);
        return this._extDecoder;
    }

    private static _buildDataProxy(value: unknown): EventRecord['event']['data'] {
        const formatValue = (v: unknown): string => {
            if (v instanceof Uint8Array) return toHex(v);
            if (typeof v === 'bigint') return v.toString();
            return String(v);
        };
        const jsonifyValue = (v: unknown): unknown => {
            if (v === null || v === undefined) return v;
            if (typeof v === 'bigint') return v.toString();
            if (v instanceof Uint8Array) return toHex(v);
            if (Array.isArray(v)) return v.map(jsonifyValue);
            if (typeof v === 'object') {
                const obj = v as Record<string, unknown>;
                // Handle polkadot-api Binary type and similar objects with asHex()
                if (typeof obj['asHex'] === 'function') {
                    try {
                        return (obj['asHex'] as () => string)();
                    } catch {
                        /* fall through to generic handling */
                    }
                }
                return Object.fromEntries(
                    Object.entries(obj)
                        .filter(([, val]) => typeof val !== 'function')
                        .map(([k, val]) => [k, jsonifyValue(val)])
                );
            }
            return v;
        };

        const entries: unknown[] = Array.isArray(value)
            ? value
            : value !== null && typeof value === 'object'
              ? Object.values(value as object)
              : [value];

        const items = entries.map((v) => ({
            toString: () => formatValue(v),
            toJSON: () => jsonifyValue(v),
            toHuman: () => jsonifyValue(v),
            ...(v !== null && typeof v === 'object' ? (v as object) : {}),
        }));

        return Object.assign(items as unknown as EventRecord['event']['data'], {
            toJSON: () => jsonifyValue(value),
            toHuman: () => jsonifyValue(value),
        });
    }

    /**
     * Extracts the block author (validator/collator) from raw digest log hex strings.
     * Looks for a PreRuntime log (tag byte = 6) and decodes the first 32 bytes of the
     * SCALE-compact payload as an SS58 address using the given prefix.
     *
     * Can be used standalone with raw logs from `chain_getBlock` responses.
     */
    static extractAuthorFromLogs(logs: string[], ss58Prefix: number): string | null {
        try {
            for (const hex of logs) {
                const bytes = fromHex(hex as `0x${string}`);
                if (bytes.length < 6 || bytes[0] !== 6) continue; // 6 = PreRuntime
                const firstLenByte = bytes[5] as number;
                const mode = firstLenByte & 0b11;
                let payloadStart: number;
                let payloadLen: number;
                if (mode === 0) {
                    payloadLen = firstLenByte >> 2;
                    payloadStart = 6;
                } else if (mode === 1) {
                    if (bytes.length < 7) continue;
                    payloadLen = (firstLenByte >> 2) | ((bytes[6] as number) << 6);
                    payloadStart = 7;
                } else if (mode === 2) {
                    if (bytes.length < 9) continue;
                    payloadLen =
                        ((firstLenByte >> 2) |
                            ((bytes[6] as number) << 6) |
                            ((bytes[7] as number) << 14) |
                            ((bytes[8] as number) << 22)) >>>
                        0;
                    payloadStart = 9;
                } else {
                    continue;
                }
                const payload = bytes.slice(payloadStart, payloadStart + payloadLen);
                if (payload.length >= 32) {
                    try {
                        return AccountId(ss58Prefix).dec(payload.slice(0, 32));
                    } catch {
                        return toHex(payload.slice(0, 32));
                    }
                }
            }
        } catch {
            /* digest may be empty or malformed */
        }
        return null;
    }

    private static _toEventRecords(decoded: unknown[]): EventRecord[] {
        return decoded.flatMap((e) => {
            try {
                const raw = e as {
                    phase: { type: string; value?: number };
                    event: { type: string; value: { type: string; value: unknown } };
                };
                const isApply = raw.phase.type === 'ApplyExtrinsic';
                const extIdx = isApply ? (raw.phase.value as number) : 0;
                const section = raw.event.type.charAt(0).toLowerCase() + raw.event.type.slice(1);
                const method = raw.event.value.type;

                const record: EventRecord = {
                    phase: {
                        isApplyExtrinsic: isApply,
                        asApplyExtrinsic: {
                            eq: (n: number) => n === extIdx,
                            toString: () => String(extIdx),
                            toNumber: () => extIdx,
                        },
                    },
                    event: {
                        section,
                        method,
                        data: SubstrateClient._buildDataProxy(raw.event.value.value),
                    },
                };
                return [record];
            } catch {
                return [];
            }
        });
    }
}
