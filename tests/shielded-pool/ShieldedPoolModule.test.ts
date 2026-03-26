import { describe, it, expect, vi } from 'vitest';
import { ShieldedPoolModule } from '../../src/shielded-pool/ShieldedPoolModule';
import type { SubstrateClient } from '../../src/substrate/SubstrateClient';
import type { MerkleModule } from '../../src/shielded-pool/MerkleModule';

// ─── Helpers ──────────────────────────────────────────────────────────────────

const FINALIZED_OK: unknown = {
  txHash: '0xabc',
  ok: true,
  block: { hash: '0xblock', number: 42 },
};

const FINALIZED_ERR: unknown = {
  txHash: '0xerr',
  ok: false,
  block: { hash: '0xblock', number: 99 },
  dispatchError: { type: 'Module' },
};

/** Stub with a single tx call in shieldedPool pallet. */
function txClient(call: string, payload: unknown = FINALIZED_OK): SubstrateClient & {
  _txEntry: ReturnType<typeof vi.fn>;
  _signAndSubmit: ReturnType<typeof vi.fn>;
} {
  const signAndSubmit = vi.fn().mockResolvedValue(payload);
  const txEntry = vi.fn().mockReturnValue({ signAndSubmit });
  return {
    request: vi.fn(),
    unsafe: { tx: { shieldedPool: { [call]: txEntry } } },
    _txEntry: txEntry,
    _signAndSubmit: signAndSubmit,
  } as unknown as SubstrateClient & {
    _txEntry: ReturnType<typeof vi.fn>;
    _signAndSubmit: ReturnType<typeof vi.fn>;
  };
}

/** Stub for query-only tests. */
function queryClient(result: unknown): SubstrateClient {
  return {
    request: vi.fn().mockResolvedValue(result),
  } as unknown as SubstrateClient;
}

function failingQueryClient(): SubstrateClient {
  return {
    request: vi.fn().mockRejectedValue(new Error('RPC error')),
  } as unknown as SubstrateClient;
}

const mockMerkle = {} as MerkleModule;
const mockSigner = {} as never;

// Common test params
const SHIELD_PARAMS = {
  assetId: 0,
  amount: 1000n,
  commitment: '0x' + 'ab'.repeat(32),
  encryptedMemo: new Uint8Array(104),
};

const UNSHIELD_PARAMS = {
  proof: new Uint8Array(32),
  merkleRoot: '0x' + 'cd'.repeat(32),
  nullifier: '0x' + 'ef'.repeat(32),
  assetId: 0,
  amount: 500n,
  recipientAddress: '0x' + '12'.repeat(32),
};

const TRANSFER_PARAMS = {
  inputs: [
    { nullifier: '0x' + 'aa'.repeat(32), commitment: '0x' + 'bb'.repeat(32) },
    { nullifier: '0x' + 'cc'.repeat(32), commitment: '0x' + 'dd'.repeat(32) },
  ],
  outputs: [
    { commitment: '0x' + 'ee'.repeat(32), encryptedMemo: new Uint8Array(104) },
    { commitment: '0x' + 'ff'.repeat(32) },
  ],
  proof: new Uint8Array(32),
  merkleRoot: '0x' + 'a1'.repeat(32),
};

// ─── constructor / merkle access ──────────────────────────────────────────────

describe('ShieldedPoolModule constructor', () => {
  it('exposes the merkle module', () => {
    const mod = new ShieldedPoolModule(txClient('shield'), mockMerkle);
    expect(mod.merkle).toBe(mockMerkle);
  });
});

// ─── shield ───────────────────────────────────────────────────────────────────

describe('ShieldedPoolModule.shield', () => {
  it('returns a TxResult on success', async () => {
    const mod = new ShieldedPoolModule(txClient('shield'), mockMerkle);
    const result = await mod.shield(SHIELD_PARAMS, mockSigner);
    expect(result.txHash).toBe('0xabc');
    expect(result.ok).toBe(true);
    expect(result.blockNumber).toBe(42);
  });

  it('maps blockHash from block.hash', async () => {
    const mod = new ShieldedPoolModule(txClient('shield'), mockMerkle);
    const result = await mod.shield(SHIELD_PARAMS, mockSigner);
    expect(result.blockHash).toBe('0xblock');
  });

  it('calls signAndSubmit with the provided signer', async () => {
    const client = txClient('shield');
    const mod = new ShieldedPoolModule(client, mockMerkle);
    await mod.shield(SHIELD_PARAMS, mockSigner);
    expect(client._signAndSubmit).toHaveBeenCalledWith(mockSigner);
  });

  it('calls the shield tx entry exactly once', async () => {
    const client = txClient('shield');
    const mod = new ShieldedPoolModule(client, mockMerkle);
    await mod.shield(SHIELD_PARAMS, mockSigner);
    expect(client._txEntry).toHaveBeenCalledTimes(1);
  });

  it('returns error info when tx fails', async () => {
    const client = txClient('shield', FINALIZED_ERR);
    const mod = new ShieldedPoolModule(client, mockMerkle);
    const result = await mod.shield(SHIELD_PARAMS, mockSigner);
    expect(result.ok).toBe(false);
    expect((result as { error?: string }).error).toBe('Module');
  });

  it('throws when pallet is missing from runtime metadata', async () => {
    const client = { request: vi.fn(), unsafe: { tx: {} } } as unknown as SubstrateClient;
    const mod = new ShieldedPoolModule(client, mockMerkle);
    await expect(mod.shield(SHIELD_PARAMS, mockSigner)).rejects.toThrow(/Pallet "shieldedPool" not found/);
  });

  it('throws when call is missing from pallet', async () => {
    const client = {
      request: vi.fn(),
      unsafe: { tx: { shieldedPool: {} } },
    } as unknown as SubstrateClient;
    const mod = new ShieldedPoolModule(client, mockMerkle);
    await expect(mod.shield(SHIELD_PARAMS, mockSigner)).rejects.toThrow(/Call "shieldedPool.shield" not found/);
  });

  it('uses dummy memo when encryptedMemo is not provided', async () => {
    const client = txClient('shield');
    const mod = new ShieldedPoolModule(client, mockMerkle);
    const params = { assetId: 0, amount: 100n, commitment: '0x' + 'ab'.repeat(32) };
    const result = await mod.shield(params, mockSigner);
    expect(result.ok).toBe(true);
  });
});

// ─── buildAndShield ───────────────────────────────────────────────────────────

describe('ShieldedPoolModule.buildAndShield', () => {
  it('returns { txResult, note } shape', async () => {
    const client = txClient('shield');
    const mod = new ShieldedPoolModule(client, mockMerkle);
    const result = await mod.buildAndShield({ value: 500n, blinding: 1n }, mockSigner);
    expect(result).toHaveProperty('txResult');
    expect(result).toHaveProperty('note');
  });

  it('txResult is ok', async () => {
    const client = txClient('shield');
    const mod = new ShieldedPoolModule(client, mockMerkle);
    const result = await mod.buildAndShield({ value: 500n, blinding: 1n }, mockSigner);
    expect(result.txResult.ok).toBe(true);
  });

  it('note has the correct value', async () => {
    const client = txClient('shield');
    const mod = new ShieldedPoolModule(client, mockMerkle);
    const result = await mod.buildAndShield({ value: 999n, blinding: 1n }, mockSigner);
    expect(result.note.value).toBe(999n);
  });

  it('note has commitmentHex as 0x-prefixed 64-nibble string', async () => {
    const client = txClient('shield');
    const mod = new ShieldedPoolModule(client, mockMerkle);
    const result = await mod.buildAndShield({ value: 1n, blinding: 1n }, mockSigner);
    expect(result.note.commitmentHex).toMatch(/^0x[0-9a-f]{64}$/);
  });

  it('forwards optional note fields', async () => {
    const client = txClient('shield');
    const mod = new ShieldedPoolModule(client, mockMerkle);
    const result = await mod.buildAndShield(
      { value: 10n, assetId: 1, ownerPk: 0n, blinding: 2n, spendingKey: 3n },
      mockSigner
    );
    expect(result.note.assetId).toBe(1n);
    expect(result.note.spendingKey).toBe(3n);
  });
});

// ─── unshield ─────────────────────────────────────────────────────────────────

describe('ShieldedPoolModule.unshield', () => {
  it('returns a TxResult on success', async () => {
    const mod = new ShieldedPoolModule(txClient('unshield'), mockMerkle);
    const result = await mod.unshield(UNSHIELD_PARAMS, mockSigner);
    expect(result.ok).toBe(true);
    expect(result.txHash).toBe('0xabc');
  });

  it('calls the unshield tx entry exactly once', async () => {
    const client = txClient('unshield');
    const mod = new ShieldedPoolModule(client, mockMerkle);
    await mod.unshield(UNSHIELD_PARAMS, mockSigner);
    expect(client._txEntry).toHaveBeenCalledTimes(1);
  });

  it('calls signAndSubmit with the signer', async () => {
    const client = txClient('unshield');
    const mod = new ShieldedPoolModule(client, mockMerkle);
    await mod.unshield(UNSHIELD_PARAMS, mockSigner);
    expect(client._signAndSubmit).toHaveBeenCalledWith(mockSigner);
  });

  it('returns error info when tx fails', async () => {
    const client = txClient('unshield', FINALIZED_ERR);
    const mod = new ShieldedPoolModule(client, mockMerkle);
    const result = await mod.unshield(UNSHIELD_PARAMS, mockSigner);
    expect(result.ok).toBe(false);
    expect((result as { error?: string }).error).toBe('Module');
  });

  it('throws when pallet is missing', async () => {
    const client = { request: vi.fn(), unsafe: { tx: {} } } as unknown as SubstrateClient;
    const mod = new ShieldedPoolModule(client, mockMerkle);
    await expect(mod.unshield(UNSHIELD_PARAMS, mockSigner)).rejects.toThrow(/shieldedPool/);
  });
});

// ─── privateTransfer ──────────────────────────────────────────────────────────

describe('ShieldedPoolModule.privateTransfer', () => {
  it('returns a TxResult on success', async () => {
    const mod = new ShieldedPoolModule(txClient('privateTransfer'), mockMerkle);
    const result = await mod.privateTransfer(TRANSFER_PARAMS, mockSigner);
    expect(result.ok).toBe(true);
    expect(result.txHash).toBe('0xabc');
  });

  it('calls the privateTransfer tx entry exactly once', async () => {
    const client = txClient('privateTransfer');
    const mod = new ShieldedPoolModule(client, mockMerkle);
    await mod.privateTransfer(TRANSFER_PARAMS, mockSigner);
    expect(client._txEntry).toHaveBeenCalledTimes(1);
  });

  it('calls signAndSubmit with the signer', async () => {
    const client = txClient('privateTransfer');
    const mod = new ShieldedPoolModule(client, mockMerkle);
    await mod.privateTransfer(TRANSFER_PARAMS, mockSigner);
    expect(client._signAndSubmit).toHaveBeenCalledWith(mockSigner);
  });

  it('returns error info when tx fails', async () => {
    const client = txClient('privateTransfer', FINALIZED_ERR);
    const mod = new ShieldedPoolModule(client, mockMerkle);
    const result = await mod.privateTransfer(TRANSFER_PARAMS, mockSigner);
    expect(result.ok).toBe(false);
  });

  it('handles outputs without encryptedMemo (uses dummy)', async () => {
    const client = txClient('privateTransfer');
    const mod = new ShieldedPoolModule(client, mockMerkle);
    const params = {
      ...TRANSFER_PARAMS,
      outputs: [{ commitment: '0x' + 'ee'.repeat(32) }],
    };
    const result = await mod.privateTransfer(params, mockSigner);
    expect(result.ok).toBe(true);
  });

  it('throws when call is missing', async () => {
    const client = {
      request: vi.fn(),
      unsafe: { tx: { shieldedPool: {} } },
    } as unknown as SubstrateClient;
    const mod = new ShieldedPoolModule(client, mockMerkle);
    await expect(mod.privateTransfer(TRANSFER_PARAMS, mockSigner)).rejects.toThrow(
      /Call "shieldedPool.privateTransfer" not found/
    );
  });
});

// ─── isNullifierSpent ─────────────────────────────────────────────────────────

describe('ShieldedPoolModule.isNullifierSpent', () => {
  it('returns true when is_spent is true', async () => {
    const mod = new ShieldedPoolModule(queryClient({ is_spent: true }), mockMerkle);
    expect(await mod.isNullifierSpent('0xnull')).toBe(true);
  });

  it('returns false when is_spent is false', async () => {
    const mod = new ShieldedPoolModule(queryClient({ is_spent: false }), mockMerkle);
    expect(await mod.isNullifierSpent('0xnull')).toBe(false);
  });

  it('calls the correct RPC method with the nullifier hex', async () => {
    const client = queryClient({ is_spent: false });
    const mod = new ShieldedPoolModule(client, mockMerkle);
    await mod.isNullifierSpent('0xdeadbeef');
    expect(vi.mocked(client.request)).toHaveBeenCalledWith(
      'privacy_getNullifierStatus',
      ['0xdeadbeef'],
    );
  });

  it('propagates RPC errors', async () => {
    const mod = new ShieldedPoolModule(failingQueryClient(), mockMerkle);
    await expect(mod.isNullifierSpent('0x1')).rejects.toThrow('RPC error');
  });
});

// ─── getNullifierStatus ───────────────────────────────────────────────────────

describe('ShieldedPoolModule.getNullifierStatus', () => {
  const RAW = { nullifier: '0xnull', is_spent: true };

  it('returns NullifierStatus with camelCase fields', async () => {
    const mod = new ShieldedPoolModule(queryClient(RAW), mockMerkle);
    const status = await mod.getNullifierStatus('0xnull');
    expect(status).toEqual({ nullifier: '0xnull', isSpent: true });
  });

  it('isSpent is false when not spent', async () => {
    const mod = new ShieldedPoolModule(queryClient({ nullifier: '0xabc', is_spent: false }), mockMerkle);
    const status = await mod.getNullifierStatus('0xabc');
    expect(status.isSpent).toBe(false);
  });

  it('calls the correct RPC method', async () => {
    const client = queryClient(RAW);
    const mod = new ShieldedPoolModule(client, mockMerkle);
    await mod.getNullifierStatus('0xnull');
    expect(vi.mocked(client.request)).toHaveBeenCalledWith(
      'privacy_getNullifierStatus',
      ['0xnull'],
    );
  });
});

// ─── getPoolBalance ───────────────────────────────────────────────────────────

describe('ShieldedPoolModule.getPoolBalance', () => {
  it('returns PoolBalance with BigInt balance from string', async () => {
    const mod = new ShieldedPoolModule(queryClient({ balance: '5000' }), mockMerkle);
    const result = await mod.getPoolBalance(0);
    expect(result).toEqual({ assetId: 0, balance: 5000n });
  });

  it('returns PoolBalance with BigInt balance from number', async () => {
    const mod = new ShieldedPoolModule(queryClient({ balance: 1234 }), mockMerkle);
    const result = await mod.getPoolBalance(1);
    expect(result).toEqual({ assetId: 1, balance: 1234n });
  });

  it('includes the correct assetId in the result', async () => {
    const mod = new ShieldedPoolModule(queryClient({ balance: '0' }), mockMerkle);
    const result = await mod.getPoolBalance(42);
    expect(result.assetId).toBe(42);
  });

  it('calls the correct RPC method with the assetId', async () => {
    const client = queryClient({ balance: '0' });
    const mod = new ShieldedPoolModule(client, mockMerkle);
    await mod.getPoolBalance(3);
    expect(vi.mocked(client.request)).toHaveBeenCalledWith(
      'shieldedPool_getPoolBalance',
      [3],
    );
  });

  it('propagates RPC errors', async () => {
    const mod = new ShieldedPoolModule(failingQueryClient(), mockMerkle);
    await expect(mod.getPoolBalance(0)).rejects.toThrow('RPC error');
  });
});

// ─── getPoolStats ─────────────────────────────────────────────────────────────

describe('ShieldedPoolModule.getPoolStats', () => {
  const MOCK_TREE_INFO = { root: '0xabc', treeSize: 5, depth: 20 };

  /** Merkle module stub that resolves to MOCK_TREE_INFO. */
  function merkleWithInfo(): MerkleModule {
    return {
      getTreeInfo: vi.fn().mockResolvedValue(MOCK_TREE_INFO),
    } as unknown as MerkleModule;
  }

  it('returns merkle and balance combined', async () => {
    const mod = new ShieldedPoolModule(queryClient({ balance: '9000' }), merkleWithInfo());
    const stats = await mod.getPoolStats(0);
    expect(stats.merkle).toEqual(MOCK_TREE_INFO);
    expect(stats.balance).toEqual({ assetId: 0, balance: 9000n });
  });

  it('defaults assetId to 0', async () => {
    const client = queryClient({ balance: '1' });
    const mod = new ShieldedPoolModule(client, merkleWithInfo());
    const stats = await mod.getPoolStats();
    expect(stats.balance.assetId).toBe(0);
  });

  it('passes custom assetId to getPoolBalance', async () => {
    const client = queryClient({ balance: '1' });
    const mod = new ShieldedPoolModule(client, merkleWithInfo());
    const stats = await mod.getPoolStats(7);
    expect(stats.balance.assetId).toBe(7);
    expect(vi.mocked(client.request)).toHaveBeenCalledWith('shieldedPool_getPoolBalance', [7]);
  });

  it('propagates RPC errors from getPoolBalance', async () => {
    const mod = new ShieldedPoolModule(failingQueryClient(), merkleWithInfo());
    await expect(mod.getPoolStats()).rejects.toThrow('RPC error');
  });

  it('propagates errors from merkle.getTreeInfo', async () => {
    const badMerkle = {
      getTreeInfo: vi.fn().mockRejectedValue(new Error('Merkle error')),
    } as unknown as MerkleModule;
    const mod = new ShieldedPoolModule(queryClient({ balance: '1' }), badMerkle);
    await expect(mod.getPoolStats()).rejects.toThrow('Merkle error');
  });
});
