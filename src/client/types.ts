/** Configuration passed to `OrbinumClient.connect()`. */
export type OrbinumClientConfig = {
    /** WebSocket URL of the Orbinum Substrate node (e.g. `"ws://localhost:9944"`). */
    substrateWs: string;
    /** HTTP URL of the EVM JSON-RPC endpoint (e.g. `"http://localhost:9933"`). Omit to disable EVM support. */
    evmRpc?: string;
    /** Base URL of the Orbinum indexer REST API (e.g. `"https://indexer.orbinum.io"`). Omit to disable indexer support. */
    indexerUrl?: string;
    /** Timeout for the initial WebSocket handshake in milliseconds. Default: `15_000`. */
    connectTimeoutMs?: number;
};

/** Result returned by extrinsic-submitting methods (shield, unshield, transfer, …). */
export type TxResult = {
    /** 0x-prefixed hash of the submitted extrinsic. */
    txHash: string;
    /** 0x-prefixed hash of the block that included the extrinsic. */
    blockHash: string;
    /** Number of the block that included the extrinsic. */
    blockNumber: number;
    /** `true` when the extrinsic succeeded (no `ExtrinsicFailed` event emitted). */
    ok: boolean;
    /** Dispatch error type string. Only present when `ok` is `false`. */
    error?: string;
};
