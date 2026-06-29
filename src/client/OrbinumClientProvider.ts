import { OrbinumClient } from './OrbinumClient';
import type { OrbinumClientConfig } from './types';

// ─── Connection state ─────────────────────────────────────────────────────────

/** Lifecycle state of the provider's underlying `OrbinumClient` connection. */
export type ConnectionStatus =
    | 'idle' // Not yet connected; `connect()` has not been called.
    | 'connecting' // Initial connection attempt in progress.
    | 'connected' // Client is live and heartbeat is running.
    | 'disconnected' // Connection lost; reconnect will be scheduled automatically.
    | 'reconnecting'; // Waiting for the next reconnect attempt (exponential backoff).

/** Payload emitted to every `StatusListener` on each status transition. */
export type StatusChangeEvent = {
    /** The new connection status. */
    status: ConnectionStatus;
    /** Human-readable error description. Only present on `'disconnected'` transitions. */
    error?: string;
};

/** Callback invoked whenever the provider's `ConnectionStatus` changes. */
export type StatusListener = (event: StatusChangeEvent) => void;

/** Configuration for `OrbinumClientProvider`. Extends `OrbinumClientConfig` with reconnection and heartbeat tuning. */
export interface ClientProviderConfig {
    /** WebSocket URL of the Orbinum Substrate node (e.g. `"ws://localhost:9944"`). */
    substrateWs: string;
    /** HTTP URL of the EVM JSON-RPC endpoint (e.g. `"http://localhost:9933"`). Omit to disable EVM support. */
    evmRpc?: string;
    /** Base URL of the Orbinum indexer REST API (e.g. `"https://indexer.orbinum.io"`). Omit to disable indexer support. */
    indexerUrl?: string;
    /** Timeout for the initial WebSocket handshake in milliseconds. Default: `8_000`. */
    connectTimeoutMs?: number;
    /** Interval between heartbeat probes in milliseconds. Default: `5_000`. */
    heartbeatIntervalMs?: number;
    /** Maximum time to wait for a heartbeat response before treating the node as unreachable. Default: `4_000`. */
    heartbeatTimeoutMs?: number;
    /** Initial reconnect delay in milliseconds (doubles on each failure). Default: `3_000`. */
    reconnectBaseMs?: number;
    /** Maximum reconnect delay cap in milliseconds. Default: `30_000`. */
    reconnectMaxMs?: number;
}

// ─── Defaults ─────────────────────────────────────────────────────────────────

const DEFAULT_CONNECT_TIMEOUT_MS = 8_000;
const DEFAULT_HEARTBEAT_INTERVAL_MS = 5_000;
const DEFAULT_HEARTBEAT_TIMEOUT_MS = 4_000;
const DEFAULT_RECONNECT_BASE_MS = 3_000;
const DEFAULT_RECONNECT_MAX_MS = 30_000;

/**
 * Manages the lifecycle of an `OrbinumClient` with heartbeat monitoring,
 * exponential-backoff reconnection, and status event emission.
 *
 * Instantiate one per application and use as a singleton.
 *
 * @example
 * ```ts
 * import { OrbinumClientProvider } from '@orbinum/sdk';
 *
 * const provider = new OrbinumClientProvider({
 *   substrateWs: 'ws://localhost:9944',
 *   evmRpc: 'http://localhost:9944',
 * });
 * provider.connect();
 *
 * const client = await provider.getOrbinumClient();
 * ```
 */
export class OrbinumClientProvider {
    private readonly config: ClientProviderConfig;
    private readonly connectTimeoutMs: number;
    private readonly heartbeatIntervalMs: number;
    private readonly heartbeatTimeoutMs: number;
    private readonly reconnectBaseMs: number;
    private readonly reconnectMaxMs: number;

    // ─── State ──────────────────────────────────────────────────────────────
    private _status: ConnectionStatus = 'idle';
    private _orbinumClient: OrbinumClient | null = null;
    private _connectingPromise: Promise<OrbinumClient> | null = null;

    // ─── Timers ─────────────────────────────────────────────────────────────
    private _heartbeatTimer: ReturnType<typeof setInterval> | null = null;
    private _reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    private _reconnectAttempt = 0;

    // ─── Events ─────────────────────────────────────────────────────────────
    private _listeners: Set<StatusListener> = new Set();

    /** Creates a new provider with the given configuration. Does not connect automatically — call `connect()` to initiate. */
    constructor(config: ClientProviderConfig) {
        this.config = config;
        this.connectTimeoutMs = config.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS;
        this.heartbeatIntervalMs = config.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS;
        this.heartbeatTimeoutMs = config.heartbeatTimeoutMs ?? DEFAULT_HEARTBEAT_TIMEOUT_MS;
        this.reconnectBaseMs = config.reconnectBaseMs ?? DEFAULT_RECONNECT_BASE_MS;
        this.reconnectMaxMs = config.reconnectMaxMs ?? DEFAULT_RECONNECT_MAX_MS;
    }

    // ─── Status ─────────────────────────────────────────────────────────────

    /** Current connection status. Reflects the last state set by the provider internals. */
    get status(): ConnectionStatus {
        return this._status;
    }

    /** Updates internal status and notifies all registered listeners. Swallows listener exceptions to avoid cascading failures. */
    private setStatus(status: ConnectionStatus, error?: string): void {
        this._status = status;
        const event: StatusChangeEvent = { status, ...(error ? { error } : {}) };
        this._listeners.forEach((fn) => {
            try {
                fn(event);
            } catch {
                /* listener errors must not break the provider */
            }
        });
    }

    /**
     * Registers a listener that is called on every status transition.
     * Returns an unsubscribe function — call it to stop receiving events.
     */
    onStatusChange(listener: StatusListener): () => void {
        this._listeners.add(listener);
        return () => {
            this._listeners.delete(listener);
        };
    }

    // ─── Lifecycle ──────────────────────────────────────────────────────────

    /**
     * Initiates the first connection attempt. No-op if the provider is not in `'idle'` state.
     * Call this once after constructing the provider.
     */
    connect(): void {
        if (this._status !== 'idle') return;
        this.startConnectAttempt();
    }

    /**
     * Tears down the active client and any pending reconnect timers,
     * then resets the provider back to `'idle'` so `connect()` can be called again.
     */
    reset(): void {
        this.cancelReconnect();
        this.teardownClient();
        this._reconnectAttempt = 0;
        this.setStatus('idle');
    }

    // ─── Internal connection flow ───────────────────────────────────────────

    /** Transitions to `'connecting'`, kicks off `attemptConnect`, and schedules a reconnect if it fails. */
    private startConnectAttempt(): void {
        this.setStatus('connecting');
        this._connectingPromise = this.attemptConnect();
        this._connectingPromise.catch(() => {
            if (this._status !== 'idle') this.scheduleReconnect();
        });
    }

    /**
     * Performs a single connection attempt race against `connectTimeoutMs`.
     * On success: stores the client, starts the heartbeat, and returns it.
     * On failure: destroys any orphaned client and transitions to `'disconnected'`.
     */
    private async attemptConnect(): Promise<OrbinumClient> {
        let timeoutId: ReturnType<typeof setTimeout> | null = null;
        let orphanClient: OrbinumClient | null = null;

        const timeoutPromise = new Promise<never>((_, reject) => {
            timeoutId = setTimeout(
                () =>
                    reject(
                        new Error(
                            `Node unavailable — could not connect to ${this.config.substrateWs} within ${this.connectTimeoutMs / 1000}s`
                        )
                    ),
                this.connectTimeoutMs
            );
        });

        try {
            const connectConfig: OrbinumClientConfig = {
                substrateWs: this.config.substrateWs,
            };
            if (this.config.evmRpc) connectConfig.evmRpc = this.config.evmRpc;
            if (this.config.indexerUrl) connectConfig.indexerUrl = this.config.indexerUrl;
            const clientPromise = OrbinumClient.connect(connectConfig);
            const client = await Promise.race([clientPromise, timeoutPromise]);
            orphanClient = client;

            clearTimeout(timeoutId!);
            orphanClient = null;

            this._orbinumClient = client;
            this._connectingPromise = null;
            this._reconnectAttempt = 0;
            this.setStatus('connected');
            this.startHeartbeat();

            return client;
        } catch (err) {
            clearTimeout(timeoutId!);
            if (orphanClient) {
                try {
                    orphanClient.destroy();
                } catch {
                    /* ignore */
                }
            }
            this._connectingPromise = null;
            this.setStatus(
                'disconnected',
                err instanceof Error ? err.message : 'Connection failed'
            );
            throw err;
        }
    }

    // ─── Heartbeat ──────────────────────────────────────────────────────────

    /** Starts the periodic heartbeat loop. Replaces any existing timer. */
    private startHeartbeat(): void {
        this.stopHeartbeat();
        this._heartbeatTimer = setInterval(async () => {
            if (this._status !== 'connected' || !this._orbinumClient) return;
            const alive = await this.probe();
            if (!alive && this._status === 'connected') {
                this.setStatus('disconnected', 'Node is unreachable');
                this.teardownClient();
                this.scheduleReconnect();
            }
        }, this.heartbeatIntervalMs);
    }

    /** Clears the heartbeat interval timer if active. */
    private stopHeartbeat(): void {
        if (this._heartbeatTimer) {
            clearInterval(this._heartbeatTimer);
            this._heartbeatTimer = null;
        }
    }

    /**
     * Sends a `system_health` RPC ping and waits up to `heartbeatTimeoutMs`.
     * Returns `true` if the node responds in time, `false` otherwise.
     */
    private async probe(): Promise<boolean> {
        if (!this._orbinumClient) return false;
        try {
            await Promise.race([
                this._orbinumClient.substrate.request('system_health', []),
                new Promise<never>((_, reject) =>
                    setTimeout(() => reject(new Error('timeout')), this.heartbeatTimeoutMs)
                ),
            ]);
            return true;
        } catch {
            return false;
        }
    }

    // ─── Reconnection ───────────────────────────────────────────────────────

    /**
     * Schedules the next connection attempt using exponential backoff
     * (capped at `reconnectMaxMs`), then transitions to `'reconnecting'`.
     */
    private scheduleReconnect(): void {
        if (this._reconnectTimer) clearTimeout(this._reconnectTimer);
        const delay = Math.min(
            this.reconnectBaseMs * 2 ** this._reconnectAttempt,
            this.reconnectMaxMs
        );
        this._reconnectAttempt++;
        this.setStatus('reconnecting');
        this._reconnectTimer = setTimeout(() => {
            this._reconnectTimer = null;
            if (this._status !== 'idle') this.startConnectAttempt();
        }, delay);
    }

    /** Clears any pending reconnect timer without triggering a new attempt. */
    private cancelReconnect(): void {
        if (this._reconnectTimer) {
            clearTimeout(this._reconnectTimer);
            this._reconnectTimer = null;
        }
    }

    // ─── Client teardown ────────────────────────────────────────────────────

    /** Stops the heartbeat, destroys the active client, and clears all in-progress promises. */
    private teardownClient(): void {
        this.stopHeartbeat();
        try {
            this._orbinumClient?.destroy();
        } catch {
            /* ignore */
        }
        this._orbinumClient = null;
        this._connectingPromise = null;
    }

    // ─── Client access ──────────────────────────────────────────────────────

    /**
     * Returns the active `OrbinumClient`, or awaits the in-progress connection attempt.
     * Throws if the provider is `'idle'`, `'disconnected'`, or `'reconnecting'`.
     */
    async getOrbinumClient(): Promise<OrbinumClient> {
        if (this._orbinumClient) return this._orbinumClient;
        if (this._connectingPromise) return this._connectingPromise;
        throw new Error(`OrbinumClientProvider: cannot get client in status '${this._status}'`);
    }

    /**
     * Same as `getOrbinumClient()` but returns `null` instead of throwing.
     * Useful in contexts where a missing client is an acceptable no-op.
     */
    async tryGetOrbinumClient(): Promise<OrbinumClient | null> {
        try {
            return await this.getOrbinumClient();
        } catch {
            return null;
        }
    }

    // ─── Convenience RPC helpers ────────────────────────────────────────────

    /**
     * Sends a single Substrate JSON-RPC request and returns the typed result.
     * Waits for the client to be ready before dispatching.
     */
    async rpcSend<T>(method: string, params: unknown[] = []): Promise<T> {
        const client = await this.getOrbinumClient();
        return client.substrate.request<T>(method, params);
    }

    /**
     * Sends multiple Substrate JSON-RPC calls as a single HTTP batch request.
     * Returns a tuple of typed results in the same order as `calls`.
     */
    async rpcBatch<T extends unknown[]>(
        calls: Array<{ method: string; params?: unknown[] }>
    ): Promise<T> {
        const client = await this.getOrbinumClient();
        return client.substrate.batchRequest<T>(calls);
    }

    /**
     * Sends a single EVM JSON-RPC request and returns the typed result.
     * Throws if `evmRpc` was not configured.
     */
    async evmRpc<T>(method: string, params: unknown[] = []): Promise<T> {
        const client = await this.getOrbinumClient();
        if (!client.evm) throw new Error('EVM RPC not configured');
        return client.evm.request<T>(method, params);
    }

    /**
     * Sends multiple EVM JSON-RPC calls as a single batch request.
     * Returns a tuple of typed results in the same order as `calls`.
     * Throws if `evmRpc` was not configured.
     */
    async evmRpcBatch<T extends unknown[]>(
        calls: Array<{ method: string; params?: unknown[] }>
    ): Promise<T> {
        const client = await this.getOrbinumClient();
        if (!client.evm) throw new Error('EVM RPC not configured');
        return client.evm.batchRequest<T>(calls);
    }
}
