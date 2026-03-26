import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SubstrateClient } from '../../src/substrate/SubstrateClient';

// ─── Module mocks ─────────────────────────────────────────────────────────────

vi.mock('polkadot-api/ws-provider', () => ({
  getWsProvider: vi.fn().mockReturnValue('mock-provider'),
}));

vi.mock('polkadot-api', () => ({
  createClient: vi.fn(),
  Binary: {
    fromBytes: vi.fn((b: Uint8Array) => ({ _tag: 'Binary', bytes: b })),
  },
}));

import { createClient, Binary } from 'polkadot-api';
import { getWsProvider } from 'polkadot-api/ws-provider';

// ─── Helpers ──────────────────────────────────────────────────────────────────

type MockPapi = {
  _request: ReturnType<typeof vi.fn>;
  getUnsafeApi: ReturnType<typeof vi.fn>;
  submit: ReturnType<typeof vi.fn>;
  submitAndWatch: ReturnType<typeof vi.fn>;
  destroy: ReturnType<typeof vi.fn>;
};

function makeMockPapi(overrides: Partial<MockPapi> = {}): MockPapi {
  return {
    _request: vi.fn().mockResolvedValue('orbinum'),
    getUnsafeApi: vi.fn().mockReturnValue({}),
    submit: vi.fn(),
    submitAndWatch: vi.fn(),
    destroy: vi.fn(),
    ...overrides,
  };
}

async function makeClient(papiOverrides: Partial<MockPapi> = {}): Promise<{
  client: SubstrateClient;
  papi: MockPapi;
}> {
  const papi = makeMockPapi(papiOverrides);
  vi.mocked(createClient).mockReturnValue(papi as never);
  const client = await SubstrateClient.connect('ws://localhost:9944');
  return { client, papi };
}

const FINALIZED = { txHash: '0xabc', ok: true, block: { hash: '0xblock', number: 5 } };

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getWsProvider).mockReturnValue('mock-provider' as never);
});

// ─── SubstrateClient.connect ──────────────────────────────────────────────────

describe('SubstrateClient.connect', () => {
  it('returns a SubstrateClient instance on successful connection', async () => {
    const { client } = await makeClient();
    expect(client).toBeInstanceOf(SubstrateClient);
  });

  it('calls getWsProvider with the provided wsUrl', async () => {
    await makeClient();
    expect(vi.mocked(getWsProvider)).toHaveBeenCalledWith('ws://localhost:9944');
  });

  it('calls createClient with the provider', async () => {
    await makeClient();
    expect(vi.mocked(createClient)).toHaveBeenCalledWith('mock-provider');
  });

  it('performs a system_name probe to verify connectivity', async () => {
    const { papi } = await makeClient();
    expect(papi._request).toHaveBeenCalledWith('system_name', []);
  });

  it('throws on connection timeout', async () => {
    const hangingPapi = makeMockPapi({
      _request: vi.fn().mockReturnValue(new Promise(() => {})), // never resolves
    });
    vi.mocked(createClient).mockReturnValue(hangingPapi as never);

    await expect(
      SubstrateClient.connect('ws://localhost', 1)
    ).rejects.toThrow('Connection timeout (1ms) to ws://localhost');
  });

  it('timeout message includes wsUrl and duration', async () => {
    const hangingPapi = makeMockPapi({
      _request: vi.fn().mockReturnValue(new Promise(() => {})),
    });
    vi.mocked(createClient).mockReturnValue(hangingPapi as never);

    await expect(
      SubstrateClient.connect('ws://my-node.example.com', 1)
    ).rejects.toThrow('ws://my-node.example.com');
  });
});

// ─── SubstrateClient.request ──────────────────────────────────────────────────

describe('SubstrateClient.request', () => {
  it('delegates to _papi._request with method and params', async () => {
    const { client, papi } = await makeClient();
    papi._request.mockResolvedValueOnce({ foo: 'bar' });
    const result = await client.request<{ foo: string }>('custom_method', ['arg1', 2]);
    expect(papi._request).toHaveBeenCalledWith('custom_method', ['arg1', 2]);
    expect(result).toEqual({ foo: 'bar' });
  });

  it('defaults params to empty array', async () => {
    const { client, papi } = await makeClient();
    papi._request.mockResolvedValueOnce(null);
    await client.request('no_params_method');
    expect(papi._request).toHaveBeenCalledWith('no_params_method', []);
  });

  it('propagates RPC errors', async () => {
    const { client, papi } = await makeClient();
    papi._request.mockRejectedValueOnce(new Error('RPC failure'));
    await expect(client.request('broken_method')).rejects.toThrow('RPC failure');
  });

  it('returns the typed result directly', async () => {
    const { client, papi } = await makeClient();
    const expected = [1, 2, 3];
    papi._request.mockResolvedValueOnce(expected);
    const result = await client.request<number[]>('list_method');
    expect(result).toBe(expected);
  });
});

// ─── SubstrateClient.polkadotClient ───────────────────────────────────────────

describe('SubstrateClient.polkadotClient', () => {
  it('returns the underlying PolkadotClient (_papi)', async () => {
    const { client, papi } = await makeClient();
    expect(client.polkadotClient).toBe(papi);
  });
});

// ─── SubstrateClient.unsafe ───────────────────────────────────────────────────

describe('SubstrateClient.unsafe', () => {
  it('returns the result of _papi.getUnsafeApi()', async () => {
    const unsafeApi = { tx: { shieldedPool: {} } };
    const { client, papi } = await makeClient({
      getUnsafeApi: vi.fn().mockReturnValue(unsafeApi),
    });
    expect(client.unsafe).toBe(unsafeApi);
    expect(papi.getUnsafeApi).toHaveBeenCalled();
  });

  it('calls getUnsafeApi on each access', async () => {
    const { client, papi } = await makeClient({
      getUnsafeApi: vi.fn().mockReturnValue({}),
    });
    client.unsafe;
    client.unsafe;
    expect(papi.getUnsafeApi).toHaveBeenCalledTimes(2);
  });
});

// ─── SubstrateClient.txFromCallData ───────────────────────────────────────────

describe('SubstrateClient.txFromCallData', () => {
  it('calls Binary.fromBytes with the callData', async () => {
    const mockTx = { signAndSubmit: vi.fn() };
    const unsafeApi = { txFromCallData: vi.fn().mockResolvedValue(mockTx) };
    const { client } = await makeClient({
      getUnsafeApi: vi.fn().mockReturnValue(unsafeApi),
    });

    const callData = new Uint8Array([0x01, 0x02, 0x03]);
    await client.txFromCallData(callData);

    expect(vi.mocked(Binary.fromBytes)).toHaveBeenCalledWith(callData);
  });

  it('calls unsafeApi.txFromCallData with the Binary result', async () => {
    const mockTx = { signAndSubmit: vi.fn() };
    const unsafeApi = { txFromCallData: vi.fn().mockResolvedValue(mockTx) };
    const { client } = await makeClient({
      getUnsafeApi: vi.fn().mockReturnValue(unsafeApi),
    });

    const callData = new Uint8Array([0xab]);
    const binaryResult = vi.mocked(Binary.fromBytes).mockReturnValueOnce(
      { _tag: 'BinaryMock' } as never
    );
    await client.txFromCallData(callData);

    expect(unsafeApi.txFromCallData).toHaveBeenCalled();
  });

  it('returns the tx object from UnsafeApi', async () => {
    const mockTx = { signAndSubmit: vi.fn() };
    const unsafeApi = { txFromCallData: vi.fn().mockResolvedValue(mockTx) };
    const { client } = await makeClient({
      getUnsafeApi: vi.fn().mockReturnValue(unsafeApi),
    });

    const tx = await client.txFromCallData(new Uint8Array([0x01]));
    expect(tx).toBe(mockTx);
  });
});

// ─── SubstrateClient.submit ───────────────────────────────────────────────────

describe('SubstrateClient.submit', () => {
  it('calls _papi.submit with the signed hex', async () => {
    const { client, papi } = await makeClient({
      submit: vi.fn().mockResolvedValue(FINALIZED),
    });
    await client.submit('0xsignedtx');
    expect(papi.submit).toHaveBeenCalledWith('0xsignedtx');
  });

  it('returns the TxFinalizedPayload from _papi.submit', async () => {
    const { client } = await makeClient({
      submit: vi.fn().mockResolvedValue(FINALIZED),
    });
    const result = await client.submit('0xsigned');
    expect(result).toBe(FINALIZED);
  });

  it('propagates errors from _papi.submit', async () => {
    const { client } = await makeClient({
      submit: vi.fn().mockRejectedValue(new Error('submit failed')),
    });
    await expect(client.submit('0xbad')).rejects.toThrow('submit failed');
  });
});

// ─── SubstrateClient.submitAndWatch ───────────────────────────────────────────

describe('SubstrateClient.submitAndWatch', () => {
  it('calls _papi.submitAndWatch with the signed hex', async () => {
    const obs = { subscribe: vi.fn() };
    const { client, papi } = await makeClient({
      submitAndWatch: vi.fn().mockReturnValue(obs),
    });
    client.submitAndWatch('0xsignedtx');
    expect(papi.submitAndWatch).toHaveBeenCalledWith('0xsignedtx');
  });

  it('returns the Observable from _papi.submitAndWatch', async () => {
    const obs = { subscribe: vi.fn() };
    const { client } = await makeClient({
      submitAndWatch: vi.fn().mockReturnValue(obs),
    });
    const result = client.submitAndWatch('0xsigned');
    expect(result).toBe(obs);
  });
});

// ─── SubstrateClient.signAndSubmit ────────────────────────────────────────────

describe('SubstrateClient.signAndSubmit', () => {
  it('builds the tx from callData and signs+submits with the signer', async () => {
    const mockSignAndSubmit = vi.fn().mockResolvedValue(FINALIZED);
    const mockTx = { signAndSubmit: mockSignAndSubmit };
    const unsafeApi = { txFromCallData: vi.fn().mockResolvedValue(mockTx) };
    const { client } = await makeClient({
      getUnsafeApi: vi.fn().mockReturnValue(unsafeApi),
    });

    const signer = {} as never;
    const callData = new Uint8Array([0x01, 0x02]);
    await client.signAndSubmit(callData, signer);

    expect(unsafeApi.txFromCallData).toHaveBeenCalled();
    expect(mockSignAndSubmit).toHaveBeenCalledWith(signer);
  });

  it('returns the TxFinalizedPayload', async () => {
    const mockSignAndSubmit = vi.fn().mockResolvedValue(FINALIZED);
    const mockTx = { signAndSubmit: mockSignAndSubmit };
    const unsafeApi = { txFromCallData: vi.fn().mockResolvedValue(mockTx) };
    const { client } = await makeClient({
      getUnsafeApi: vi.fn().mockReturnValue(unsafeApi),
    });

    const result = await client.signAndSubmit(new Uint8Array([0x01]), {} as never);
    expect(result).toBe(FINALIZED);
  });

  it('propagates errors from signAndSubmit', async () => {
    const mockSignAndSubmit = vi.fn().mockRejectedValue(new Error('sign failed'));
    const mockTx = { signAndSubmit: mockSignAndSubmit };
    const unsafeApi = { txFromCallData: vi.fn().mockResolvedValue(mockTx) };
    const { client } = await makeClient({
      getUnsafeApi: vi.fn().mockReturnValue(unsafeApi),
    });

    await expect(client.signAndSubmit(new Uint8Array([0x01]), {} as never)).rejects.toThrow(
      'sign failed'
    );
  });
});

// ─── SubstrateClient.destroy ──────────────────────────────────────────────────

describe('SubstrateClient.destroy', () => {
  it('calls _papi.destroy()', async () => {
    const { client, papi } = await makeClient();
    client.destroy();
    expect(papi.destroy).toHaveBeenCalledTimes(1);
  });

  it('can be called multiple times without error', async () => {
    const { client } = await makeClient();
    expect(() => {
      client.destroy();
      client.destroy();
    }).not.toThrow();
  });
});
