import { describe, it, expect, vi, beforeEach } from 'vitest';
import { OrbinumClientProvider } from '../../src/client/OrbinumClientProvider';
import { OrbinumClient } from '../../src/client/OrbinumClient';
import type { ConnectionStatus } from '../../src/client/OrbinumClientProvider';

// ─── Module mocks ─────────────────────────────────────────────────────────────

vi.mock('../../src/client/OrbinumClient', () => ({
    OrbinumClient: {
        connect: vi.fn(),
    },
}));

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeOrbinumClient(requestResult: unknown = { peers: 1 }): OrbinumClient {
    return {
        substrate: {
            request: vi.fn().mockResolvedValue(requestResult),
        },
        evm: null,
        destroy: vi.fn(),
    } as unknown as OrbinumClient;
}

function makeProvider(
    overrides: Partial<ConstructorParameters<typeof OrbinumClientProvider>[0]> = {}
): OrbinumClientProvider {
    return new OrbinumClientProvider({
        substrateWs: 'ws://localhost:9944',
        connectTimeoutMs: 100,
        heartbeatIntervalMs: 999_999,  // very large so heartbeat never fires in tests
        heartbeatTimeoutMs: 50,
        reconnectBaseMs: 999_999,      // very large so reconnect doesn't auto-fire
        reconnectMaxMs: 999_999,
        ...overrides,
    });
}

beforeEach(() => {
    vi.clearAllMocks();
});

// ─── Initial status ───────────────────────────────────────────────────────────

describe('OrbinumClientProvider — initial state', () => {
    it('starts in "idle" status', () => {
        const provider = makeProvider();
        expect(provider.status).toBe<ConnectionStatus>('idle');
    });

    it('getOrbinumClient throws when idle', async () => {
        const provider = makeProvider();
        await expect(provider.getOrbinumClient()).rejects.toThrow("status 'idle'");
    });

    it('tryGetOrbinumClient returns null when idle', async () => {
        const provider = makeProvider();
        const result = await provider.tryGetOrbinumClient();
        expect(result).toBeNull();
    });
});

// ─── connect() ────────────────────────────────────────────────────────────────

describe('OrbinumClientProvider.connect', () => {
    it('transitions to "connecting" and then "connected" on success', async () => {
        const orbClient = makeOrbinumClient();
        vi.mocked(OrbinumClient.connect).mockResolvedValue(orbClient);

        const provider = makeProvider();
        provider.connect();

        expect(provider.status).toBe<ConnectionStatus>('connecting');

        // Wait for the microtask queue to drain (the promise resolves synchronously in mock)
        await Promise.resolve();
        await Promise.resolve();

        expect(provider.status).toBe<ConnectionStatus>('connected');
    });

    it('calling connect() twice (while connecting) is a no-op', async () => {
        const orbClient = makeOrbinumClient();
        vi.mocked(OrbinumClient.connect).mockResolvedValue(orbClient);

        const provider = makeProvider();
        provider.connect();
        provider.connect(); // second call ignored

        await Promise.resolve();
        await Promise.resolve();

        expect(vi.mocked(OrbinumClient.connect)).toHaveBeenCalledTimes(1);
    });

    it('transitions through "disconnected" then "reconnecting" when OrbinumClient.connect rejects', async () => {
        vi.mocked(OrbinumClient.connect).mockRejectedValue(new Error('unreachable'));

        const statuses: ConnectionStatus[] = [];
        const provider = makeProvider();
        provider.onStatusChange((ev) => statuses.push(ev.status));
        provider.connect();

        await new Promise((r) => setTimeout(r, 10));

        expect(statuses).toContain('disconnected');
        // Provider schedules a reconnect attempt after disconnect
        expect(statuses).toContain('reconnecting');
    });

    it('includes error message in the status event on failure', async () => {
        vi.mocked(OrbinumClient.connect).mockRejectedValue(new Error('node down'));

        const statuses: Array<{ status: ConnectionStatus; error?: string }> = [];
        const provider = makeProvider();
        provider.onStatusChange((ev) => statuses.push(ev));
        provider.connect();

        await new Promise((r) => setTimeout(r, 10));

        const disconnectedEv = statuses.find((s) => s.status === 'disconnected');
        expect(disconnectedEv?.error).toBe('node down');
    });

    it('transitions to "disconnected" then "reconnecting" when connection times out', async () => {
        // connect() never resolves — simulating a hung connection
        vi.mocked(OrbinumClient.connect).mockReturnValue(new Promise(() => {}));

        const statuses: ConnectionStatus[] = [];
        const provider = makeProvider({ connectTimeoutMs: 20 });
        provider.onStatusChange((ev) => statuses.push(ev.status));
        provider.connect();

        await new Promise((r) => setTimeout(r, 50));

        // After timeout: disconnected, then reconnecting
        expect(statuses).toContain('disconnected');
        expect(statuses).toContain('reconnecting');
    });
});

// ─── getOrbinumClient ─────────────────────────────────────────────────────────

describe('OrbinumClientProvider.getOrbinumClient', () => {
    it('returns the connected client', async () => {
        const orbClient = makeOrbinumClient();
        vi.mocked(OrbinumClient.connect).mockResolvedValue(orbClient);

        const provider = makeProvider();
        provider.connect();

        await Promise.resolve();
        await Promise.resolve();

        const result = await provider.getOrbinumClient();
        expect(result).toBe(orbClient);
    });

    it('awaits the connecting promise if still connecting', async () => {
        const orbClient = makeOrbinumClient();
        vi.mocked(OrbinumClient.connect).mockResolvedValue(orbClient);

        const provider = makeProvider();
        provider.connect();

        // getOrbinumClient while still "connecting" should still return the client
        const resultPromise = provider.getOrbinumClient();

        await Promise.resolve();
        await Promise.resolve();

        const result = await resultPromise;
        expect(result).toBe(orbClient);
    });
});

// ─── onStatusChange ───────────────────────────────────────────────────────────

describe('OrbinumClientProvider.onStatusChange', () => {
    it('notifies listener on each status transition', async () => {
        const orbClient = makeOrbinumClient();
        vi.mocked(OrbinumClient.connect).mockResolvedValue(orbClient);

        const statuses: ConnectionStatus[] = [];
        const provider = makeProvider();
        provider.onStatusChange((ev) => statuses.push(ev.status));
        provider.connect();

        await Promise.resolve();
        await Promise.resolve();

        expect(statuses).toContain('connecting');
        expect(statuses).toContain('connected');
    });

    it('returned unsubscribe function stops further events', async () => {
        const orbClient = makeOrbinumClient();
        vi.mocked(OrbinumClient.connect).mockResolvedValue(orbClient);

        const statuses: ConnectionStatus[] = [];
        const provider = makeProvider();
        const unsub = provider.onStatusChange((ev) => statuses.push(ev.status));

        unsub(); // unsubscribe before connecting
        provider.connect();

        await Promise.resolve();
        await Promise.resolve();

        expect(statuses).toHaveLength(0);
    });

    it('listener errors do not break the provider', async () => {
        const orbClient = makeOrbinumClient();
        vi.mocked(OrbinumClient.connect).mockResolvedValue(orbClient);

        const provider = makeProvider();
        provider.onStatusChange(() => {
            throw new Error('listener error');
        });
        provider.connect();

        // Should not throw
        await Promise.resolve();
        await Promise.resolve();

        expect(provider.status).toBe<ConnectionStatus>('connected');
    });
});

// ─── reset() ─────────────────────────────────────────────────────────────────

describe('OrbinumClientProvider.reset', () => {
    async function connectProvider(): Promise<{ provider: OrbinumClientProvider; client: OrbinumClient }> {
        const orbClient = makeOrbinumClient();
        vi.mocked(OrbinumClient.connect).mockResolvedValue(orbClient);
        const provider = makeProvider();
        provider.connect();
        await Promise.resolve();
        await Promise.resolve();
        return { provider, client: orbClient };
    }

    it('stops heartbeat and resets to "idle"', async () => {
        const { provider } = await connectProvider();
        provider.reset();
        expect(provider.status).toBe<ConnectionStatus>('idle');
    });

    it('calls destroy on the active client', async () => {
        const { provider, client } = await connectProvider();
        provider.reset();
        expect(client.destroy).toHaveBeenCalledOnce();
    });
});

// ─── rpcSend / evmRpc helpers ─────────────────────────────────────────────────

describe('OrbinumClientProvider.rpcSend', () => {
    it('delegates to substrate.request', async () => {
        const orbClient = makeOrbinumClient('orb-node');
        vi.mocked(OrbinumClient.connect).mockResolvedValue(orbClient);

        const provider = makeProvider();
        provider.connect();
        await Promise.resolve();
        await Promise.resolve();

        const result = await provider.rpcSend<string>('system_name', []);

        expect(result).toBe('orb-node');
        expect(orbClient.substrate.request).toHaveBeenCalledWith('system_name', []);
    });
});

describe('OrbinumClientProvider.evmRpc', () => {
    it('throws when EVM is not configured', async () => {
        const orbClient = makeOrbinumClient();
        vi.mocked(OrbinumClient.connect).mockResolvedValue(orbClient);

        const provider = makeProvider();
        provider.connect();
        await Promise.resolve();
        await Promise.resolve();

        await expect(provider.evmRpc('eth_chainId', [])).rejects.toThrow('EVM RPC not configured');
    });

    it('delegates to evm.request when EVM is configured', async () => {
        const evmMock = { request: vi.fn().mockResolvedValue('0x15') };
        const orbClient = {
            ...makeOrbinumClient(),
            evm: evmMock,
        } as unknown as OrbinumClient;
        vi.mocked(OrbinumClient.connect).mockResolvedValue(orbClient);

        const provider = makeProvider();
        provider.connect();
        await Promise.resolve();
        await Promise.resolve();

        const result = await provider.evmRpc<string>('eth_chainId', []);

        expect(result).toBe('0x15');
        expect(evmMock.request).toHaveBeenCalledWith('eth_chainId', []);
    });
});

describe('OrbinumClientProvider.evmRpcBatch', () => {
    it('throws when EVM is not configured', async () => {
        const orbClient = makeOrbinumClient();
        vi.mocked(OrbinumClient.connect).mockResolvedValue(orbClient);

        const provider = makeProvider();
        provider.connect();
        await Promise.resolve();
        await Promise.resolve();

        await expect(
            provider.evmRpcBatch([{ method: 'eth_chainId' }])
        ).rejects.toThrow('EVM RPC not configured');
    });

    it('delegates batch to evm.batchRequest', async () => {
        const evmMock = { batchRequest: vi.fn().mockResolvedValue(['0x15', '0x1']) };
        const orbClient = {
            ...makeOrbinumClient(),
            evm: evmMock,
        } as unknown as OrbinumClient;
        vi.mocked(OrbinumClient.connect).mockResolvedValue(orbClient);

        const provider = makeProvider();
        provider.connect();
        await Promise.resolve();
        await Promise.resolve();

        const result = await provider.evmRpcBatch([
            { method: 'eth_chainId' },
            { method: 'eth_blockNumber' },
        ]);

        expect(result).toEqual(['0x15', '0x1']);
        expect(evmMock.batchRequest).toHaveBeenCalledWith([
            { method: 'eth_chainId' },
            { method: 'eth_blockNumber' },
        ]);
    });
});
