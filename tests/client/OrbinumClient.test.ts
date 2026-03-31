import { describe, it, expect, vi, beforeEach } from 'vitest';
import { OrbinumClient } from '../../src/client/OrbinumClient';
import { SubstrateClient } from '../../src/substrate/SubstrateClient';
import { EvmClient } from '../../src/evm/EvmClient';
import { IndexerClient } from '../../src/indexer/IndexerClient';
import { EvmExplorer } from '../../src/evm-explorer/EvmExplorer';

// ─── Module mocks ─────────────────────────────────────────────────────────────

vi.mock('../../src/substrate/SubstrateClient', () => ({
    SubstrateClient: {
        connect: vi.fn(),
    },
}));

vi.mock('../../src/evm/EvmClient', () => ({
    EvmClient: vi.fn(),
}));
vi.mock('../../src/indexer/IndexerClient', () => ({
    IndexerClient: vi.fn(),
}));

vi.mock('../../src/evm-explorer/EvmExplorer', () => ({
    EvmExplorer: vi.fn(),
}));
// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeSubstrate(): SubstrateClient {
    return {
        request: vi.fn().mockResolvedValue({}),
        unsafe: { tx: {} },
        destroy: vi.fn(),
        getChainInfo: vi.fn(),
        polkadotClient: {},
        submit: vi.fn(),
        submitAndWatch: vi.fn(),
        signAndSubmit: vi.fn(),
        txFromCallData: vi.fn(),
        getHealth: vi.fn(),
        getNodeVersion: vi.fn(),
        getGenesisHash: vi.fn(),
    } as unknown as SubstrateClient;
}

function makeEvm(): EvmClient {
    return {
        request: vi.fn().mockResolvedValue({}),
        batchRequest: vi.fn(),
        call: vi.fn(),
        estimateGas: vi.fn(),
        getBalance: vi.fn(),
        getBlockNumber: vi.fn(),
        getChainId: vi.fn(),
        getGasPrice: vi.fn(),
        getTransactionCount: vi.fn(),
        getTransactionReceipt: vi.fn(),
        sendRawTransaction: vi.fn(),
    } as unknown as EvmClient;
}

beforeEach(() => {
    vi.clearAllMocks();
});

// ─── OrbinumClient.connect ────────────────────────────────────────────────────

describe('OrbinumClient.connect', () => {
    it('returns an OrbinumClient instance', async () => {
        const substrate = makeSubstrate();
        vi.mocked(SubstrateClient.connect).mockResolvedValue(substrate);

        const client = await OrbinumClient.connect({ substrateWs: 'ws://localhost:9944' });

        expect(client).toBeInstanceOf(OrbinumClient);
    });

    it('calls SubstrateClient.connect with the wsUrl', async () => {
        const substrate = makeSubstrate();
        vi.mocked(SubstrateClient.connect).mockResolvedValue(substrate);

        await OrbinumClient.connect({ substrateWs: 'ws://localhost:9944' });

        expect(vi.mocked(SubstrateClient.connect)).toHaveBeenCalledWith(
            'ws://localhost:9944',
            15_000,
        );
    });

    it('forwards custom connectTimeoutMs to SubstrateClient.connect', async () => {
        const substrate = makeSubstrate();
        vi.mocked(SubstrateClient.connect).mockResolvedValue(substrate);

        await OrbinumClient.connect({
            substrateWs: 'ws://localhost:9944',
            connectTimeoutMs: 5_000,
        });

        expect(vi.mocked(SubstrateClient.connect)).toHaveBeenCalledWith(
            'ws://localhost:9944',
            5_000,
        );
    });

    it('sets evm to null when evmRpc is not provided', async () => {
        const substrate = makeSubstrate();
        vi.mocked(SubstrateClient.connect).mockResolvedValue(substrate);

        const client = await OrbinumClient.connect({ substrateWs: 'ws://localhost:9944' });

        expect(client.evm).toBeNull();
    });

    it('creates EvmClient when evmRpc is provided', async () => {
        const substrate = makeSubstrate();
        vi.mocked(SubstrateClient.connect).mockResolvedValue(substrate);
        vi.mocked(EvmClient).mockImplementation(makeEvm as never);

        const client = await OrbinumClient.connect({
            substrateWs: 'ws://localhost:9944',
            evmRpc: 'http://localhost:9933',
        });

        expect(client.evm).not.toBeNull();
        expect(vi.mocked(EvmClient)).toHaveBeenCalledWith('http://localhost:9933');
    });

    it('sets indexer to null when indexerUrl is not provided', async () => {
        const substrate = makeSubstrate();
        vi.mocked(SubstrateClient.connect).mockResolvedValue(substrate);

        const client = await OrbinumClient.connect({ substrateWs: 'ws://localhost:9944' });

        expect(client.indexer).toBeNull();
    });

    it('creates IndexerClient when indexerUrl is provided', async () => {
        const substrate = makeSubstrate();
        vi.mocked(SubstrateClient.connect).mockResolvedValue(substrate);
        vi.mocked(IndexerClient).mockImplementation((() => ({})) as never);

        const client = await OrbinumClient.connect({
            substrateWs: 'ws://localhost:9944',
            indexerUrl: 'https://indexer.example.com',
        });

        expect(client.indexer).not.toBeNull();
        expect(vi.mocked(IndexerClient)).toHaveBeenCalledWith({
            baseUrl: 'https://indexer.example.com',
        });
    });

    it('sets evmExplorer to null when evmRpc is not provided', async () => {
        const substrate = makeSubstrate();
        vi.mocked(SubstrateClient.connect).mockResolvedValue(substrate);

        const client = await OrbinumClient.connect({ substrateWs: 'ws://localhost:9944' });

        expect(client.evmExplorer).toBeNull();
    });

    it('creates EvmExplorer when evmRpc is provided', async () => {
        const substrate = makeSubstrate();
        vi.mocked(SubstrateClient.connect).mockResolvedValue(substrate);
        vi.mocked(EvmClient).mockImplementation(makeEvm as never);
        vi.mocked(EvmExplorer).mockImplementation((() => ({})) as never);

        const client = await OrbinumClient.connect({
            substrateWs: 'ws://localhost:9944',
            evmRpc: 'http://localhost:9933',
        });

        expect(client.evmExplorer).not.toBeNull();
    });

    it('sets precompiles to null when evmRpc is not provided', async () => {
        const substrate = makeSubstrate();
        vi.mocked(SubstrateClient.connect).mockResolvedValue(substrate);

        const client = await OrbinumClient.connect({ substrateWs: 'ws://localhost:9944' });

        expect(client.precompiles).toBeNull();
    });

    it('exposes precompiles when evmRpc is provided', async () => {
        const substrate = makeSubstrate();
        vi.mocked(SubstrateClient.connect).mockResolvedValue(substrate);
        vi.mocked(EvmClient).mockImplementation(makeEvm as never);

        const client = await OrbinumClient.connect({
            substrateWs: 'ws://localhost:9944',
            evmRpc: 'http://localhost:9933',
        });

        expect(client.precompiles).not.toBeNull();
        expect(client.precompiles?.shieldedPool).toBeDefined();
        expect(client.precompiles?.accountMapping).toBeDefined();
        expect(client.precompiles?.crypto).toBeDefined();
    });
});

// ─── OrbinumClient modules ────────────────────────────────────────────────────

describe('OrbinumClient modules', () => {
    async function makeConnectedClient(withEvm = false): Promise<OrbinumClient> {
        const substrate = makeSubstrate();
        vi.mocked(SubstrateClient.connect).mockResolvedValue(substrate);
        if (withEvm) vi.mocked(EvmClient).mockImplementation(makeEvm as never);
        return OrbinumClient.connect({
            substrateWs: 'ws://localhost:9944',
            ...(withEvm ? { evmRpc: 'http://localhost:9933' } : {}),
        });
    }

    it('exposes substrate client', async () => {
        const client = await makeConnectedClient();
        expect(client.substrate).toBeDefined();
    });

    it('exposes shieldedPool module', async () => {
        const client = await makeConnectedClient();
        expect(client.shieldedPool).toBeDefined();
    });

    it('exposes accountMapping module', async () => {
        const client = await makeConnectedClient();
        expect(client.accountMapping).toBeDefined();
    });

    it('exposes privacy module', async () => {
        const client = await makeConnectedClient();
        expect(client.privacy).toBeDefined();
    });
});

// ─── OrbinumClient.destroy ────────────────────────────────────────────────────

describe('OrbinumClient.destroy', () => {
    it('calls substrate.destroy()', async () => {
        const substrate = makeSubstrate();
        vi.mocked(SubstrateClient.connect).mockResolvedValue(substrate);

        const client = await OrbinumClient.connect({ substrateWs: 'ws://localhost:9944' });
        client.destroy();

        expect(substrate.destroy).toHaveBeenCalledOnce();
    });
});
