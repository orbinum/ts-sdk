/**
 * Minimal JSON-RPC 2.0 over HTTP — batch transport.
 *
 * Substrate and EVM nodes both serve JSON-RPC over HTTP. PAPI's WebSocket
 * transport (used by `SubstrateClient` for everything else) does not expose
 * batch requests, so high-throughput callers (e.g. indexer backfill) use this
 * to fetch many results in a single round-trip instead of N.
 */

/** A single JSON-RPC call: method name plus positional params. */
export interface JsonRpcCall {
    method: string;
    params?: unknown[];
}

/** Shape of a single JSON-RPC 2.0 response object. */
interface JsonRpcResponse<T> {
    jsonrpc: '2.0';
    id: number;
    result?: T;
    error?: { code: number; message: string };
}

/** Tuning for batch retry behavior. */
export interface BatchOptions {
    /** Max retries on a retryable HTTP status (429/503). Default: 5. */
    maxRetries?: number;
    /** Base backoff in ms; doubles each attempt, capped at `maxBackoffMs`. Default: 250. */
    baseBackoffMs?: number;
    /** Backoff cap in ms. Default: 4000. */
    maxBackoffMs?: number;
}

const DEFAULT_MAX_RETRIES = 5;
const DEFAULT_BASE_BACKOFF_MS = 250;
const DEFAULT_MAX_BACKOFF_MS = 4000;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Sends `calls` as a single JSON-RPC 2.0 batch to `httpUrl`. Returns the results
 * in the same order as `calls`; a `null`/missing/per-call-error result maps to
 * `null` in that slot. Retries on 429/503 with exponential backoff (honoring
 * `Retry-After`) — public RPC nodes rate-limit bursty batches, so a serious
 * client backs off rather than dropping the window. Rejects only on a
 * non-retryable HTTP failure or after exhausting retries.
 */
export async function jsonRpcBatch<T extends unknown[]>(
    httpUrl: string,
    calls: JsonRpcCall[],
    options: BatchOptions = {}
): Promise<T> {
    if (calls.length === 0) return [] as unknown as T;

    const maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES;
    const baseBackoffMs = options.baseBackoffMs ?? DEFAULT_BASE_BACKOFF_MS;
    const maxBackoffMs = options.maxBackoffMs ?? DEFAULT_MAX_BACKOFF_MS;

    const body = calls.map((c, i) => ({
        id: i,
        jsonrpc: '2.0',
        method: c.method,
        params: c.params ?? [],
    }));
    const payload = JSON.stringify(body);

    let attempt = 0;
    for (;;) {
        const res = await fetch(httpUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: payload,
        });

        if (res.ok) {
            const arr = (await res.json()) as Array<JsonRpcResponse<unknown>>;
            // JSON-RPC does not guarantee response order — reindex by id.
            const byId = new Map(arr.map((r) => [r.id, r]));
            return calls.map((_, i) => byId.get(i)?.result ?? null) as T;
        }

        const retryable = res.status === 429 || res.status === 503;
        if (!retryable || attempt >= maxRetries) {
            throw new Error(`JSON-RPC HTTP ${res.status}: ${res.statusText}`);
        }

        const retryAfter = Number(res.headers.get('retry-after'));
        const delayMs =
            Number.isFinite(retryAfter) && retryAfter > 0
                ? retryAfter * 1000
                : Math.min(baseBackoffMs * 2 ** attempt, maxBackoffMs);
        await sleep(delayMs);
        attempt++;
    }
}

/** Derives the HTTP(S) RPC URL from a WebSocket URL (`ws://`→`http://`, `wss://`→`https://`). */
export function wsUrlToHttp(wsUrl: string): string {
    if (wsUrl.startsWith('wss://')) return 'https://' + wsUrl.slice('wss://'.length);
    if (wsUrl.startsWith('ws://')) return 'http://' + wsUrl.slice('ws://'.length);
    return wsUrl;
}
