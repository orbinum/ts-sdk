import { describe, it, expect, vi } from 'vitest';
import { ShieldedPoolModule } from '../../src/shielded-pool/ShieldedPoolModule';
import type { SubstrateClient } from '../../src/substrate/SubstrateClient';

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

// ─── shield ───────────────────────────────────────────────────────────────────

describe('ShieldedPoolModule.shield', () => {
  it('returns a TxResult on success', async () => {
    const mod = new ShieldedPoolModule(txClient('shield'));
    const result = await mod.shield(SHIELD_PARAMS, mockSigner);
    expect(result.txHash).toBe('0xabc');
    expect(result.ok).toBe(true);
    expect(result.blockNumber).toBe(42);
  });

  it('maps blockHash from block.hash', async () => {
    const mod = new ShieldedPoolModule(txClient('shield'));
    const result = await mod.shield(SHIELD_PARAMS, mockSigner);
    expect(result.blockHash).toBe('0xblock');
  });

  it('calls signAndSubmit with the provided signer', async () => {
    const client = txClient('shield');
    const mod = new ShieldedPoolModule(client);
    await mod.shield(SHIELD_PARAMS, mockSigner);
    expect(client._signAndSubmit).toHaveBeenCalledWith(mockSigner);
  });

  it('calls the shield tx entry exactly once', async () => {
    const client = txClient('shield');
    const mod = new ShieldedPoolModule(client);
    await mod.shield(SHIELD_PARAMS, mockSigner);
    expect(client._txEntry).toHaveBeenCalledTimes(1);
  });

  it('returns error info when tx fails', async () => {
    const client = txClient('shield', FINALIZED_ERR);
    const mod = new ShieldedPoolModule(client);
    const result = await mod.shield(SHIELD_PARAMS, mockSigner);
    expect(result.ok).toBe(false);
    expect((result as { error?: string }).error).toBe('Module');
  });

  it('throws when pallet is missing from runtime metadata', async () => {
    const client = { request: vi.fn(), unsafe: { tx: {} } } as unknown as SubstrateClient;
    const mod = new ShieldedPoolModule(client);
    await expect(mod.shield(SHIELD_PARAMS, mockSigner)).rejects.toThrow(/Pallet "shieldedPool" not found/);
  });

  it('throws when call is missing from pallet', async () => {
    const client = {
      request: vi.fn(),
      unsafe: { tx: { shieldedPool: {} } },
    } as unknown as SubstrateClient;
    const mod = new ShieldedPoolModule(client);
    await expect(mod.shield(SHIELD_PARAMS, mockSigner)).rejects.toThrow(/Call "shieldedPool.shield" not found/);
  });

  it('uses dummy memo when encryptedMemo is not provided', async () => {
    const client = txClient('shield');
    const mod = new ShieldedPoolModule(client);
    const params = { assetId: 0, amount: 100n, commitment: '0x' + 'ab'.repeat(32) };
    const result = await mod.shield(params, mockSigner);
    expect(result.ok).toBe(true);
  });
});

// ─── buildAndShield ───────────────────────────────────────────────────────────

describe('ShieldedPoolModule.buildAndShield', () => {
  it('returns { txResult, note } shape', async () => {
    const client = txClient('shield');
    const mod = new ShieldedPoolModule(client);
    const result = await mod.buildAndShield({ value: 500n, blinding: 1n }, mockSigner);
    expect(result).toHaveProperty('txResult');
    expect(result).toHaveProperty('note');
  });

  it('txResult is ok', async () => {
    const client = txClient('shield');
    const mod = new ShieldedPoolModule(client);
    const result = await mod.buildAndShield({ value: 500n, blinding: 1n }, mockSigner);
    expect(result.txResult.ok).toBe(true);
  });

  it('note has the correct value', async () => {
    const client = txClient('shield');
    const mod = new ShieldedPoolModule(client);
    const result = await mod.buildAndShield({ value: 999n, blinding: 1n }, mockSigner);
    expect(result.note.value).toBe(999n);
  });

  it('note has commitmentHex as 0x-prefixed 64-nibble string', async () => {
    const client = txClient('shield');
    const mod = new ShieldedPoolModule(client);
    const result = await mod.buildAndShield({ value: 1n, blinding: 1n }, mockSigner);
    expect(result.note.commitmentHex).toMatch(/^0x[0-9a-f]{64}$/);
  });

  it('forwards optional note fields', async () => {
    const client = txClient('shield');
    const mod = new ShieldedPoolModule(client);
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
    const mod = new ShieldedPoolModule(txClient('unshield'));
    const result = await mod.unshield(UNSHIELD_PARAMS, mockSigner);
    expect(result.ok).toBe(true);
    expect(result.txHash).toBe('0xabc');
  });

  it('calls the unshield tx entry exactly once', async () => {
    const client = txClient('unshield');
    const mod = new ShieldedPoolModule(client);
    await mod.unshield(UNSHIELD_PARAMS, mockSigner);
    expect(client._txEntry).toHaveBeenCalledTimes(1);
  });

  it('calls signAndSubmit with the signer', async () => {
    const client = txClient('unshield');
    const mod = new ShieldedPoolModule(client);
    await mod.unshield(UNSHIELD_PARAMS, mockSigner);
    expect(client._signAndSubmit).toHaveBeenCalledWith(mockSigner);
  });

  it('returns error info when tx fails', async () => {
    const client = txClient('unshield', FINALIZED_ERR);
    const mod = new ShieldedPoolModule(client);
    const result = await mod.unshield(UNSHIELD_PARAMS, mockSigner);
    expect(result.ok).toBe(false);
    expect((result as { error?: string }).error).toBe('Module');
  });

  it('throws when pallet is missing', async () => {
    const client = { request: vi.fn(), unsafe: { tx: {} } } as unknown as SubstrateClient;
    const mod = new ShieldedPoolModule(client);
    await expect(mod.unshield(UNSHIELD_PARAMS, mockSigner)).rejects.toThrow(/shieldedPool/);
  });
});

// ─── privateTransfer ──────────────────────────────────────────────────────────

describe('ShieldedPoolModule.privateTransfer', () => {
  it('returns a TxResult on success', async () => {
    const mod = new ShieldedPoolModule(txClient('privateTransfer'));
    const result = await mod.privateTransfer(TRANSFER_PARAMS, mockSigner);
    expect(result.ok).toBe(true);
    expect(result.txHash).toBe('0xabc');
  });

  it('calls the privateTransfer tx entry exactly once', async () => {
    const client = txClient('privateTransfer');
    const mod = new ShieldedPoolModule(client);
    await mod.privateTransfer(TRANSFER_PARAMS, mockSigner);
    expect(client._txEntry).toHaveBeenCalledTimes(1);
  });

  it('calls signAndSubmit with the signer', async () => {
    const client = txClient('privateTransfer');
    const mod = new ShieldedPoolModule(client);
    await mod.privateTransfer(TRANSFER_PARAMS, mockSigner);
    expect(client._signAndSubmit).toHaveBeenCalledWith(mockSigner);
  });

  it('returns error info when tx fails', async () => {
    const client = txClient('privateTransfer', FINALIZED_ERR);
    const mod = new ShieldedPoolModule(client);
    const result = await mod.privateTransfer(TRANSFER_PARAMS, mockSigner);
    expect(result.ok).toBe(false);
  });

  it('handles outputs without encryptedMemo (uses dummy)', async () => {
    const client = txClient('privateTransfer');
    const mod = new ShieldedPoolModule(client);
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
    const mod = new ShieldedPoolModule(client);
    await expect(mod.privateTransfer(TRANSFER_PARAMS, mockSigner)).rejects.toThrow(
      /Call "shieldedPool.privateTransfer" not found/
    );
  });
});

// ─── shieldBatch ──────────────────────────────────────────────────────────────

const BATCH_ITEM_A = {
  assetId: 0,
  amount: 100n,
  commitment: '0x' + 'ab'.repeat(32),
  encryptedMemo: new Uint8Array(104),
};

const BATCH_ITEM_B = {
  assetId: 1,
  amount: 200n,
  commitment: '0x' + 'cd'.repeat(32),
};

describe('ShieldedPoolModule.shieldBatch', () => {
  it('returns a TxResult on success', async () => {
    const mod = new ShieldedPoolModule(txClient('shieldBatch'));
    const result = await mod.shieldBatch({ items: [BATCH_ITEM_A] }, mockSigner);
    expect(result.ok).toBe(true);
    expect(result.txHash).toBe('0xabc');
    expect(result.blockNumber).toBe(42);
  });

  it('calls the shieldBatch tx entry exactly once', async () => {
    const client = txClient('shieldBatch');
    const mod = new ShieldedPoolModule(client);
    await mod.shieldBatch({ items: [BATCH_ITEM_A, BATCH_ITEM_B] }, mockSigner);
    expect(client._txEntry).toHaveBeenCalledTimes(1);
  });

  it('calls signAndSubmit with the signer', async () => {
    const client = txClient('shieldBatch');
    const mod = new ShieldedPoolModule(client);
    await mod.shieldBatch({ items: [BATCH_ITEM_A] }, mockSigner);
    expect(client._signAndSubmit).toHaveBeenCalledWith(mockSigner);
  });

  it('passes the correct number of operations to the tx entry', async () => {
    const client = txClient('shieldBatch');
    const mod = new ShieldedPoolModule(client);
    await mod.shieldBatch({ items: [BATCH_ITEM_A, BATCH_ITEM_B] }, mockSigner);
    const [ops] = client._txEntry.mock.calls[0] as [unknown[]];
    expect(ops).toHaveLength(2);
  });

  it('converts amount to string for SCALE encoding', async () => {
    const client = txClient('shieldBatch');
    const mod = new ShieldedPoolModule(client);
    await mod.shieldBatch({ items: [BATCH_ITEM_A] }, mockSigner);
    const [ops] = client._txEntry.mock.calls[0] as [Array<{ amount: unknown }>];
    expect(typeof ops[0]!.amount).toBe('string');
    expect(ops[0]!.amount).toBe('100');
  });

  it('uses a dummy memo when encryptedMemo is omitted', async () => {
    const client = txClient('shieldBatch');
    const mod = new ShieldedPoolModule(client);
    // BATCH_ITEM_B has no encryptedMemo — should succeed using dummy
    const result = await mod.shieldBatch({ items: [BATCH_ITEM_B] }, mockSigner);
    expect(result.ok).toBe(true);
  });

  it('returns error info when tx fails', async () => {
    const client = txClient('shieldBatch', FINALIZED_ERR);
    const mod = new ShieldedPoolModule(client);
    const result = await mod.shieldBatch({ items: [BATCH_ITEM_A] }, mockSigner);
    expect(result.ok).toBe(false);
    expect((result as { error?: string }).error).toBe('Module');
  });

  it('throws when pallet is missing', async () => {
    const client = { request: vi.fn(), unsafe: { tx: {} } } as unknown as SubstrateClient;
    const mod = new ShieldedPoolModule(client);
    await expect(mod.shieldBatch({ items: [BATCH_ITEM_A] }, mockSigner)).rejects.toThrow(
      /Pallet "shieldedPool" not found/
    );
  });

  it('throws when call is missing', async () => {
    const client = {
      request: vi.fn(),
      unsafe: { tx: { shieldedPool: {} } },
    } as unknown as SubstrateClient;
    const mod = new ShieldedPoolModule(client);
    await expect(mod.shieldBatch({ items: [BATCH_ITEM_A] }, mockSigner)).rejects.toThrow(
      /Call "shieldedPool.shieldBatch" not found/
    );
  });
});

