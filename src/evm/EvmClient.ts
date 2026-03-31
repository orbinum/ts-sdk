import { hexToNumber, hexToBigint } from '../utils/hex';

type JsonRpcResponse<T> = {
    jsonrpc: '2.0';
    id: number;
    result?: T;
    error?: { code: number; message: string };
};

type JsonRpcBatchResponse<T> = Array<JsonRpcResponse<T>>;

/**
 * Stateless HTTP JSON-RPC client for the Orbinum EVM endpoint.
 * Follows the standard Ethereum JSON-RPC specification.
 */
export class EvmClient {
    constructor(private readonly rpcUrl: string) {}

    /**
     * Performs a single JSON-RPC call.
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

    /**
     * Submits a signed raw transaction. Returns the transaction hash.
     */
    async sendRawTransaction(signedHex: string): Promise<string> {
        return this.request<string>('eth_sendRawTransaction', [signedHex]);
    }

    /**
     * Executes a read-only call without creating a transaction.
     */
    async call(to: string, data: string, from?: string): Promise<string> {
        const txObj: Record<string, string> = { to, data };
        if (from) txObj['from'] = from;
        return this.request<string>('eth_call', [txObj, 'latest']);
    }

    /**
     * Estimates the gas for a transaction.
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

    /**
     * Returns a transaction receipt by hash, or null if not yet mined.
     */
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
}
