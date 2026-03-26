import {
    createClient,
    Binary,
    type PolkadotClient,
    type TxFinalizedPayload,
    type PolkadotSigner,
} from 'polkadot-api';
import { getWsProvider } from 'polkadot-api/ws-provider';

/**
 * Thin wrapper over polkadot-api (PAPI) that provides:
 * - Raw JSON-RPC calls (custom Orbinum RPCs)
 * - Unsafe transaction building from call data
 * - Transaction submission with or without watching
 */
export class SubstrateClient {
    private constructor(private readonly _papi: PolkadotClient) {}

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
     * Returns the underlying PolkadotClient instance.
     * Use for block subscriptions (`blocks$`), raw metadata access, and advanced SCALE operations.
     */
    get polkadotClient(): PolkadotClient {
        return this._papi;
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
}
