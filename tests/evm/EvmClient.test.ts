import { describe, it, expect, vi, afterEach } from 'vitest';
import { EvmClient } from '../../src/evm/EvmClient';

// ─── fetch mock helpers ───────────────────────────────────────────────────────

function mockFetchOk(result: unknown): void {
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ jsonrpc: '2.0', id: 1, result }),
    }),
  );
}

function mockFetchError(status: number, statusText: string): void {
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue({ ok: false, status, statusText }),
  );
}

function mockFetchRpcError(code: number, message: string): void {
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ jsonrpc: '2.0', id: 1, error: { code, message } }),
    }),
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
  it('returns gas price as bigint', async () => {
    mockFetchOk('0x3b9aca00'); // 1 Gwei
    expect(await new EvmClient('http://localhost').getGasPrice()).toBe(1_000_000_000n);
  });
});

// ─── EvmClient.sendRawTransaction ─────────────────────────────────────────────

describe('EvmClient.sendRawTransaction', () => {
  it('returns the transaction hash', async () => {
    const txHash = '0xdeadbeef01234567';
    mockFetchOk(txHash);
    expect(await new EvmClient('http://localhost').sendRawTransaction('0xsignedtx')).toBe(txHash);
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
      }),
    );

    const client = new EvmClient('http://localhost');
    const [chainId, blockNumber] = await client.batchRequest<[string, string]>([
      { method: 'eth_chainId' },
      { method: 'eth_blockNumber' },
    ]);

    // Results are sorted by id, so id=1 (chainId) comes first
    expect(chainId).toBe('0x15');
    expect(blockNumber).toBe('0x64');
  });
});

// ─── Error handling ───────────────────────────────────────────────────────────

describe('EvmClient error handling', () => {
  it('throws on non-OK HTTP response', async () => {
    mockFetchError(500, 'Internal Server Error');
    await expect(new EvmClient('http://localhost').getChainId()).rejects.toThrow('EVM HTTP 500');
  });

  it('throws on JSON-RPC error response', async () => {
    mockFetchRpcError(-32602, 'invalid params');
    await expect(new EvmClient('http://localhost').getChainId()).rejects.toThrow(
      'EVM RPC [-32602]: invalid params',
    );
  });

  it('throws when result is null', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ jsonrpc: '2.0', id: 1, result: null }),
      }),
    );
    await expect(new EvmClient('http://localhost').getChainId()).rejects.toThrow(
      'EVM RPC returned null result',
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
    const body = JSON.parse(
      (vi.mocked(fetch).mock.calls[0]?.[1]?.body ?? '') as string,
    ) as { params: [{ to: string; data: string; from?: string }, string] };
    expect(body.params[0].from).toBe('0xfrom');
  });

  it('omits from field when not provided', async () => {
    mockFetchOk('0x0');
    await new EvmClient('http://localhost').call('0xto', '0xdata');
    const body = JSON.parse(
      (vi.mocked(fetch).mock.calls[0]?.[1]?.body ?? '') as string,
    ) as { params: [{ to: string; data: string; from?: string }, string] };
    expect(body.params[0].from).toBeUndefined();
  });

  it('issues eth_call with latest block tag', async () => {
    mockFetchOk('0x0');
    await new EvmClient('http://localhost').call('0xto', '0xdata');
    const body = JSON.parse(
      (vi.mocked(fetch).mock.calls[0]?.[1]?.body ?? '') as string,
    ) as { method: string; params: unknown[] };
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
    const body = JSON.parse(
      (vi.mocked(fetch).mock.calls[0]?.[1]?.body ?? '') as string,
    ) as { method: string; params: unknown[] };
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
    // getTransactionReceipt calls request<...> which throws on null — stub full chain
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ jsonrpc: '2.0', id: 1, result: receipt }),
      }),
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
      }),
    );
    await new EvmClient('http://localhost').getTransactionReceipt('0xhash');
    const body = JSON.parse(
      (vi.mocked(fetch).mock.calls[0]?.[1]?.body ?? '') as string,
    ) as { method: string; params: string[] };
    expect(body.method).toBe('eth_getTransactionReceipt');
    expect(body.params[0]).toBe('0xhash');
  });
});
