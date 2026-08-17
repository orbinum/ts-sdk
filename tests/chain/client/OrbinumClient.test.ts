import { describe, it, expect, vi, beforeEach } from 'vitest';
import { OrbinumClient } from '../../../src/chain/client/OrbinumClient';
import { SubstrateClient } from '../../../src/chain/substrate/SubstrateClient';
import { EvmClient } from '../../../src/chain/evm/EvmClient';
import { EvmExplorer } from '../../../src/chain/evm/explorer/EvmExplorer';

// ─── Module mocks ─────────────────────────────────────────────────────────────

vi.mock('../../../src/chain/substrate/SubstrateClient', () => ({
    SubstrateClient: {
        connect: vi.fn(),
        adopt: vi.fn(),
    },
}));

vi.mock('../../../src/chain/evm/EvmClient', () => ({
    EvmClient: vi.fn(),
}));

vi.mock('../../../src/chain/evm/explorer/EvmExplorer', () => ({
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
            15_000
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
            5_000
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
        expect(vi.mocked(EvmClient)).toHaveBeenCalledWith('http://localhost:9933', undefined);
    });

    it('passes evmRpcPeer through to the EvmClient', async () => {
        const substrate = makeSubstrate();
        vi.mocked(SubstrateClient.connect).mockResolvedValue(substrate);
        vi.mocked(EvmClient).mockImplementation(makeEvm as never);

        await OrbinumClient.connect({
            substrateWs: 'ws://localhost:9944',
            evmRpc: 'http://localhost:9933',
            evmRpcPeer: 'http://localhost:9934',
        });

        expect(vi.mocked(EvmClient)).toHaveBeenCalledWith(
            'http://localhost:9933',
            'http://localhost:9934'
        );
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
        vi.mocked(EvmExplorer).mockImplementation(function () {
            return {};
        } as never);

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

// ─── Adopting the caller's chain connection ──────────────────────────────────

describe('OrbinumClient.connect with an existing PAPI client', () => {
    it('adopts it instead of opening a second connection', async () => {
        const substrate = makeSubstrate();
        vi.mocked(SubstrateClient.adopt).mockReturnValue(substrate);
        const papi = { _request: vi.fn() };

        const client = await OrbinumClient.connect({ papi: papi as never });

        expect(SubstrateClient.adopt).toHaveBeenCalledWith(papi, undefined);
        // Opening one anyway would give the application two WebSockets and two
        // views of chain state — the whole point of this path.
        expect(SubstrateClient.connect).not.toHaveBeenCalled();
        expect(client.substrate).toBe(substrate);
    });

    it('forwards the HTTP endpoint when given', async () => {
        vi.mocked(SubstrateClient.adopt).mockReturnValue(makeSubstrate());

        await OrbinumClient.connect({
            papi: { _request: vi.fn() } as never,
            substrateHttp: 'http://localhost:9944',
        });

        expect(SubstrateClient.adopt).toHaveBeenCalledWith(
            expect.anything(),
            'http://localhost:9944'
        );
    });
});
