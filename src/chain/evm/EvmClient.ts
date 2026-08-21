import { hexToNumber, hexToBigint } from '../../foundation/encoding/hex';
import { postJsonWithRetry } from '../../foundation/jsonRpcHttp';

/** Internal shape of a single JSON-RPC 2.0 response. */
type JsonRpcResponse<T> = {
    jsonrpc: '2.0';
    id: number;
    result?: T;
    error?: { code: number; message: string };
};

/** Internal shape of a JSON-RPC 2.0 batch response. */
type JsonRpcBatchResponse<T> = Array<JsonRpcResponse<T>>;

/**
 * Stateless HTTP JSON-RPC client for the Orbinum EVM endpoint.
 * Follows the standard Ethereum JSON-RPC specification.
 */
export class EvmClient {
    /**
     * @param rpcUrl - HTTP URL of the EVM JSON-RPC endpoint (e.g. `"http://localhost:9933"`).
     * @param peerRpcUrl - Optional second endpoint, used only to tell a genuinely
     *   pending transaction from one stranded on `rpcUrl` alone. See `waitForReceipt`.
     */
    constructor(
        private readonly rpcUrl: string,
        private readonly peerRpcUrl?: string
    ) {}

    /**
     * Performs a single JSON-RPC call and returns the typed result.
     * Throws on HTTP errors, RPC-level errors, or a `null` result.
     */
    async request<T>(method: string, params: unknown[] = []): Promise<T> {
        const res = await postJsonWithRetry(
            this.rpcUrl,
            JSON.stringify({ id: 1, jsonrpc: '2.0', method, params })
        );
        if (!res.ok) throw new Error(`EVM HTTP ${res.status}: ${res.statusText}`);
        const json = (await res.json()) as JsonRpcResponse<T>;
        if (json.error) {
            throw new Error(`EVM RPC [${json.error.code}]: ${json.error.message}`);
        }
        if (json.result === undefined || json.result === null) {
            throw new Error(`EVM RPC returned null result for method "${method}"`);
        }
        return json.result;
    }

    /**
     * Performs multiple JSON-RPC calls in a single HTTP request (batch).
     *
     * Results come back in the order of `calls`, as a typed tuple. A call the
     * server answered with an error, or did not answer at all, lands as `null`
     * in its own slot — never shifting the ones after it.
     */
    async batchRequest<T extends unknown[]>(
        calls: Array<{ method: string; params?: unknown[] }>
    ): Promise<T> {
        const body = calls.map((c, i) => ({
            id: i + 1,
            jsonrpc: '2.0',
            method: c.method,
            params: c.params ?? [],
        }));
        const res = await postJsonWithRetry(this.rpcUrl, JSON.stringify(body));
        if (!res.ok) throw new Error(`EVM HTTP ${res.status}: ${res.statusText}`);
        const arr = (await res.json()) as JsonRpcBatchResponse<unknown>;
        // Reindexed by id, not sorted. JSON-RPC allows a server to omit a
        // response, and a parse error carries `id: null` — sorting then packs
        // the survivors together and every later result answers the wrong call,
        // silently. Same rule as `jsonRpcHttp.batchPost`.
        const byId = new Map(arr.map((r) => [r.id, r]));
        return calls.map((_, i) => byId.get(i + 1)?.result ?? null) as T;
    }

    // ─── Convenience wrappers ─────────────────────────────────────────────────

    /** Returns the native token balance (in wei) for an EVM address. */
    async getBalance(address: string): Promise<bigint> {
        const hex = await this.request<string>('eth_getBalance', [address, 'latest']);
        return hexToBigint(hex);
    }

    /** Returns the latest block number. */
    async getBlockNumber(): Promise<number> {
        const hex = await this.request<string>('eth_blockNumber', []);
        return hexToNumber(hex);
    }

    /** Returns the current chain ID. */
    async getChainId(): Promise<number> {
        const hex = await this.request<string>('eth_chainId', []);
        return hexToNumber(hex);
    }

    /** Returns the transaction count (nonce) for an EVM address. */
    async getTransactionCount(address: string): Promise<number> {
        const hex = await this.request<string>('eth_getTransactionCount', [address, 'latest']);
        return hexToNumber(hex);
    }

    /**
     * Returns the current gas price in wei, padded by `bumpPercent`.
     *
     * `eth_gasPrice` reports the base fee exactly, and the base fee moves
     * between signing and the pool's next revalidation. A transaction priced at
     * the bare minimum is evicted as `GasPriceTooLow` the moment it rises, which
     * leaves every later nonce from that account stranded in the future queue.
     * The default 25% pad absorbs the usual movement.
     */
    async getGasPrice(bumpPercent = 25): Promise<bigint> {
        const hex = await this.request<string>('eth_gasPrice', []);
        return (hexToBigint(hex) * BigInt(100 + bumpPercent)) / 100n;
    }

    /** Submits a signed raw transaction. Returns the transaction hash. */
    async sendRawTransaction(signedHex: string): Promise<string> {
        return this.request<string>('eth_sendRawTransaction', [signedHex]);
    }

    /** Executes a read-only call without creating a transaction. Returns the raw ABI-encoded response. */
    async call(to: string, data: string, from?: string): Promise<string> {
        const txObj: Record<string, string> = { to, data };
        if (from) txObj['from'] = from;
        return this.request<string>('eth_call', [txObj, 'latest']);
    }

    /**
     * Estimates a transaction's gas, in GAS UNITS — not wei. Multiply by
     * `getGasPrice()` for a cost.
     */
    async estimateGas(params: {
        from?: string;
        to: string;
        data?: string;
        value?: string;
    }): Promise<bigint> {
        const hex = await this.request<string>('eth_estimateGas', [params]);
        return hexToBigint(hex);
    }

    /** Returns a transaction receipt by hash, or `null` if the transaction has not been mined yet. */
    async getTransactionReceipt(txHash: string): Promise<Record<string, unknown> | null> {
        const res = await postJsonWithRetry(
            this.rpcUrl,
            JSON.stringify({
                id: 1,
                jsonrpc: '2.0',
                method: 'eth_getTransactionReceipt',
                params: [txHash],
            })
        );
        if (!res.ok) throw new Error(`EVM HTTP ${res.status}: ${res.statusText}`);
        const json = (await res.json()) as JsonRpcResponse<Record<string, unknown>>;
        if (json.error) {
            throw new Error(`EVM RPC [${json.error.code}]: ${json.error.message}`);
        }
        return json.result ?? null;
    }

    /**
     * Fetches a transaction by hash, or `null` when the node no longer knows it
     * (never mined and evicted from the pool). Unlike `request`, a `null`
     * result is a valid answer here, not an error.
     */
    async getTransactionByHash(txHash: string): Promise<Record<string, unknown> | null> {
        const res = await postJsonWithRetry(
            this.rpcUrl,
            JSON.stringify({
                id: 1,
                jsonrpc: '2.0',
                method: 'eth_getTransactionByHash',
                params: [txHash],
            })
        );
        if (!res.ok) throw new Error(`EVM HTTP ${res.status}: ${res.statusText}`);
        const json = (await res.json()) as JsonRpcResponse<Record<string, unknown>>;
        if (json.error) {
            throw new Error(`EVM RPC [${json.error.code}]: ${json.error.message}`);
        }
        return json.result ?? null;
    }

    /**
     * Polls `eth_getTransactionReceipt` until the transaction is included in a block.
     *
     * After `timeoutMs`, the tx-pool is consulted: a tx no longer known to the
     * node is reported as dropped (safe to retry), while a tx still in the pool
     * gets an extended grace window (up to 4× `timeoutMs`) before a "still
     * pending" error — it may confirm later, so callers must NOT blindly retry.
     *
     * @param txHash - The transaction hash to wait for.
     * @param intervalMs - Polling interval in milliseconds (default: 500).
     * @param timeoutMs - Maximum time to wait in milliseconds (default: 60_000).
     * @returns The transaction receipt once mined.
     * @throws If the transaction dropped, is still pending after the grace window, or reverted (`status == 0x0`).
     */
    async waitForReceipt(
        txHash: string,
        intervalMs = 500,
        timeoutMs = 60_000
    ): Promise<Record<string, unknown>> {
        // Hard cap: keep waiting past the soft deadline only while the pool
        // still knows the tx — bounded so a stuck tx can't hang the caller forever.
        const start = Date.now();
        const hardDeadline = start + timeoutMs * 4;
        let deadline = start + timeoutMs;
        while (Date.now() < deadline) {
            const receipt = await this.getTransactionReceipt(txHash);
            if (receipt !== null) {
                if (receipt['status'] === '0x0') {
                    // Build revert detail. Start with any reason the node put directly in the receipt.
                    let revertDetail = '';
                    const nodeReason = receipt['revertReason'] as string | undefined;
                    if (nodeReason) revertDetail = ` | revertReason: ${nodeReason}`;

                    if (!revertDetail) {
                        // Try eth_call at the same block to get the EVM revert data.
                        // `receipt['blockNumber']` is a hex number (e.g. "0x1a3f") which is the
                        // correct format for eth_call's block parameter (Frontier only accepts
                        // a hex block-number, not a block hash).
                        try {
                            const blockParam =
                                (receipt['blockNumber'] as string | undefined) ?? 'latest';
                            const rawTx = await this.getTransactionByHash(txHash).catch(() => null);
                            if (rawTx) {
                                // Frontier uses 'input' for the calldata field.
                                const calldata = (rawTx['input'] ?? rawTx['data']) as
                                    | string
                                    | undefined;
                                if (calldata) {
                                    const revertData = await this.request<string>('eth_call', [
                                        { from: rawTx['from'], to: rawTx['to'], data: calldata },
                                        blockParam,
                                    ]).catch((err: unknown) =>
                                        err instanceof Error ? err.message : String(err)
                                    );
                                    revertDetail = ` | eth_call: ${revertData}`;
                                }
                            }
                        } catch {
                            // Revert reason is best-effort — ignore failures silently.
                        }
                    }

                    throw new Error(
                        `Transaction reverted on-chain: ${txHash}${revertDetail}` +
                            ` | receipt: ${JSON.stringify(receipt)}`
                    );
                }
                return receipt;
            }
            await new Promise<void>((resolve) => setTimeout(resolve, intervalMs));

            // Soft deadline reached: decide between "dropped" (gone from the
            // pool — safe to retry) and "still pending" (extend the wait).
            if (Date.now() >= deadline && Date.now() < hardDeadline) {
                // RPC failure (undefined) must NOT read as "dropped" — a
                // transient error would tell the caller a live tx is safe to
                // retry. Only a definitive null result counts as dropped.
                const known = await this.getTransactionByHash(txHash).catch(() => undefined);
                if (known === null) {
                    throw new Error(
                        `Transaction dropped from the tx pool (not mined within ${Date.now() - start}ms): ${txHash}`
                    );
                }
                deadline = Math.min(deadline + timeoutMs, hardDeadline);
            }
        }
        // A tx only this node knows about was never gossiped — typically because
        // an earlier nonce was evicted, stranding it in the future queue where it
        // can never mine. That is a dropped tx wearing a pending tx's clothes, and
        // reporting it as pending tells the caller to wait forever.
        if (await this.isStrandedOnThisNode(txHash)) {
            throw new Error(
                `Transaction dropped from the tx pool (never propagated beyond the submitting node, ${Date.now() - start}ms): ${txHash}`
            );
        }
        throw new Error(
            `Transaction still pending after ${Date.now() - start}ms: ${txHash} — it may still confirm; check the hash on the explorer before retrying`
        );
    }

    /**
     * True when `rpcUrl` knows the transaction but the configured peer does not.
     *
     * Returns false without a peer configured, and on any peer error — an
     * unreachable peer is not evidence that a live transaction is stranded.
     */
    private async isStrandedOnThisNode(txHash: string): Promise<boolean> {
        if (!this.peerRpcUrl) return false;
        try {
            const res = await postJsonWithRetry(
                this.peerRpcUrl,
                JSON.stringify({
                    id: 1,
                    jsonrpc: '2.0',
                    method: 'eth_getTransactionByHash',
                    params: [txHash],
                })
            );
            if (!res.ok) return false;
            const json = (await res.json()) as JsonRpcResponse<unknown>;
            if (json.error) return false;
            return json.result === null;
        } catch {
            return false;
        }
    }
}
