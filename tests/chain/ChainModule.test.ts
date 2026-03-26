import { describe, it, expect, vi } from 'vitest';
import { ChainModule } from '../../src/chain/ChainModule';
import type { SubstrateClient } from '../../src/substrate/SubstrateClient';
import type { EvmClient } from '../../src/evm/EvmClient';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function mockSubstrate(results: unknown[]): SubstrateClient {
  const request = vi.fn();
  results.forEach((r) => request.mockResolvedValueOnce(r));
  return { request } as unknown as SubstrateClient;
}

function failingSubstrate(): SubstrateClient {
  return {
    request: vi.fn().mockRejectedValue(new Error('RPC error')),
  } as unknown as SubstrateClient;
}

function mockEvm(overrides: Partial<EvmClient> = {}): EvmClient {
  return {
    getChainId: vi.fn().mockResolvedValue(777),
    getBlockNumber: vi.fn().mockResolvedValue(1234),
    ...overrides,
  } as unknown as EvmClient;
}

// ─── getChainInfo ─────────────────────────────────────────────────────────────

describe('ChainModule.getChainInfo', () => {
  it('returns name, version and ss58Prefix from parallel RPC calls', async () => {
    const substrate = mockSubstrate([
      'Orbinum Node',
      { specName: 'orbinum', specVersion: 10042, implName: 'orbinum', ss58Prefix: 10 },
    ]);
    const mod = new ChainModule(substrate, null);
    expect(await mod.getChainInfo()).toEqual({
      name: 'Orbinum Node',
      version: '10042',
      ss58Prefix: 10,
    });
  });

  it('defaults ss58Prefix to 42 when absent', async () => {
    const substrate = mockSubstrate([
      'TestNet',
      { specName: 'test', specVersion: 1, implName: 'test' },
    ]);
    const mod = new ChainModule(substrate, null);
    const info = await mod.getChainInfo();
    expect(info.ss58Prefix).toBe(42);
  });

  it('issues system_name and state_getRuntimeVersion', async () => {
    const substrate = mockSubstrate([
      'Node',
      { specName: 'x', specVersion: 1, implName: 'x' },
    ]);
    const mod = new ChainModule(substrate, null);
    await mod.getChainInfo();
    expect(vi.mocked(substrate.request)).toHaveBeenCalledWith('system_name', []);
    expect(vi.mocked(substrate.request)).toHaveBeenCalledWith('state_getRuntimeVersion', []);
  });
});

// ─── getHealth ────────────────────────────────────────────────────────────────

describe('ChainModule.getHealth', () => {
  it('returns the raw health object', async () => {
    const health = { peers: 5, isSyncing: false, shouldHavePeers: true };
    const mod = new ChainModule(mockSubstrate([health]), null);
    expect(await mod.getHealth()).toEqual(health);
  });

  it('issues system_health with empty params', async () => {
    const substrate = mockSubstrate([{ peers: 0, isSyncing: true, shouldHavePeers: false }]);
    await new ChainModule(substrate, null).getHealth();
    expect(vi.mocked(substrate.request)).toHaveBeenCalledWith('system_health', []);
  });
});

// ─── getNodeVersion ───────────────────────────────────────────────────────────

describe('ChainModule.getNodeVersion', () => {
  it('returns the version string', async () => {
    const mod = new ChainModule(mockSubstrate(['0.9.42-dev']), null);
    expect(await mod.getNodeVersion()).toBe('0.9.42-dev');
  });

  it('issues system_version with empty params', async () => {
    const substrate = mockSubstrate(['1.0.0']);
    await new ChainModule(substrate, null).getNodeVersion();
    expect(vi.mocked(substrate.request)).toHaveBeenCalledWith('system_version', []);
  });
});

// ─── getGenesisHash ───────────────────────────────────────────────────────────

describe('ChainModule.getGenesisHash', () => {
  it('returns the genesis hash hex', async () => {
    const hash = '0x' + 'a'.repeat(64);
    const mod = new ChainModule(mockSubstrate([hash]), null);
    expect(await mod.getGenesisHash()).toBe(hash);
  });

  it('requests block hash at index 0', async () => {
    const substrate = mockSubstrate(['0x00']);
    await new ChainModule(substrate, null).getGenesisHash();
    expect(vi.mocked(substrate.request)).toHaveBeenCalledWith('chain_getBlockHash', [0]);
  });
});

// ─── getFullIdentity ──────────────────────────────────────────────────────────

describe('ChainModule.getFullIdentity', () => {
  it('maps raw keys to FullIdentityInfo', async () => {
    const raw = {
      substrate_address: '0xsubstrate',
      evm_address: '0xABCDEF1234567890ABCDEF1234567890ABCDEF12',
      alias: '@alice',
    };
    const mod = new ChainModule(mockSubstrate([raw]), null);
    const result = await mod.getFullIdentity('0xsubstrate');
    expect(result).toEqual({
      substrateAddress: '0xsubstrate',
      evmAddress: '0xabcdef1234567890abcdef1234567890abcdef12',
      alias: '@alice',
    });
  });

  it('normalizes evmAddress to lowercase', async () => {
    const raw = {
      substrate_address: null,
      evm_address: '0xABCDEF1234567890ABCDEF1234567890ABCDEF12',
      alias: null,
    };
    const mod = new ChainModule(mockSubstrate([raw]), null);
    const result = await mod.getFullIdentity('0x1');
    expect(result?.evmAddress).toMatch(/^0x[0-9a-f]+$/);
  });

  it('sets evmAddress to null when absent', async () => {
    const raw = { substrate_address: '0xsub', evm_address: null, alias: null };
    const mod = new ChainModule(mockSubstrate([raw]), null);
    expect((await mod.getFullIdentity('0xsub'))?.evmAddress).toBeNull();
  });

  it('sets alias to null when absent', async () => {
    const raw = { substrate_address: '0xsub', evm_address: null, alias: null };
    const mod = new ChainModule(mockSubstrate([raw]), null);
    expect((await mod.getFullIdentity('0xsub'))?.alias).toBeNull();
  });

  it('returns null when identity does not exist', async () => {
    expect(await new ChainModule(mockSubstrate([null]), null).getFullIdentity('0x1')).toBeNull();
  });

  it('returns null on RPC error', async () => {
    expect(await new ChainModule(failingSubstrate(), null).getFullIdentity('0x1')).toBeNull();
  });
});

// ─── getMappedAccountByEvm ────────────────────────────────────────────────────

describe('ChainModule.getMappedAccountByEvm', () => {
  it('returns the mapped substrate account hex', async () => {
    const mod = new ChainModule(mockSubstrate(['0xsub']), null);
    expect(await mod.getMappedAccountByEvm('0xevm')).toBe('0xsub');
  });

  it('normalizes the EVM address before sending', async () => {
    const substrate = mockSubstrate([null]);
    await new ChainModule(substrate, null).getMappedAccountByEvm(
      '0xABCDEF1234567890ABCDEF1234567890ABCDEF12',
    );
    expect(vi.mocked(substrate.request)).toHaveBeenCalledWith(
      'accountMapping_getMappedAccount',
      ['0xabcdef1234567890abcdef1234567890abcdef12'],
    );
  });

  it('returns null when no mapping exists', async () => {
    expect(
      await new ChainModule(mockSubstrate([null]), null).getMappedAccountByEvm('0xevm'),
    ).toBeNull();
  });

  it('returns null on RPC error', async () => {
    expect(
      await new ChainModule(failingSubstrate(), null).getMappedAccountByEvm('0xevm'),
    ).toBeNull();
  });
});

// ─── getAliasOf ───────────────────────────────────────────────────────────────

describe('ChainModule.getAliasOf', () => {
  it('returns the alias string', async () => {
    const mod = new ChainModule(mockSubstrate(['@alice']), null);
    expect(await mod.getAliasOf('0xsub')).toBe('@alice');
  });

  it('returns null when no alias registered', async () => {
    expect(await new ChainModule(mockSubstrate([null]), null).getAliasOf('0xsub')).toBeNull();
  });

  it('returns null on RPC error', async () => {
    expect(await new ChainModule(failingSubstrate(), null).getAliasOf('0xsub')).toBeNull();
  });

  it('issues accountMapping_getAliasOf', async () => {
    const substrate = mockSubstrate([null]);
    await new ChainModule(substrate, null).getAliasOf('0xtest');
    expect(vi.mocked(substrate.request)).toHaveBeenCalledWith('accountMapping_getAliasOf', [
      '0xtest',
    ]);
  });
});

// ─── getEvmChainId ────────────────────────────────────────────────────────────

describe('ChainModule.getEvmChainId', () => {
  it('returns the EVM chain ID', async () => {
    const mod = new ChainModule(mockSubstrate([]), mockEvm({ getChainId: vi.fn().mockResolvedValue(42) }));
    expect(await mod.getEvmChainId()).toBe(42);
  });

  it('throws when no EVM client is configured', async () => {
    const mod = new ChainModule(mockSubstrate([]), null);
    await expect(mod.getEvmChainId()).rejects.toThrow(/No EVM RPC URL configured/);
  });
});

// ─── getEvmBlockNumber ────────────────────────────────────────────────────────

describe('ChainModule.getEvmBlockNumber', () => {
  it('returns the current EVM block number', async () => {
    const mod = new ChainModule(
      mockSubstrate([]),
      mockEvm({ getBlockNumber: vi.fn().mockResolvedValue(9999) }),
    );
    expect(await mod.getEvmBlockNumber()).toBe(9999);
  });

  it('throws when no EVM client is configured', async () => {
    const mod = new ChainModule(mockSubstrate([]), null);
    await expect(mod.getEvmBlockNumber()).rejects.toThrow(/No EVM RPC URL configured/);
  });
});
