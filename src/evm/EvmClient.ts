import { hexToNumber, hexToBigint } from '../utils/hex';

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
    /** @param rpcUrl - HTTP URL of the EVM JSON-RPC endpoint (e.g. `"http://localhost:9933"`). */
    constructor(private readonly rpcUrl: string) {}

    /**
     * Performs a single JSON-RPC call and returns the typed result.
     * Throws on HTTP errors, RPC-level errors, or a `null` result.
     */
    async request<T>(method: string, params: unknown[] = []): Promise<T> {
        const res = await fetch(this.rpcUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ id: 1, jsonrpc: '2.0', method, params }),
        });
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
     * Results are returned in the same order as `calls`, as a typed tuple.
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
        const res = await fetch(this.rpcUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
        });
        if (!res.ok) throw new Error(`EVM HTTP ${res.status}: ${res.statusText}`);
        const arr = (await res.json()) as JsonRpcBatchResponse<unknown>;
        arr.sort((a, b) => (a.id ?? 0) - (b.id ?? 0));
        return arr.map((r) => r.result ?? null) as T;
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

    /** Returns the current gas price in wei. */
    async getGasPrice(): Promise<bigint> {
        const hex = await this.request<string>('eth_gasPrice', []);
        return hexToBigint(hex);
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

    /** Estimates the gas required for a transaction. Returns the estimate in wei as a `bigint`. */
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
        const res = await fetch(this.rpcUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                id: 1,
                jsonrpc: '2.0',
                method: 'eth_getTransactionReceipt',
                params: [txHash],
            }),
        });
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
     * @param txHash - The transaction hash to wait for.
     * @param intervalMs - Polling interval in milliseconds (default: 500).
     * @param timeoutMs - Maximum time to wait in milliseconds (default: 60_000).
     * @returns The transaction receipt once mined.
     * @throws If the transaction is not mined within `timeoutMs` or if it reverted (`status == 0x0`).
     */
    async waitForReceipt(
        txHash: string,
        intervalMs = 500,
        timeoutMs = 60_000
    ): Promise<Record<string, unknown>> {
        const deadline = Date.now() + timeoutMs;
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
                            const rawTx = await this.request<Record<string, unknown> | null>(
                                'eth_getTransactionByHash',
                                [txHash]
                            ).catch(() => null);
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
        }
        throw new Error(`Transaction not mined within ${timeoutMs}ms: ${txHash}`);
    }
}
