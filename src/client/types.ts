export type OrbinumClientConfig = {
    /** WebSocket URL of the Orbinum node (e.g. "ws://localhost:9944") */
    substrateWs: string;
    /** HTTP URL of the EVM JSON-RPC endpoint (e.g. "http://localhost:9933") */
    evmRpc?: string;
    /** Base URL of the Orbinum indexer REST API (e.g. "https://indexer.orbinum.io") */
    indexerUrl?: string;
    /** Connection timeout in ms. Default: 15_000 */
    connectTimeoutMs?: number;
};

export type TxResult = {
    txHash: string;
    blockHash: string;
    blockNumber: number;
    /** Whether the extrinsic succeeded (no ExtrinsicFailed event). */
    ok: boolean;
    /** Dispatch error type string when ok = false. */
    error?: string;
};
