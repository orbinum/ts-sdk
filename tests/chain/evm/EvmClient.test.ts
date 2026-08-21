import { describe, it, expect, vi, afterEach } from 'vitest';
import { EvmClient } from '../../../src/chain/evm/EvmClient';

// ─── fetch mock helpers ───────────────────────────────────────────────────────

function mockFetchOk(result: unknown): void {
    vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue({
            ok: true,
            json: async () => ({ jsonrpc: '2.0', id: 1, result }),
        })
    );
}

function mockFetchError(status: number, statusText: string): void {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status, statusText }));
}

function mockFetchRpcError(code: number, message: string): void {
    vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue({
            ok: true,
            json: async () => ({ jsonrpc: '2.0', id: 1, error: { code, message } }),
        })
    );
}

afterEach(() => {
    vi.unstubAllGlobals();
});

// ─── EvmClient.getChainId ─────────────────────────────────────────────────────

describe('EvmClient.getChainId', () => {
    it('parses hex response to number', async () => {
        mockFetchOk('0x15');
        expect(await new EvmClient('http://localhost').getChainId()).toBe(21);
    });

    it('calls eth_chainId method', async () => {
        mockFetchOk('0x1');
        await new EvmClient('http://localhost').getChainId();
        const body = JSON.parse((vi.mocked(fetch).mock.calls[0]?.[1]?.body ?? '') as string) as {
            method: string;
        };
        expect(body.method).toBe('eth_chainId');
    });
});

// ─── EvmClient.getBalance ─────────────────────────────────────────────────────

describe('EvmClient.getBalance', () => {
    it('returns a bigint', async () => {
        mockFetchOk('0xde0b6b3a7640000'); // 1 ETH in wei
        const balance = await new EvmClient('http://localhost').getBalance('0xabc');
        expect(typeof balance).toBe('bigint');
        expect(balance).toBe(1_000_000_000_000_000_000n);
    });

    it('handles zero balance', async () => {
        mockFetchOk('0x0');
        expect(await new EvmClient('http://localhost').getBalance('0xabc')).toBe(0n);
    });
});

// ─── EvmClient.getBlockNumber ─────────────────────────────────────────────────

describe('EvmClient.getBlockNumber', () => {
    it('parses hex block number to number', async () => {
        mockFetchOk('0x64'); // 100
        expect(await new EvmClient('http://localhost').getBlockNumber()).toBe(100);
    });
});

// ─── EvmClient.getTransactionCount ───────────────────────────────────────────

describe('EvmClient.getTransactionCount', () => {
    it('parses nonce to number', async () => {
        mockFetchOk('0x5'); // nonce = 5
        expect(await new EvmClient('http://localhost').getTransactionCount('0xabc')).toBe(5);
    });
});

// ─── EvmClient.getGasPrice ────────────────────────────────────────────────────

describe('EvmClient.getGasPrice', () => {
    it('pads the reported price so a rising base fee does not evict the tx', async () => {
        mockFetchOk('0x3b9aca00'); // 1 Gwei
        expect(await new EvmClient('http://localhost').getGasPrice()).toBe(1_250_000_000n);
    });

    it('returns the raw price as bigint with the pad disabled', async () => {
        mockFetchOk('0x3b9aca00');
        expect(await new EvmClient('http://localhost').getGasPrice(0)).toBe(1_000_000_000n);
    });
});

// ─── EvmClient.sendRawTransaction ─────────────────────────────────────────────

describe('EvmClient.sendRawTransaction', () => {
    it('returns the transaction hash', async () => {
        const txHash = '0xdeadbeef01234567';
        mockFetchOk(txHash);
        expect(await new EvmClient('http://localhost').sendRawTransaction('0xsignedtx')).toBe(
            txHash
        );
    });
});

// ─── EvmClient.batchRequest ───────────────────────────────────────────────────

describe('EvmClient.batchRequest', () => {
    it('sends all calls in a single request and returns ordered results', async () => {
        vi.stubGlobal(
            'fetch',
            vi.fn().mockResolvedValue({
                ok: true,
                json: async () => [
                    { jsonrpc: '2.0', id: 2, result: '0x64' },
                    { jsonrpc: '2.0', id: 1, result: '0x15' },
                ],
            })
        );

        const client = new EvmClient('http://localhost');
        const [chainId, blockNumber] = await client.batchRequest<[string, string]>([
            { method: 'eth_chainId' },
            { method: 'eth_blockNumber' },
        ]);

        // Reindexed by id, so id=1 (chainId) answers the first call however the
        // server ordered the array.
        expect(chainId).toBe('0x15');
        expect(blockNumber).toBe('0x64');
    });

    /**
     * Una respuesta que falta NO puede desplazar a las demás.
     *
     * JSON-RPC permite al servidor omitir una respuesta, y un error de parseo
     * llega con `id: null`. Ordenando el array, los supervivientes se empaquetan
     * juntos y cada resultado posterior contesta a OTRA llamada — sin error, con
     * valores bien formados atribuidos al método equivocado.
     */
    it('una respuesta OMITIDA deja null en su hueco, no desplaza', async () => {
        vi.stubGlobal(
            'fetch',
            vi.fn().mockResolvedValue({
                ok: true,
                json: async () => [
                    { jsonrpc: '2.0', id: 1, result: '0x15' },
                    // id 2 no viene
                    { jsonrpc: '2.0', id: 3, result: '0xdead' },
                ],
            })
        );

        const client = new EvmClient('http://localhost');
        const [a, b, c] = await client.batchRequest<[string, string, string]>([
            { method: 'eth_chainId' },
            { method: 'eth_blockNumber' },
            { method: 'eth_gasPrice' },
        ]);

        expect(a).toBe('0x15');
        expect(b).toBeNull();
        expect(c).toBe('0xdead');
    });

    it('un `id: null` no se cuela como el primer resultado', async () => {
        // Un error de parseo del servidor llega sin id. Con `?? 0` ordenaría
        // ANTES que todo y se leería como la respuesta a la primera llamada.
        vi.stubGlobal(
            'fetch',
            vi.fn().mockResolvedValue({
                ok: true,
                json: async () => [
                    { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } },
                    { jsonrpc: '2.0', id: 1, result: '0x15' },
                ],
            })
        );

        const client = new EvmClient('http://localhost');
        const [first] = await client.batchRequest<[string]>([{ method: 'eth_chainId' }]);

        expect(first).toBe('0x15');
    });
});

// ─── Error handling ───────────────────────────────────────────────────────────

describe('EvmClient error handling', () => {
    it('throws on non-OK HTTP response', async () => {
        mockFetchError(500, 'Internal Server Error');
        await expect(new EvmClient('http://localhost').getChainId()).rejects.toThrow(
            'EVM HTTP 500'
        );
    });

    it('throws on JSON-RPC error response', async () => {
        mockFetchRpcError(-32602, 'invalid params');
        await expect(new EvmClient('http://localhost').getChainId()).rejects.toThrow(
            'EVM RPC [-32602]: invalid params'
        );
    });

    it('throws when result is null', async () => {
        vi.stubGlobal(
            'fetch',
            vi.fn().mockResolvedValue({
                ok: true,
                json: async () => ({ jsonrpc: '2.0', id: 1, result: null }),
            })
        );
        await expect(new EvmClient('http://localhost').getChainId()).rejects.toThrow(
            'EVM RPC returned null result'
        );
    });

    it('sends the request to the configured URL', async () => {
        mockFetchOk('0x1');
        const url = 'http://my-node:9933';
        await new EvmClient(url).getChainId();
        expect(vi.mocked(fetch).mock.calls[0]?.[0]).toBe(url);
    });

    it('sets Content-Type header to application/json', async () => {
        mockFetchOk('0x1');
        await new EvmClient('http://localhost').getChainId();
        const headers = vi.mocked(fetch).mock.calls[0]?.[1]?.headers as Record<string, string>;
        expect(headers?.['Content-Type']).toBe('application/json');
    });
});

// ─── EvmClient.call ───────────────────────────────────────────────────────────

describe('EvmClient.call', () => {
    it('returns the hex result from eth_call', async () => {
        mockFetchOk('0xdeadbeef');
        const result = await new EvmClient('http://localhost').call('0xto', '0xdata');
        expect(result).toBe('0xdeadbeef');
    });

    it('includes from field when provided', async () => {
        mockFetchOk('0x0');
        await new EvmClient('http://localhost').call('0xto', '0xdata', '0xfrom');
        const body = JSON.parse((vi.mocked(fetch).mock.calls[0]?.[1]?.body ?? '') as string) as {
            params: [{ to: string; data: string; from?: string }, string];
        };
        expect(body.params[0].from).toBe('0xfrom');
    });

    it('omits from field when not provided', async () => {
        mockFetchOk('0x0');
        await new EvmClient('http://localhost').call('0xto', '0xdata');
        const body = JSON.parse((vi.mocked(fetch).mock.calls[0]?.[1]?.body ?? '') as string) as {
            params: [{ to: string; data: string; from?: string }, string];
        };
        expect(body.params[0].from).toBeUndefined();
    });

    it('issues eth_call with latest block tag', async () => {
        mockFetchOk('0x0');
        await new EvmClient('http://localhost').call('0xto', '0xdata');
        const body = JSON.parse((vi.mocked(fetch).mock.calls[0]?.[1]?.body ?? '') as string) as {
            method: string;
            params: unknown[];
        };
        expect(body.method).toBe('eth_call');
        expect(body.params[1]).toBe('latest');
    });
});

// ─── EvmClient.estimateGas ────────────────────────────────────────────────────

describe('EvmClient.estimateGas', () => {
    it('returns estimated gas as bigint', async () => {
        mockFetchOk('0x5208'); // 21000 — standard transfer gas
        const gas = await new EvmClient('http://localhost').estimateGas({ to: '0xto' });
        expect(gas).toBe(21_000n);
    });

    it('passes params object to eth_estimateGas', async () => {
        mockFetchOk('0x5208');
        const params = { from: '0xfrom', to: '0xto', data: '0xdata', value: '0x1' };
        await new EvmClient('http://localhost').estimateGas(params);
        const body = JSON.parse((vi.mocked(fetch).mock.calls[0]?.[1]?.body ?? '') as string) as {
            method: string;
            params: unknown[];
        };
        expect(body.method).toBe('eth_estimateGas');
        expect(body.params[0]).toEqual(params);
    });
});

// ─── EvmClient.getTransactionReceipt ─────────────────────────────────────────

describe('EvmClient.getTransactionReceipt', () => {
    it('returns the receipt object when found', async () => {
        const receipt = {
            transactionHash: '0xabc',
            blockNumber: '0x1',
            status: '0x1',
        };
        vi.stubGlobal(
            'fetch',
            vi.fn().mockResolvedValue({
                ok: true,
                json: async () => ({ jsonrpc: '2.0', id: 1, result: receipt }),
            })
        );
        const result = await new EvmClient('http://localhost').getTransactionReceipt('0xabc');
        expect(result).toEqual(receipt);
    });

    it('issues eth_getTransactionReceipt with the tx hash', async () => {
        vi.stubGlobal(
            'fetch',
            vi.fn().mockResolvedValue({
                ok: true,
                json: async () => ({ jsonrpc: '2.0', id: 1, result: { status: '0x1' } }),
            })
        );
        await new EvmClient('http://localhost').getTransactionReceipt('0xhash');
        const body = JSON.parse((vi.mocked(fetch).mock.calls[0]?.[1]?.body ?? '') as string) as {
            method: string;
            params: string[];
        };
        expect(body.method).toBe('eth_getTransactionReceipt');
        expect(body.params[0]).toBe('0xhash');
    });

    it('returns null for a pending transaction (result is null)', async () => {
        vi.stubGlobal(
            'fetch',
            vi.fn().mockResolvedValue({
                ok: true,
                json: async () => ({ jsonrpc: '2.0', id: 1, result: null }),
            })
        );
        const result = await new EvmClient('http://localhost').getTransactionReceipt('0xpending');
        expect(result).toBeNull();
    });
});

// ─── Rate-limit retry (429/503) ───────────────────────────────────────────────

describe('EvmClient rate-limit retry', () => {
    afterEach(() => {
        vi.useRealTimers();
    });

    function rateLimited(status: number) {
        return {
            ok: false,
            status,
            statusText: 'rate limited',
            headers: { get: () => null },
        };
    }

    it('request retries a 429 then returns the result', async () => {
        vi.useFakeTimers();
        const f = vi
            .fn()
            .mockResolvedValueOnce(rateLimited(429))
            .mockResolvedValueOnce({
                ok: true,
                json: async () => ({ jsonrpc: '2.0', id: 1, result: '0x15' }),
            });
        vi.stubGlobal('fetch', f);

        const p = new EvmClient('http://localhost').request<string>('eth_chainId');
        await vi.runAllTimersAsync();
        expect(await p).toBe('0x15');
        expect(f).toHaveBeenCalledTimes(2);
    });

    it('request gives up after exhausting retries and throws', async () => {
        vi.useFakeTimers();
        const f = vi.fn().mockResolvedValue(rateLimited(429));
        vi.stubGlobal('fetch', f);

        const p = new EvmClient('http://localhost').request('eth_chainId');
        const assertion = expect(p).rejects.toThrow(/429/);
        await vi.runAllTimersAsync();
        await assertion;
        expect(f).toHaveBeenCalledTimes(6); // initial + 5 retries (default)
    });

    it('batchRequest retries a 503 then succeeds', async () => {
        vi.useFakeTimers();
        const f = vi
            .fn()
            .mockResolvedValueOnce(rateLimited(503))
            .mockResolvedValueOnce({
                ok: true,
                json: async () => [{ jsonrpc: '2.0', id: 1, result: 'a' }],
            });
        vi.stubGlobal('fetch', f);

        const p = new EvmClient('http://localhost').batchRequest([{ method: 'm' }]);
        await vi.runAllTimersAsync();
        expect(await p).toEqual(['a']);
        expect(f).toHaveBeenCalledTimes(2);
    });

    it('getTransactionReceipt retries a 429 then succeeds', async () => {
        vi.useFakeTimers();
        const f = vi
            .fn()
            .mockResolvedValueOnce(rateLimited(429))
            .mockResolvedValueOnce({
                ok: true,
                json: async () => ({ jsonrpc: '2.0', id: 1, result: { status: '0x1' } }),
            });
        vi.stubGlobal('fetch', f);

        const p = new EvmClient('http://localhost').getTransactionReceipt('0xabc');
        await vi.runAllTimersAsync();
        expect(await p).toEqual({ status: '0x1' });
        expect(f).toHaveBeenCalledTimes(2);
    });

    it('does not retry a non-retryable HTTP error', async () => {
        mockFetchError(500, 'Internal Server Error');
        await expect(new EvmClient('http://localhost').request('eth_chainId')).rejects.toThrow(
            /500/
        );
        expect(vi.mocked(fetch)).toHaveBeenCalledTimes(1);
    });
});

// ─── EvmClient.waitForReceipt — timeout semantics ─────────────────────────────

describe('EvmClient.waitForReceipt timeout handling', () => {
    /** Routes fetch by JSON-RPC method; each handler returns the `result` value. */
    function mockFetchByMethod(handlers: Record<string, () => unknown>): void {
        vi.stubGlobal(
            'fetch',
            vi.fn().mockImplementation(async (_url: string, init: { body: string }) => {
                const { method } = JSON.parse(init.body) as { method: string };
                const handler = handlers[method];
                return {
                    ok: true,
                    json: async () => ({
                        jsonrpc: '2.0',
                        id: 1,
                        result: handler ? handler() : null,
                    }),
                };
            })
        );
    }

    afterEach(() => {
        vi.useRealTimers();
    });

    it('throws "dropped" when the pool no longer knows the tx after the soft timeout', async () => {
        vi.useFakeTimers();
        mockFetchByMethod({
            eth_getTransactionReceipt: () => null,
            eth_getTransactionByHash: () => null,
        });

        const p = new EvmClient('http://localhost').waitForReceipt('0xabc', 100, 1_000).then(
            () => null,
            (e: Error) => e
        );
        await vi.advanceTimersByTimeAsync(1_500);
        const err = await p;
        expect(err?.message).toMatch(/dropped from the tx pool/);
    });

    it('keeps waiting past the soft timeout while the pool knows the tx, and resolves when mined late', async () => {
        vi.useFakeTimers();
        let receiptPolls = 0;
        mockFetchByMethod({
            // Mine the tx well after the soft timeout (10 polls ≈ 1s at 100ms).
            eth_getTransactionReceipt: () =>
                ++receiptPolls > 15
                    ? { status: '0x1', blockHash: '0x1', blockNumber: '0x2' }
                    : null,
            eth_getTransactionByHash: () => ({ hash: '0xabc' }),
        });

        const p = new EvmClient('http://localhost').waitForReceipt('0xabc', 100, 1_000);
        await vi.advanceTimersByTimeAsync(4_000);
        const receipt = await p;
        expect(receipt['status']).toBe('0x1');
    });

    it('throws "still pending" at the hard cap when the tx never leaves the pool', async () => {
        vi.useFakeTimers();
        mockFetchByMethod({
            eth_getTransactionReceipt: () => null,
            eth_getTransactionByHash: () => ({ hash: '0xabc' }),
        });

        const p = new EvmClient('http://localhost').waitForReceipt('0xabc', 100, 1_000).then(
            () => null,
            (e: Error) => e
        );
        await vi.advanceTimersByTimeAsync(5_000);
        const err = await p;
        expect(err?.message).toMatch(/still pending after \d+ms/);
        expect(err?.message).toMatch(/check the hash/);
    });

    it('treats a pool-check RPC failure as still-pending, never as dropped', async () => {
        vi.useFakeTimers();
        vi.stubGlobal(
            'fetch',
            vi.fn().mockImplementation(async (_url: string, init: { body: string }) => {
                const { method } = JSON.parse(init.body) as { method: string };
                if (method === 'eth_getTransactionByHash') {
                    return { ok: false, status: 500, statusText: 'boom' };
                }
                return { ok: true, json: async () => ({ jsonrpc: '2.0', id: 1, result: null }) };
            })
        );

        const p = new EvmClient('http://localhost').waitForReceipt('0xabc', 100, 1_000).then(
            () => null,
            (e: Error) => e
        );
        await vi.advanceTimersByTimeAsync(5_000);
        const err = await p;
        // A transient RPC error must not report "dropped" (which invites a retry
        // and a potential double-spend) — it falls through to "still pending".
        expect(err?.message).toMatch(/still pending/);
        expect(err?.message).not.toMatch(/dropped/);
    });
});

// ─── EvmClient.waitForReceipt — stranded-tx detection ─────────────────────────

/**
 * The node always knows the tx and never mines it; `peerSees` decides whether a
 * second endpoint has heard of it, and `peerOk` whether that endpoint answers.
 */
function mockStrandedScenario(peerSees: boolean, peerOk = true): void {
    vi.stubGlobal(
        'fetch',
        vi.fn().mockImplementation(async (url: string, init: { body: string }) => {
            const { method } = JSON.parse(init.body) as { method: string };
            if (url === 'http://peer') {
                if (!peerOk) return { ok: false, status: 500, statusText: 'boom' };
                return {
                    ok: true,
                    json: async () => ({
                        jsonrpc: '2.0',
                        id: 1,
                        result: peerSees ? { hash: '0xabc' } : null,
                    }),
                };
            }
            return {
                ok: true,
                json: async () => ({
                    jsonrpc: '2.0',
                    id: 1,
                    result: method === 'eth_getTransactionByHash' ? { hash: '0xabc' } : null,
                }),
            };
        })
    );
}

describe('EvmClient.waitForReceipt stranded-tx detection', () => {
    async function runToHardCap(client: EvmClient): Promise<Error | null> {
        const p = client.waitForReceipt('0xabc', 100, 1_000).then(
            () => null,
            (e: Error) => e
        );
        await vi.advanceTimersByTimeAsync(5_000);
        return p;
    }

    it('reports a tx no peer can see as dropped, not pending', async () => {
        vi.useFakeTimers();
        mockStrandedScenario(false);
        const err = await runToHardCap(new EvmClient('http://node', 'http://peer'));
        // Stranded behind an evicted nonce: it can never mine, so the caller
        // must be told to retry rather than wait.
        expect(err?.message).toMatch(/never propagated/);
        expect(err?.message).toMatch(/dropped from the tx pool/);
    });

    it('keeps reporting pending when the peer also sees the tx', async () => {
        vi.useFakeTimers();
        mockStrandedScenario(true);
        const err = await runToHardCap(new EvmClient('http://node', 'http://peer'));
        expect(err?.message).toMatch(/still pending/);
    });

    it('keeps reporting pending when the peer is unreachable', async () => {
        vi.useFakeTimers();
        mockStrandedScenario(false, false);
        const err = await runToHardCap(new EvmClient('http://node', 'http://peer'));
        // An unreachable peer is not evidence that a live tx is stranded.
        expect(err?.message).toMatch(/still pending/);
    });

    it('keeps reporting pending when no peer is configured', async () => {
        vi.useFakeTimers();
        mockStrandedScenario(false);
        const err = await runToHardCap(new EvmClient('http://node'));
        expect(err?.message).toMatch(/still pending/);
    });
});
