import {
    createClient,
    Binary,
    type PolkadotClient,
    type TxFinalizedPayload,
    type PolkadotSigner,
} from 'polkadot-api';
import { getWsProvider } from 'polkadot-api/ws-provider';
import { getDynamicBuilder, getLookupFn } from '@polkadot-api/metadata-builders';
import { decAnyMetadata, unifyMetadata } from '@polkadot-api/substrate-bindings';
import { AccountId } from '@polkadot-api/substrate-bindings';
import { getExtrinsicDecoder } from '@polkadot-api/tx-utils';
import { fromHex, toHex } from '../utils/hex';
import type { ChainInfo, SystemHealth, EventRecord, RawBlockHeader, BlockInfo } from './types';
import type { RawRuntimeVersion } from './types/raw';

export type DynamicBuilder = ReturnType<typeof getDynamicBuilder>;
export type ExtrinsicDecoder = ReturnType<typeof getExtrinsicDecoder>;

/**
 * Thin wrapper over polkadot-api (PAPI) that provides:
 * - Raw JSON-RPC calls (custom Orbinum RPCs)
 * - Unsafe transaction building from call data
 * - Transaction submission with or without watching
 */
export class SubstrateClient {
    private constructor(private readonly _papi: PolkadotClient) {}

    private _dynamicBuilder: ReturnType<typeof getDynamicBuilder> | null = null;
    private _extDecoder: ExtrinsicDecoder | null = null;

    /**
     * Connects to the Orbinum node via WebSocket.
     * Throws if the node does not respond within `timeoutMs`.
     */
    static async connect(wsUrl: string, timeoutMs = 15_000): Promise<SubstrateClient> {
        const provider = getWsProvider(wsUrl);
        const papi = createClient(provider);

        await Promise.race([
            papi._request('system_name', []),
            new Promise<never>((_, reject) =>
                setTimeout(
                    () => reject(new Error(`Connection timeout (${timeoutMs}ms) to ${wsUrl}`)),
                    timeoutMs
                )
            ),
        ]);

        return new SubstrateClient(papi);
    }

    /**
     * Performs a raw JSON-RPC request. Use this for custom Orbinum RPCs
     * (shieldedPool_*, accountMapping_*, privacy_*, etc.).
     */
    async request<T>(method: string, params: unknown[] = []): Promise<T> {
        return this._papi._request<T, unknown[]>(method, params);
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

            // Fallback: extract from timestamp.set extrinsic argument
            if (!timestampMs) {
                const tsHex = extrinsics.find((hex) => {
                    try {
                        // timestamp.set is always the first extrinsic and starts with a known callIndex
                        const b = fromHex(hex as `0x${string}`);
                        // Look for the pallet byte 0x03 (timestamp) — a best-effort heuristic
                        return b.length > 6 && b[4] === 0x03 && b[5] === 0x00;
                    } catch {
                        return false;
                    }
                });
                if (tsHex) {
                    try {
                        const b = fromHex(tsHex as `0x${string}`);
                        // compact-encoded u64 starts at byte 6
                        const view = new DataView(b.buffer, b.byteOffset + 6, 8);
                        const lo = view.getUint32(0, true);
                        const hi = view.getUint32(4, true);
                        const ms = lo + hi * 0x1_0000_0000;
                        if (ms > 0) timestampMs = ms;
                    } catch {
                        /* best-effort */
                    }
                }
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
        return this._papi.getUnsafeApi().txFromCallData(Binary.fromBytes(callData));
    }

    /**
     * Submits a pre-signed extrinsic (hex string) and waits for finalization.
     */
    async submit(signedHex: string): Promise<TxFinalizedPayload> {
        return this._papi.submit(signedHex);
    }

    /**
     * Submits a pre-signed extrinsic and returns an Observable of tx lifecycle events.
     * Events: TxSigned → TxBroadcasted → TxBestBlocksState → TxFinalized
     */
    submitAndWatch(signedHex: string): ReturnType<PolkadotClient['submitAndWatch']> {
        return this._papi.submitAndWatch(signedHex);
    }

    /**
     * Convenience: wrap raw call bytes and sign+submit in one step.
     */
    async signAndSubmit(callData: Uint8Array, signer: PolkadotSigner): Promise<TxFinalizedPayload> {
        const tx = await this.txFromCallData(callData);
        return tx.signAndSubmit(signer);
    }

    /** Closes the WebSocket connection. */
    destroy(): void {
        this._papi.destroy();
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
            if (v instanceof Uint8Array) return fromHex(v as unknown as `0x${string}`).toString();
            if (typeof v === 'bigint') return v.toString();
            return String(v);
        };
        const jsonifyValue = (v: unknown): unknown => {
            if (v === null || v === undefined) return v;
            if (typeof v === 'bigint') return v.toString();
            if (v instanceof Uint8Array)
                return Array.from(v)
                    .map((b) => b.toString(16).padStart(2, '0'))
                    .join('');
            if (Array.isArray(v)) return v.map(jsonifyValue);
            if (typeof v === 'object') {
                return Object.fromEntries(
                    Object.entries(v as Record<string, unknown>)
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
