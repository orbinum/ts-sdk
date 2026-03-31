import { OrbinumClient } from './OrbinumClient';
import type { OrbinumClientConfig } from './types';

// ─── Connection state ─────────────────────────────────────────────────────────

export type ConnectionStatus =
    | 'idle'
    | 'connecting'
    | 'connected'
    | 'disconnected'
    | 'reconnecting';

export type StatusChangeEvent = {
    status: ConnectionStatus;
    error?: string;
};

export type StatusListener = (event: StatusChangeEvent) => void;

export interface ClientProviderConfig {
    substrateWs: string;
    evmRpc?: string;
    /** Base URL of the Orbinum indexer REST API (e.g. "https://indexer.orbinum.io") */
    indexerUrl?: string;
    connectTimeoutMs?: number;
    heartbeatIntervalMs?: number;
    heartbeatTimeoutMs?: number;
    reconnectBaseMs?: number;
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

    constructor(config: ClientProviderConfig) {
        this.config = config;
        this.connectTimeoutMs = config.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS;
        this.heartbeatIntervalMs = config.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS;
        this.heartbeatTimeoutMs = config.heartbeatTimeoutMs ?? DEFAULT_HEARTBEAT_TIMEOUT_MS;
        this.reconnectBaseMs = config.reconnectBaseMs ?? DEFAULT_RECONNECT_BASE_MS;
        this.reconnectMaxMs = config.reconnectMaxMs ?? DEFAULT_RECONNECT_MAX_MS;
    }

    // ─── Status ─────────────────────────────────────────────────────────────

    get status(): ConnectionStatus {
        return this._status;
    }

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

    onStatusChange(listener: StatusListener): () => void {
        this._listeners.add(listener);
        return () => {
            this._listeners.delete(listener);
        };
    }

    // ─── Lifecycle ──────────────────────────────────────────────────────────

    connect(): void {
        if (this._status !== 'idle') return;
        this.startConnectAttempt();
    }

    reset(): void {
        this.cancelReconnect();
        this.teardownClient();
        this._reconnectAttempt = 0;
        this.setStatus('idle');
    }

    // ─── Internal connection flow ───────────────────────────────────────────

    private startConnectAttempt(): void {
        this.setStatus('connecting');
        this._connectingPromise = this.attemptConnect();
        this._connectingPromise.catch(() => {
            if (this._status !== 'idle') this.scheduleReconnect();
        });
    }

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

    private stopHeartbeat(): void {
        if (this._heartbeatTimer) {
            clearInterval(this._heartbeatTimer);
            this._heartbeatTimer = null;
        }
    }

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

    private cancelReconnect(): void {
        if (this._reconnectTimer) {
            clearTimeout(this._reconnectTimer);
            this._reconnectTimer = null;
        }
    }

    // ─── Client teardown ────────────────────────────────────────────────────

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

    async getOrbinumClient(): Promise<OrbinumClient> {
        if (this._orbinumClient) return this._orbinumClient;
        if (this._connectingPromise) return this._connectingPromise;
        throw new Error(`OrbinumClientProvider: cannot get client in status '${this._status}'`);
    }

    async tryGetOrbinumClient(): Promise<OrbinumClient | null> {
        try {
            return await this.getOrbinumClient();
        } catch {
            return null;
        }
    }

    // ─── Convenience RPC helpers ────────────────────────────────────────────

    async rpcSend<T>(method: string, params: unknown[] = []): Promise<T> {
        const client = await this.getOrbinumClient();
        return client.substrate.request<T>(method, params);
    }

    async evmRpc<T>(method: string, params: unknown[] = []): Promise<T> {
        const client = await this.getOrbinumClient();
        if (!client.evm) throw new Error('EVM RPC not configured');
        return client.evm.request<T>(method, params);
    }

    async evmRpcBatch<T extends unknown[]>(
        calls: Array<{ method: string; params?: unknown[] }>
    ): Promise<T> {
        const client = await this.getOrbinumClient();
        if (!client.evm) throw new Error('EVM RPC not configured');
        return client.evm.batchRequest<T>(calls);
    }
}
