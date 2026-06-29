import { describe, it, expect, vi, afterEach } from 'vitest';
import { jsonRpcBatch, wsUrlToHttp } from '../../src/utils/jsonRpcHttp';

const URL = 'https://node.example/rpc';

/** Mocks fetch to return a JSON-RPC batch array (200 OK). */
function mockBatchOk(arr: unknown[]): ReturnType<typeof vi.fn> {
    const f = vi.fn().mockResolvedValue({ ok: true, json: async () => arr });
    vi.stubGlobal('fetch', f);
    return f;
}

/** Mocks fetch to return a non-OK status, optionally with a Retry-After header. */
function mockStatus(status: number, retryAfter?: string): ReturnType<typeof vi.fn> {
    const headers = { get: (k: string) => (k === 'retry-after' ? (retryAfter ?? null) : null) };
    const f = vi.fn().mockResolvedValue({ ok: false, status, statusText: 'err', headers });
    vi.stubGlobal('fetch', f);
    return f;
}

afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
});

describe('jsonRpcBatch', () => {
    it('returns [] for empty calls without hitting the network', async () => {
        const f = mockBatchOk([]);
        const out = await jsonRpcBatch(URL, []);
        expect(out).toEqual([]);
        expect(f).not.toHaveBeenCalled();
    });

    it('sends one POST with JSON-RPC 2.0 bodies, ids 0..n', async () => {
        const f = mockBatchOk([
            { jsonrpc: '2.0', id: 0, result: 'a' },
            { jsonrpc: '2.0', id: 1, result: 'b' },
        ]);
        await jsonRpcBatch(URL, [
            { method: 'm0', params: [1] },
            { method: 'm1' },
        ]);
        expect(f).toHaveBeenCalledTimes(1);
        const [url, init] = f.mock.calls[0]!;
        expect(url).toBe(URL);
        expect(init.method).toBe('POST');
        const body = JSON.parse(init.body as string);
        expect(body).toEqual([
            { id: 0, jsonrpc: '2.0', method: 'm0', params: [1] },
            { id: 1, jsonrpc: '2.0', method: 'm1', params: [] },
        ]);
    });

    it('maps results in call order even when the response is reordered by id', async () => {
        mockBatchOk([
            { jsonrpc: '2.0', id: 2, result: 'C' },
            { jsonrpc: '2.0', id: 0, result: 'A' },
            { jsonrpc: '2.0', id: 1, result: 'B' },
        ]);
        const out = await jsonRpcBatch<string[]>(URL, [
            { method: 'a' },
            { method: 'b' },
            { method: 'c' },
        ]);
        expect(out).toEqual(['A', 'B', 'C']);
    });

    it('maps a missing/null/error result to null in that slot', async () => {
        mockBatchOk([
            { jsonrpc: '2.0', id: 0, result: 'ok' },
            { jsonrpc: '2.0', id: 1, result: null },
            { jsonrpc: '2.0', id: 2, error: { code: -1, message: 'boom' } },
        ]);
        const out = await jsonRpcBatch<(string | null)[]>(URL, [
            { method: 'a' },
            { method: 'b' },
            { method: 'c' },
        ]);
        expect(out).toEqual(['ok', null, null]);
    });

    it('throws immediately on a non-retryable status (e.g. 400)', async () => {
        const f = mockStatus(400);
        await expect(jsonRpcBatch(URL, [{ method: 'a' }])).rejects.toThrow(/HTTP 400/);
        expect(f).toHaveBeenCalledTimes(1); // no retry
    });

    it('retries on 429 then succeeds', async () => {
        vi.useFakeTimers();
        // First call 429, second call OK.
        const f = vi
            .fn()
            .mockResolvedValueOnce({
                ok: false,
                status: 429,
                statusText: 'Too Many Requests',
                headers: { get: () => null },
            })
            .mockResolvedValueOnce({
                ok: true,
                json: async () => [{ jsonrpc: '2.0', id: 0, result: 'ok' }],
            });
        vi.stubGlobal('fetch', f);

        const p = jsonRpcBatch<string[]>(URL, [{ method: 'a' }], { baseBackoffMs: 10 });
        await vi.advanceTimersByTimeAsync(20); // let the backoff elapse
        const out = await p;
        expect(out).toEqual(['ok']);
        expect(f).toHaveBeenCalledTimes(2);
    });

    it('honors Retry-After header for the backoff delay', async () => {
        vi.useFakeTimers();
        const f = vi
            .fn()
            .mockResolvedValueOnce({
                ok: false,
                status: 503,
                statusText: 'busy',
                headers: { get: (k: string) => (k === 'retry-after' ? '2' : null) },
            })
            .mockResolvedValueOnce({
                ok: true,
                json: async () => [{ jsonrpc: '2.0', id: 0, result: 'ok' }],
            });
        vi.stubGlobal('fetch', f);

        const p = jsonRpcBatch<string[]>(URL, [{ method: 'a' }]);
        await vi.advanceTimersByTimeAsync(1999);
        expect(f).toHaveBeenCalledTimes(1); // still waiting (Retry-After = 2s)
        await vi.advanceTimersByTimeAsync(2);
        await p;
        expect(f).toHaveBeenCalledTimes(2);
    });

    it('gives up after maxRetries and throws', async () => {
        vi.useFakeTimers();
        mockStatus(429);
        const p = jsonRpcBatch(URL, [{ method: 'a' }], { maxRetries: 2, baseBackoffMs: 1 });
        const assertion = expect(p).rejects.toThrow(/HTTP 429/);
        await vi.runAllTimersAsync();
        await assertion;
        expect(vi.mocked(fetch)).toHaveBeenCalledTimes(3); // initial + 2 retries
    });
});

describe('wsUrlToHttp', () => {
    it('maps wss→https and ws→http, leaves others unchanged', () => {
        expect(wsUrlToHttp('wss://node.example/rpc')).toBe('https://node.example/rpc');
        expect(wsUrlToHttp('ws://localhost:9944')).toBe('http://localhost:9944');
        expect(wsUrlToHttp('https://already.http')).toBe('https://already.http');
    });
});
