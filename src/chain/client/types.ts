/**
 * What a caller passes to open a connection, and what comes back from a spend.
 */
import type { PolkadotClient } from 'polkadot-api';

/** Options that apply however the chain connection is obtained. */
type OrbinumClientCommon = {
    /** HTTP URL of the EVM JSON-RPC endpoint (e.g. `"http://localhost:9933"`). Omit to disable EVM support. */
    evmRpc?: string;
    /**
     * HTTP URL of a second, independent EVM endpoint. Never used for submission —
     * only to tell a genuinely pending transaction from one stranded on `evmRpc`
     * alone, which reports as pending forever but can never mine.
     */
    evmRpcPeer?: string;
    /**
     * Base URL of a circuits-artifact mirror serving `manifest.json` and the
     * artifacts beside it. Omit for the default npm CDN (unpkg).
     *
     * Worth setting for a deployment that cannot depend on a public CDN being
     * reachable: proving needs these files, so an unreachable mirror is a wallet
     * that cannot spend.
     */
    circuitsBaseUrl?: string;
};

/**
 * Configuration passed to `OrbinumClient.connect()`.
 *
 * Either the client opens its own WebSocket (`substrateWs`), or it adopts a PAPI
 * client the application already has (`papi`). An application with its own
 * connection manager wants the second: two clients means two WebSockets and two
 * views of chain state. An adopted client is never destroyed by this one.
 */
export type OrbinumClientConfig = OrbinumClientCommon &
    (
        | {
              /** WebSocket URL of the Orbinum Substrate node (e.g. `"ws://localhost:9944"`). */
              substrateWs: string;
              papi?: never;
              /** Timeout for the initial WebSocket handshake in milliseconds. Default: `15_000`. */
              connectTimeoutMs?: number;
              substrateHttp?: never;
          }
        | {
              substrateWs?: never;
              /** An already-connected PAPI client, owned by the caller. */
              papi: PolkadotClient;
              connectTimeoutMs?: never;
              /** HTTP RPC endpoint enabling `batchRequest`. Optional. */
              substrateHttp?: string;
          }
    );

/**
 * The outcome of an extrinsic (shield, unshield, transfer, …).
 *
 * `ok` is about the DISPATCH, not the submission: a result can carry a real
 * `txHash` and `blockHash` — the extrinsic was included — while `ok` is false
 * because the pallet rejected it. A caller that only checks for a thrown error
 * will treat a failed spend as a successful one.
 */
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
