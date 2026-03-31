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

vi.mock('@polkadot-api/metadata-builders', () => ({
  getDynamicBuilder: vi.fn(),
  getLookupFn: vi.fn(),
}));

vi.mock('@polkadot-api/substrate-bindings', () => ({
  decAnyMetadata: vi.fn(),
  unifyMetadata: vi.fn(),
  AccountId: vi.fn().mockReturnValue({ dec: vi.fn().mockReturnValue('5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY') }),
}));

import { createClient, Binary } from 'polkadot-api';
import { getWsProvider } from 'polkadot-api/ws-provider';
import { getDynamicBuilder, getLookupFn } from '@polkadot-api/metadata-builders';
import { decAnyMetadata, unifyMetadata, AccountId } from '@polkadot-api/substrate-bindings';
import type { EventRecord } from '../../src/substrate/types';

// ─── Helpers ──────────────────────────────────────────────────────────────────

type MockPapi = {
  _request: ReturnType<typeof vi.fn>;
  getMetadata: ReturnType<typeof vi.fn>;
  getUnsafeApi: ReturnType<typeof vi.fn>;
  submit: ReturnType<typeof vi.fn>;
  submitAndWatch: ReturnType<typeof vi.fn>;
  destroy: ReturnType<typeof vi.fn>;
  getBlockHeader?: ReturnType<typeof vi.fn>;
  blocks$?: unknown;
};

function makeMockPapi(overrides: Partial<MockPapi> = {}): MockPapi {
  return {
    _request: vi.fn().mockResolvedValue('orbinum'),
    getMetadata: vi.fn().mockResolvedValue(new Uint8Array([1, 2, 3, 4])),
    getUnsafeApi: vi.fn().mockReturnValue({}),
    submit: vi.fn(),
    submitAndWatch: vi.fn(),
    destroy: vi.fn(),
    ...overrides,
  };
}

// ─── Builder mock factory ────────────────────────────────────────────────────

function makeBuilderMock(decResult: unknown[] = []) {
  const dec = vi.fn().mockReturnValue(decResult);
  const enc = vi.fn().mockReturnValue('0x26aa394eea5630e07c48ae0c9558cef780d41e5e16056765bc8461851072c9d7');
  const buildStorage = vi.fn().mockReturnValue({ keys: { enc }, value: { dec } });
  const builder = { buildStorage };
  vi.mocked(getDynamicBuilder).mockReturnValue(builder as never);
  vi.mocked(getLookupFn).mockReturnValue((() => {}) as never);
  vi.mocked(decAnyMetadata).mockReturnValue({} as never);
  vi.mocked(unifyMetadata).mockReturnValue({} as never);
  return { builder, buildStorage, enc, dec };
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

// ─── SubstrateClient.getChainInfo ───────────────────────────────────────────

describe('SubstrateClient.getChainInfo', () => {
  it('returns name, version, ss58Prefix, symbol and decimals from parallel RPC calls', async () => {
    const { client, papi } = await makeClient();
    papi._request
      .mockResolvedValueOnce('Orbinum Testnet')
      .mockResolvedValueOnce({ specName: 'orbinum', specVersion: 10042, implName: 'orbinum', ss58Prefix: 10 })
      .mockResolvedValueOnce({ tokenSymbol: 'ORB', tokenDecimals: 18 });

    expect(await client.getChainInfo()).toEqual({
      name: 'Orbinum Testnet',
      version: '10042',
      ss58Prefix: 10,
      symbol: 'ORB',
      decimals: 18,
    });
  });

  it('defaults ss58Prefix to 42 when absent', async () => {
    const { client, papi } = await makeClient();
    papi._request
      .mockResolvedValueOnce('TestNet')
      .mockResolvedValueOnce({ specName: 'test', specVersion: 1, implName: 'test' })
      .mockResolvedValueOnce({});

    expect((await client.getChainInfo()).ss58Prefix).toBe(42);
  });

  it('handles array tokenSymbol and tokenDecimals', async () => {
    const { client, papi } = await makeClient();
    papi._request
      .mockResolvedValueOnce('Multi Token Chain')
      .mockResolvedValueOnce({ specName: 'multi', specVersion: 5, implName: 'multi', ss58Prefix: 42 })
      .mockResolvedValueOnce({ tokenSymbol: ['ORB', 'DOT'], tokenDecimals: [18, 10] });

    const info = await client.getChainInfo();
    expect(info.symbol).toBe('ORB');
    expect(info.decimals).toBe(18);
  });

  it('defaults symbol to ORB and decimals to 18 when properties absent', async () => {
    const { client, papi } = await makeClient();
    papi._request
      .mockResolvedValueOnce('NoProps Chain')
      .mockResolvedValueOnce({ specName: 'noprops', specVersion: 1, implName: 'noprops', ss58Prefix: 42 })
      .mockResolvedValueOnce({});

    const info = await client.getChainInfo();
    expect(info.symbol).toBe('ORB');
    expect(info.decimals).toBe(18);
  });
});

// ─── SubstrateClient.getHealth ──────────────────────────────────────────────

describe('SubstrateClient.getHealth', () => {
  it('returns the raw health object', async () => {
    const health = { peers: 5, isSyncing: false, shouldHavePeers: true };
    const { client, papi } = await makeClient();
    papi._request.mockResolvedValueOnce(health);

    expect(await client.getHealth()).toEqual(health);
  });
});

// ─── SubstrateClient.getNodeVersion ─────────────────────────────────────────

describe('SubstrateClient.getNodeVersion', () => {
  it('returns the version string', async () => {
    const { client, papi } = await makeClient();
    papi._request.mockResolvedValueOnce('0.9.42-dev');

    expect(await client.getNodeVersion()).toBe('0.9.42-dev');
  });
});

// ─── SubstrateClient.getGenesisHash ─────────────────────────────────────────

describe('SubstrateClient.getGenesisHash', () => {
  it('returns the genesis hash hex', async () => {
    const hash = '0x' + 'a'.repeat(64);
    const { client, papi } = await makeClient();
    papi._request.mockResolvedValueOnce(hash);

    expect(await client.getGenesisHash()).toBe(hash);
  });
});

// ─── SubstrateClient.polkadotClient ───────────────────────────────────────────

describe('SubstrateClient.polkadotClient', () => {
  it('returns the underlying PolkadotClient (_papi)', async () => {
    const { client, papi } = await makeClient();
    expect(client.polkadotClient).toBe(papi);
  });
});

// ─── SubstrateClient.blocks$ ─────────────────────────────────────────────────

describe('SubstrateClient.blocks$', () => {
  it('delegates blocks$ to the underlying PolkadotClient', async () => {
    const fakeBlocks$ = { subscribe: vi.fn() };
    const { client, papi } = await makeClient();
    (papi as unknown as Record<string, unknown>).blocks$ = fakeBlocks$;
    expect(client.blocks$).toBe(fakeBlocks$);
  });
});

// ─── SubstrateClient.getBlockHeader ──────────────────────────────────────────

describe('SubstrateClient.getBlockHeader', () => {
  it('delegates getBlockHeader to the underlying PolkadotClient', async () => {
    const fakeHeader = { number: 42, hash: '0xabc', parent: '0x000' };
    const mockGetBlockHeader = vi.fn().mockResolvedValue(fakeHeader);
    const { client, papi } = await makeClient();
    (papi as unknown as Record<string, unknown>).getBlockHeader = mockGetBlockHeader;
    const result = await client.getBlockHeader('best');
    expect(mockGetBlockHeader).toHaveBeenCalledWith('best');
    expect(result).toBe(fakeHeader);
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
    void client.unsafe;
    void client.unsafe;
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

// ─── Factory helpers for raw PAPI decoded events ──────────────────────────────

function makeRawEvent(
  phaseType: string,
  phaseValue: number | undefined,
  eventType: string,
  methodType: string,
  dataValue: unknown,
) {
  return {
    phase: { type: phaseType, value: phaseValue },
    event: { type: eventType, value: { type: methodType, value: dataValue } },
  };
}

// A minimal valid SCALE hex (System.Events entry for test purposes):
// We don't need a real SCALE payload — the decoder is mocked.
const FAKE_SCALE_HEX = '0x0000' as `0x${string}`;

// ─── SubstrateClient.queryBlockEvents ────────────────────────────────────────

describe('SubstrateClient.queryBlockEvents', () => {
  const BLOCK_HASH = '0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef';

  it('returns an array of EventRecord on success', async () => {
    makeBuilderMock([
      makeRawEvent('ApplyExtrinsic', 1, 'ShieldedPool', 'Shielded', { amount: 1000n }),
    ]);
    const { client, papi } = await makeClient();
    papi._request.mockResolvedValueOnce(FAKE_SCALE_HEX);

    const result = await client.queryBlockEvents(BLOCK_HASH);

    expect(result).not.toBeNull();
    expect(result).toHaveLength(1);
    expect(result![0].event.section).toBe('shieldedPool');
    expect(result![0].event.method).toBe('Shielded');
  });

  it('calls state_getStorage with the encoded key and blockHash', async () => {
    const { enc } = makeBuilderMock([]);
    const { client, papi } = await makeClient();
    papi._request.mockResolvedValueOnce(FAKE_SCALE_HEX);

    await client.queryBlockEvents(BLOCK_HASH);

    expect(papi._request).toHaveBeenCalledWith(
      'state_getStorage',
      [enc.mock.results[0]?.value, BLOCK_HASH],
    );
  });

  it('calls buildStorage with "System" and "Events"', async () => {
    const { buildStorage } = makeBuilderMock([]);
    const { client, papi } = await makeClient();
    papi._request.mockResolvedValueOnce(FAKE_SCALE_HEX);

    await client.queryBlockEvents(BLOCK_HASH);

    expect(buildStorage).toHaveBeenCalledWith('System', 'Events');
  });

  it('returns null when state_getStorage returns null', async () => {
    makeBuilderMock([]);
    const { client, papi } = await makeClient();
    papi._request.mockResolvedValueOnce(null);

    const result = await client.queryBlockEvents(BLOCK_HASH);

    expect(result).toBeNull();
  });

  it('returns null when getMetadata throws', async () => {
    makeBuilderMock([]);
    const { client, papi } = await makeClient();
    papi.getMetadata.mockRejectedValueOnce(new Error('metadata unavailable'));

    const result = await client.queryBlockEvents(BLOCK_HASH);

    expect(result).toBeNull();
  });

  it('returns null when state_getStorage RPC rejects', async () => {
    makeBuilderMock([]);
    const { client, papi } = await makeClient();
    papi._request.mockRejectedValueOnce(new Error('RPC error'));

    const result = await client.queryBlockEvents(BLOCK_HASH);

    expect(result).toBeNull();
  });

  it('returns null when decode throws', async () => {
    const { dec } = makeBuilderMock([]);
    const { client, papi } = await makeClient();
    papi._request.mockResolvedValueOnce(FAKE_SCALE_HEX);
    dec.mockImplementationOnce(() => { throw new Error('bad SCALE'); });

    const result = await client.queryBlockEvents(BLOCK_HASH);

    expect(result).toBeNull();
  });

  it('returns empty array when decoded block has no events', async () => {
    makeBuilderMock([]);
    const { client, papi } = await makeClient();
    papi._request.mockResolvedValueOnce(FAKE_SCALE_HEX);

    const result = await client.queryBlockEvents(BLOCK_HASH);

    expect(result).toEqual([]);
  });

  it('caches the dynamic builder — getMetadata called only once across multiple calls', async () => {
    makeBuilderMock([]);
    const { client, papi } = await makeClient();
    papi._request.mockResolvedValue(FAKE_SCALE_HEX);

    await client.queryBlockEvents(BLOCK_HASH);
    await client.queryBlockEvents(BLOCK_HASH);
    await client.queryBlockEvents(BLOCK_HASH);

    // getMetadata only called on the first invocation
    expect(papi.getMetadata).toHaveBeenCalledTimes(1);
  });

  it('fetches metadata with "best" finality', async () => {
    makeBuilderMock([]);
    const { client, papi } = await makeClient();
    papi._request.mockResolvedValueOnce(FAKE_SCALE_HEX);

    await client.queryBlockEvents(BLOCK_HASH);

    expect(papi.getMetadata).toHaveBeenCalledWith('best');
  });

  it('decodes multi-event blocks correctly', async () => {
    makeBuilderMock([
      makeRawEvent('ApplyExtrinsic', 0, 'System', 'ExtrinsicSuccess', {}),
      makeRawEvent('ApplyExtrinsic', 1, 'Balances', 'Transfer', { amount: 500n }),
      makeRawEvent('ApplyExtrinsic', 1, 'System', 'ExtrinsicSuccess', {}),
    ]);
    const { client, papi } = await makeClient();
    papi._request.mockResolvedValueOnce(FAKE_SCALE_HEX);

    const result = await client.queryBlockEvents(BLOCK_HASH);

    expect(result).toHaveLength(3);
    expect(result![1].event.section).toBe('balances');
    expect(result![1].event.method).toBe('Transfer');
  });
});

// ─── SubstrateClient._toEventRecords (private static) ────────────────────────

// Access via type cast to test the conversion logic in isolation.
const toEventRecords = (d: unknown[]) =>
  (SubstrateClient as unknown as { _toEventRecords(d: unknown[]): EventRecord[] })._toEventRecords(d);

describe('SubstrateClient._toEventRecords', () => {
  it('maps ApplyExtrinsic phase correctly', () => {
    const raw = [makeRawEvent('ApplyExtrinsic', 3, 'ShieldedPool', 'Shielded', {})];
    const [rec] = toEventRecords(raw);

    expect(rec.phase.isApplyExtrinsic).toBe(true);
    expect(rec.phase.asApplyExtrinsic.toNumber()).toBe(3);
    expect(rec.phase.asApplyExtrinsic.toString()).toBe('3');
    expect(rec.phase.asApplyExtrinsic.eq(3)).toBe(true);
    expect(rec.phase.asApplyExtrinsic.eq(0)).toBe(false);
  });

  it('maps non-ApplyExtrinsic phase correctly (Initialization)', () => {
    const raw = [makeRawEvent('Initialization', undefined, 'System', 'NewAccount', {})];
    const [rec] = toEventRecords(raw);

    expect(rec.phase.isApplyExtrinsic).toBe(false);
    expect(rec.phase.asApplyExtrinsic.toNumber()).toBe(0);
  });

  it('lowercases the first char of event.type to form section', () => {
    const raw = [makeRawEvent('ApplyExtrinsic', 0, 'AccountMapping', 'AliasRegistered', {})];
    const [rec] = toEventRecords(raw);
    expect(rec.event.section).toBe('accountMapping');
  });

  it('preserves the method name as-is', () => {
    const raw = [makeRawEvent('ApplyExtrinsic', 0, 'ShieldedPool', 'Unshielded', {})];
    const [rec] = toEventRecords(raw);
    expect(rec.event.method).toBe('Unshielded');
  });

  it('section stays unchanged when already lowercase', () => {
    const raw = [makeRawEvent('ApplyExtrinsic', 0, 'system', 'ExtrinsicFailed', {})];
    const [rec] = toEventRecords(raw);
    expect(rec.event.section).toBe('system');
  });

  it('skips malformed entries without throwing', () => {
    const malformed = [null, undefined, {}, { phase: null }];
    const result = toEventRecords(malformed as unknown[]);
    expect(result).toEqual([]);
  });

  it('returns an empty array for an empty input', () => {
    expect(toEventRecords([])).toEqual([]);
  });

  it('skips malformed entries but keeps valid ones', () => {
    const mixed = [
      makeRawEvent('ApplyExtrinsic', 0, 'System', 'ExtrinsicSuccess', {}),
      null,
      makeRawEvent('ApplyExtrinsic', 1, 'Balances', 'Transfer', {}),
    ];
    const result = toEventRecords(mixed as unknown[]);
    expect(result).toHaveLength(2);
    expect(result[0].event.section).toBe('system');
    expect(result[1].event.section).toBe('balances');
  });

  it('asApplyExtrinsic.eq is index-specific per record', () => {
    const raw = [
      makeRawEvent('ApplyExtrinsic', 2, 'System', 'ExtrinsicSuccess', {}),
      makeRawEvent('ApplyExtrinsic', 5, 'ShieldedPool', 'Shielded', {}),
    ];
    const [r0, r1] = toEventRecords(raw);
    expect(r0.phase.asApplyExtrinsic.eq(2)).toBe(true);
    expect(r0.phase.asApplyExtrinsic.eq(5)).toBe(false);
    expect(r1.phase.asApplyExtrinsic.eq(5)).toBe(true);
    expect(r1.phase.asApplyExtrinsic.eq(2)).toBe(false);
  });
});

// ─── SubstrateClient._buildDataProxy (private static) ────────────────────────

const buildDataProxy = (v: unknown): EventRecord['event']['data'] =>
  (SubstrateClient as unknown as { _buildDataProxy(v: unknown): EventRecord['event']['data'] })._buildDataProxy(v);

describe('SubstrateClient._buildDataProxy', () => {
  it('wraps an array as an array-like with element accessors', () => {
    const proxy = buildDataProxy([42n, 'hello']);
    expect(proxy.length).toBe(2);
    expect(proxy[0].toString()).toBe('42');
    expect(proxy[1].toString()).toBe('hello');
  });

  it('wraps an object using Object.values', () => {
    const proxy = buildDataProxy({ amount: 1000n, who: 'alice' });
    expect(proxy.length).toBe(2);
    expect(proxy[0].toString()).toBe('1000');
    expect(proxy[1].toString()).toBe('alice');
  });

  it('wraps a scalar value (non-array, non-object) as length-1', () => {
    const proxy = buildDataProxy(999n);
    expect(proxy.length).toBe(1);
    expect(proxy[0].toString()).toBe('999');
  });

  it('toJSON on the proxy returns the jsonified value', () => {
    const proxy = buildDataProxy({ amount: 500n });
    const json = proxy.toJSON() as Record<string, unknown>;
    expect(json).toBeDefined();
    expect(typeof json).toBe('object');
  });

  it('toHuman returns the same as toJSON', () => {
    const proxy = buildDataProxy([100n]);
    expect(proxy.toHuman()).toEqual(proxy.toJSON());
  });

  it('bigint values serialize to string via toString()', () => {
    const proxy = buildDataProxy([1_000_000_000_000n]);
    expect(proxy[0].toString()).toBe('1000000000000');
  });

  it('toJSON serializes bigint as string', () => {
    const proxy = buildDataProxy([999n]);
    const json = proxy.toJSON() as unknown[];
    expect(json[0]).toBe('999');
  });

  it('null value is wrapped as scalar', () => {
    const proxy = buildDataProxy(null);
    expect(proxy.length).toBe(1);
  });

  it('element toJSON/toHuman are callable', () => {
    const proxy = buildDataProxy(['value']);
    expect(() => proxy[0].toJSON()).not.toThrow();
    expect(() => proxy[0].toHuman()).not.toThrow();
  });
});

// ─── SubstrateClient.getBlockHash ────────────────────────────────────────────

const VALID_HASH = '0x' + 'ab'.repeat(32);
const ZERO_HASH  = '0x' + '00'.repeat(32);

describe('SubstrateClient.getBlockHash', () => {
  it('returns hash string for a valid block number', async () => {
    const { client, papi } = await makeClient();
    papi._request.mockImplementation((method: string) => {
      if (method === 'chain_getBlockHash') return Promise.resolve(VALID_HASH);
      return Promise.resolve('orbinum');
    });
    expect(await client.getBlockHash(100)).toBe(VALID_HASH);
  });

  it('calls chain_getBlockHash with the provided block number', async () => {
    const { client, papi } = await makeClient();
    papi._request.mockImplementation((method: string) => {
      if (method === 'chain_getBlockHash') return Promise.resolve(VALID_HASH);
      return Promise.resolve('orbinum');
    });
    await client.getBlockHash(42);
    expect(papi._request).toHaveBeenCalledWith('chain_getBlockHash', [42]);
  });

  it('returns null for all-zero hash', async () => {
    const { client, papi } = await makeClient();
    papi._request.mockImplementation((method: string) => {
      if (method === 'chain_getBlockHash') return Promise.resolve(ZERO_HASH);
      return Promise.resolve('orbinum');
    });
    expect(await client.getBlockHash(9999)).toBeNull();
  });

  it('returns null for empty hash response', async () => {
    const { client, papi } = await makeClient();
    papi._request.mockImplementation((method: string) => {
      if (method === 'chain_getBlockHash') return Promise.resolve('');
      return Promise.resolve('orbinum');
    });
    expect(await client.getBlockHash(1)).toBeNull();
  });
});

// ─── SubstrateClient.getBlock ─────────────────────────────────────────────────

const BLOCK_HEADER = {
  parentHash:     '0x' + '00'.repeat(32),
  number:         '0x64',
  stateRoot:      '0x' + '11'.repeat(32),
  extrinsicsRoot: '0x' + '22'.repeat(32),
  digest: { logs: [] as string[] },
};

describe('SubstrateClient.getBlock', () => {
  it('returns BlockInfo for a valid block hash', async () => {
    const { dec } = makeBuilderMock();
    dec.mockReturnValue(1700000000000n);
    const { client, papi } = await makeClient();
    papi._request.mockImplementation((method: string) => {
      if (method === 'chain_getBlock')
        return Promise.resolve({ block: { header: BLOCK_HEADER, extrinsics: [] } });
      if (method === 'state_getStorage') return Promise.resolve('0x0000000000000000');
      return Promise.resolve(null);
    });
    const result = await client.getBlock(VALID_HASH);
    expect(result).not.toBeNull();
    expect(result!.header).toEqual(BLOCK_HEADER);
    expect(result!.extrinsics).toEqual([]);
    expect(result!.author).toBeNull();
  });

  it('resolves a block number to hash before fetching', async () => {
    makeBuilderMock();
    const { client, papi } = await makeClient();
    papi._request.mockImplementation((method: string) => {
      if (method === 'chain_getBlockHash') return Promise.resolve(VALID_HASH);
      if (method === 'chain_getBlock')
        return Promise.resolve({ block: { header: BLOCK_HEADER, extrinsics: [] } });
      if (method === 'state_getStorage') return Promise.resolve(null);
      return Promise.resolve(null);
    });
    const result = await client.getBlock(100);
    expect(papi._request).toHaveBeenCalledWith('chain_getBlockHash', [100]);
    expect(result).not.toBeNull();
  });

  it('returns null when getBlockHash resolves to null', async () => {
    makeBuilderMock();
    const { client, papi } = await makeClient();
    papi._request.mockImplementation((method: string) => {
      if (method === 'chain_getBlockHash') return Promise.resolve(ZERO_HASH);
      return Promise.resolve(null);
    });
    expect(await client.getBlock(99999)).toBeNull();
  });

  it('returns null when chain_getBlock returns no block', async () => {
    makeBuilderMock();
    const { client, papi } = await makeClient();
    papi._request.mockImplementation((method: string) => {
      if (method === 'chain_getBlock') return Promise.resolve(null);
      return Promise.resolve(null);
    });
    expect(await client.getBlock(VALID_HASH)).toBeNull();
  });

  it('returns null on unexpected RPC error', async () => {
    makeBuilderMock();
    const { client, papi } = await makeClient();
    papi._request.mockImplementation((method: string) => {
      if (method === 'chain_getBlock') return Promise.reject(new Error('rpc error'));
      return Promise.resolve(null);
    });
    expect(await client.getBlock(VALID_HASH)).toBeNull();
  });

  it('populates timestampMs from Timestamp.Now storage', async () => {
    const { dec } = makeBuilderMock();
    dec.mockReturnValue(1700000000000n);
    const { client, papi } = await makeClient();
    papi._request.mockImplementation((method: string) => {
      if (method === 'chain_getBlock')
        return Promise.resolve({ block: { header: BLOCK_HEADER, extrinsics: [] } });
      if (method === 'state_getStorage') return Promise.resolve('0x0000000000000000');
      return Promise.resolve(null);
    });
    const result = await client.getBlock(VALID_HASH);
    expect(result!.timestampMs).toBe(1700000000000);
  });

  it('sets timestampMs to null when storage and heuristic both miss', async () => {
    makeBuilderMock();
    const { client, papi } = await makeClient();
    papi._request.mockImplementation((method: string) => {
      if (method === 'chain_getBlock')
        // extrinsic bytes[4] !== 0x03 → heuristic skips it
        return Promise.resolve({ block: { header: BLOCK_HEADER, extrinsics: ['0x01020304'] } });
      if (method === 'state_getStorage') return Promise.resolve(null);
      return Promise.resolve(null);
    });
    const result = await client.getBlock(VALID_HASH);
    expect(result!.timestampMs).toBeNull();
  });

  it('uses dynamic builder cache — getMetadata called only once across two getBlock calls', async () => {
    const { dec } = makeBuilderMock();
    dec.mockReturnValue(1700000000000n);
    const { client, papi } = await makeClient();
    papi._request.mockImplementation((method: string) => {
      if (method === 'chain_getBlock')
        return Promise.resolve({ block: { header: BLOCK_HEADER, extrinsics: [] } });
      if (method === 'state_getStorage') return Promise.resolve('0x0000000000000000');
      return Promise.resolve(null);
    });
    await client.getBlock(VALID_HASH);
    await client.getBlock(VALID_HASH);
    expect(papi.getMetadata).toHaveBeenCalledTimes(1);
  });
});

// ─── SubstrateClient.extractAuthorFromLogs ────────────────────────────────────

/**
 * Builds a PreRuntime digest log (tag byte = 6) with an optional SCALE-compact
 * length mode and a 32-byte public key payload.
 *
 * mode 0 → single-byte compact: (len << 2) | 0
 * mode 1 → two-byte compact:    [(len << 2) | 1, 0]
 * mode 2 → four-byte compact:   [(len << 2) | 2, 0, 0, 0]
 */
function makePreRuntimeLog(pubkeyByte = 0xaa, mode: 0 | 1 | 2 = 0): string {
  const key = new Uint8Array(32).fill(pubkeyByte);
  let lenBytes: number[];
  if (mode === 0) {
    // (32 << 2) | 0 = 128 = 0x80
    lenBytes = [0x80];
  } else if (mode === 1) {
    // (32 << 2) | 1 = 0x81; second byte = 0x00 → (0x81 >> 2) | (0 << 6) = 32
    lenBytes = [0x81, 0x00];
  } else {
    // (32 << 2) | 2 = 0x82; rest bytes = 0 → (0x82 >> 2) | ... = 32
    lenBytes = [0x82, 0x00, 0x00, 0x00];
  }
  // [tag=6, engine_id='aura' (4 bytes), ...lenBytes, ...32-byte pubkey]
  const buf = new Uint8Array([6, 0x61, 0x75, 0x72, 0x61, ...lenBytes, ...key]);
  return '0x' + Array.from(buf).map(b => b.toString(16).padStart(2, '0')).join('');
}

describe('SubstrateClient.extractAuthorFromLogs', () => {
  it('returns null for empty logs array', () => {
    expect(SubstrateClient.extractAuthorFromLogs([], 42)).toBeNull();
  });

  it('skips logs whose tag byte is not 6 (PreRuntime)', () => {
    // tag = 0x02 (Seal), not PreRuntime
    const nonPR = '0x' + '02' + '61757261' + '80' + 'aa'.repeat(32);
    expect(SubstrateClient.extractAuthorFromLogs([nonPR], 42)).toBeNull();
  });

  it('returns null for a log shorter than 6 bytes', () => {
    const shortLog = '0x060102'; // tag=6 but only 3 bytes
    expect(SubstrateClient.extractAuthorFromLogs([shortLog], 42)).toBeNull();
  });

  it('decodes mode-0 compact length and returns SS58 address via AccountId', () => {
    vi.mocked(AccountId).mockReturnValueOnce(
      { dec: vi.fn().mockReturnValue('5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY') } as never,
    );
    const log = makePreRuntimeLog(0xaa, 0);
    const result = SubstrateClient.extractAuthorFromLogs([log], 42);
    expect(result).toBe('5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY');
    expect(vi.mocked(AccountId)).toHaveBeenCalledWith(42);
  });

  it('decodes mode-1 compact length', () => {
    vi.mocked(AccountId).mockReturnValueOnce(
      { dec: vi.fn().mockReturnValue('5FHneW46xGXgs5mUiveU4sbTyGBzmstUspZC92UhjJM694ty') } as never,
    );
    const log = makePreRuntimeLog(0xbb, 1);
    expect(SubstrateClient.extractAuthorFromLogs([log], 42)).toBe(
      '5FHneW46xGXgs5mUiveU4sbTyGBzmstUspZC92UhjJM694ty',
    );
  });

  it('decodes mode-2 compact length', () => {
    vi.mocked(AccountId).mockReturnValueOnce(
      { dec: vi.fn().mockReturnValue('5DAAnrj7VHTznn2AWBemMuyBwZWs6FNFjdyVXUeYum3PTXFy') } as never,
    );
    const log = makePreRuntimeLog(0xcc, 2);
    expect(SubstrateClient.extractAuthorFromLogs([log], 42)).toBe(
      '5DAAnrj7VHTznn2AWBemMuyBwZWs6FNFjdyVXUeYum3PTXFy',
    );
  });

  it('falls back to toHex when AccountId.dec throws', () => {
    vi.mocked(AccountId).mockReturnValueOnce(
      { dec: vi.fn().mockImplementation(() => { throw new Error('invalid key'); }) } as never,
    );
    const log = makePreRuntimeLog(0xaa, 0);
    const result = SubstrateClient.extractAuthorFromLogs([log], 42);
    // Should be a 0x-prefixed hex string of the 32-byte payload
    expect(result).toMatch(/^0x[0-9a-f]{64}$/);
  });

  it('returns null when payload is shorter than 32 bytes', () => {
    // compact mode-0 with len=8: (8 << 2) | 0 = 0x20
    const buf = new Uint8Array([6, 0x61, 0x75, 0x72, 0x61, 0x20, ...new Uint8Array(8).fill(0x01)]);
    const hex = '0x' + Array.from(buf).map(b => b.toString(16).padStart(2, '0')).join('');
    expect(SubstrateClient.extractAuthorFromLogs([hex], 42)).toBeNull();
  });

  it('returns null for malformed hex without throwing', () => {
    expect(() => SubstrateClient.extractAuthorFromLogs(['not-valid-hex'], 42)).not.toThrow();
    expect(SubstrateClient.extractAuthorFromLogs(['not-valid-hex'], 42)).toBeNull();
  });

  it('skips non-PreRuntime logs and returns from the first valid PreRuntime', () => {
    vi.mocked(AccountId).mockReturnValueOnce(
      { dec: vi.fn().mockReturnValue('5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY') } as never,
    );
    const nonPR = '0x' + '02' + '61757261' + '80' + 'aa'.repeat(32);
    const pr    = makePreRuntimeLog(0xaa, 0);
    expect(SubstrateClient.extractAuthorFromLogs([nonPR, pr], 42)).toBe(
      '5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY',
    );
  });
});
