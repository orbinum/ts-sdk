import { describe, it, expect, vi } from 'vitest';
import { AccountMappingModule } from '../../src/account-mapping/AccountMappingModule';
import type { SubstrateClient } from '../../src/substrate/SubstrateClient';

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Build a SubstrateClient stub whose `request` returns the given value. */
function mockClient(result: unknown): SubstrateClient {
  return {
    request: vi.fn().mockResolvedValue(result),
  } as unknown as SubstrateClient;
}

/** Build a SubstrateClient stub whose `request` throws. */
function failingClient(): SubstrateClient {
  return {
    request: vi.fn().mockRejectedValue(new Error('RPC error')),
  } as unknown as SubstrateClient;
}

/** Build a SubstrateClient stub with an `unsafe.tx` structure for extrinsic tests. */
function txClient(pallet: string, call: string, mockSignAndSubmit: unknown): SubstrateClient {
  const signAndSubmit = vi.fn().mockResolvedValue(mockSignAndSubmit);
  const txEntry = vi.fn().mockReturnValue({ signAndSubmit });
  return {
    request: vi.fn(),
    unsafe: { tx: { [pallet]: { [call]: txEntry } } },
    _txEntry: txEntry,   // exposed for assertion
    _signAndSubmit: signAndSubmit,
  } as unknown as SubstrateClient;
}

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

// ─── getAccountAddresses ──────────────────────────────────────────────────────

describe('AccountMappingModule.getAccountAddresses', () => {
  it('returns mapped and fallback addresses', async () => {
    const client = mockClient({ mapped: '0xabc', fallback: '0xdef' });
    const mod = new AccountMappingModule(client);
    const result = await mod.getAccountAddresses('0xabc');
    expect(result).toEqual({ mapped: '0xabc', fallback: '0xdef' });
  });

  it('returns nulls when fields are null in response', async () => {
    const client = mockClient({ mapped: null, fallback: null });
    const mod = new AccountMappingModule(client);
    expect(await mod.getAccountAddresses('0x1234')).toEqual({ mapped: null, fallback: null });
  });

  it('returns nulls on RPC error', async () => {
    const mod = new AccountMappingModule(failingClient());
    expect(await mod.getAccountAddresses('0xerr')).toEqual({ mapped: null, fallback: null });
  });

  it('calls the correct RPC method', async () => {
    const client = mockClient({ mapped: null, fallback: null });
    const mod = new AccountMappingModule(client);
    await mod.getAccountAddresses('0xtest');
    expect(vi.mocked(client.request)).toHaveBeenCalledWith(
      'accountMapping_getAccountAddresses',
      ['0xtest'],
    );
  });
});

// ─── getMappedAccount ─────────────────────────────────────────────────────────

describe('AccountMappingModule.getMappedAccount', () => {
  it('returns the mapped account hex', async () => {
    const client = mockClient('0xsubstrate');
    const mod = new AccountMappingModule(client);
    expect(await mod.getMappedAccount('0xevm')).toBe('0xsubstrate');
  });

  it('normalizes the EVM address before sending', async () => {
    const client = mockClient(null);
    const mod = new AccountMappingModule(client);
    await mod.getMappedAccount('0xABCDEF1234567890abcdef1234567890ABCDEF12');
    expect(vi.mocked(client.request)).toHaveBeenCalledWith(
      'accountMapping_getMappedAccount',
      ['0xabcdef1234567890abcdef1234567890abcdef12'],
    );
  });

  it('returns null when no mapping exists', async () => {
    const mod = new AccountMappingModule(mockClient(null));
    expect(await mod.getMappedAccount('0x' + '00'.repeat(20))).toBeNull();
  });

  it('returns null on RPC error', async () => {
    expect(await new AccountMappingModule(failingClient()).getMappedAccount('0x1')).toBeNull();
  });
});

// ─── resolveAlias ─────────────────────────────────────────────────────────────

describe('AccountMappingModule.resolveAlias', () => {
  const rawAlias = {
    alias: '@alice',
    substrate_account: '0xowner',
    evm_address: '0xABCDEF1234567890ABCDEF1234567890ABCDEF12',
    chain_links_count: 2,
  };

  it('maps raw response to AliasInfo', async () => {
    const mod = new AccountMappingModule(mockClient(rawAlias));
    const result = await mod.resolveAlias('@alice');
    expect(result).toEqual({
      owner: '0xowner',
      evmAddress: '0xabcdef1234567890abcdef1234567890abcdef12',
      chainLinksCount: 2,
    });
  });

  it('normalizes evmAddress to lowercase', async () => {
    const mod = new AccountMappingModule(mockClient(rawAlias));
    const result = await mod.resolveAlias('@alice');
    expect(result?.evmAddress).toMatch(/^0x[0-9a-f]+$/);
  });

  it('sets evmAddress to null when absent', async () => {
    const mod = new AccountMappingModule(
      mockClient({ ...rawAlias, evm_address: null }),
    );
    const result = await mod.resolveAlias('@alice');
    expect(result?.evmAddress).toBeNull();
  });

  it('returns null when alias does not exist', async () => {
    expect(await new AccountMappingModule(mockClient(null)).resolveAlias('@unknown')).toBeNull();
  });

  it('returns null on RPC error', async () => {
    expect(await new AccountMappingModule(failingClient()).resolveAlias('@alice')).toBeNull();
  });
});

// ─── getAliasOf ───────────────────────────────────────────────────────────────

describe('AccountMappingModule.getAliasOf', () => {
  it('returns the alias string', async () => {
    const mod = new AccountMappingModule(mockClient('@alice'));
    expect(await mod.getAliasOf('0xaccountId')).toBe('@alice');
  });

  it('returns null when no alias', async () => {
    expect(await new AccountMappingModule(mockClient(null)).getAliasOf('0xid')).toBeNull();
  });

  it('returns null on RPC error', async () => {
    expect(await new AccountMappingModule(failingClient()).getAliasOf('0xid')).toBeNull();
  });
});

// ─── resolveFullIdentity ──────────────────────────────────────────────────────

describe('AccountMappingModule.resolveFullIdentity', () => {
  const rawFull = {
    owner: '0xowner',
    evm_address: '0xEVM1234567890abcdef1234567890abcdef123456',
    chain_links: [
      { chain_id: 60, address: '0xeth' },
      { chain_id: 501, address: 'solana_addr' },
    ],
    metadata: { display_name: 'Alice', bio: 'Builder', avatar: 'https://img' },
  };

  it('maps raw response to AliasFullIdentity', async () => {
    const mod = new AccountMappingModule(mockClient(rawFull));
    const result = await mod.resolveFullIdentity('@alice');
    expect(result?.owner).toBe('0xowner');
    expect(result?.chainLinks).toHaveLength(2);
    expect(result?.chainLinks[0]).toEqual({ chainId: 60, address: '0xeth' });
    expect(result?.metadata?.displayName).toBe('Alice');
  });

  it('sets metadata to null when absent', async () => {
    const mod = new AccountMappingModule(mockClient({ ...rawFull, metadata: null }));
    const result = await mod.resolveFullIdentity('@alice');
    expect(result?.metadata).toBeNull();
  });

  it('sets evmAddress to null when absent', async () => {
    const mod = new AccountMappingModule(mockClient({ ...rawFull, evm_address: null }));
    const result = await mod.resolveFullIdentity('@alice');
    expect(result?.evmAddress).toBeNull();
  });

  it('returns null when alias does not exist', async () => {
    expect(
      await new AccountMappingModule(mockClient(null)).resolveFullIdentity('@unknown'),
    ).toBeNull();
  });

  it('returns null on RPC error', async () => {
    expect(
      await new AccountMappingModule(failingClient()).resolveFullIdentity('@alice'),
    ).toBeNull();
  });

  it('calls accountMapping_resolveFullIdentity with the alias argument', async () => {
    const client = mockClient(rawFull);
    const mod = new AccountMappingModule(client);

    await mod.resolveFullIdentity('@alice');

    expect(vi.mocked(client.request)).toHaveBeenCalledWith(
      'accountMapping_resolveFullIdentity',
      ['@alice'],
    );
  });
});

// ─── getAccountMetadata ───────────────────────────────────────────────────────

describe('AccountMappingModule.getAccountMetadata', () => {
  it('maps raw response fields with null coalescing', async () => {
    const raw = { display_name: 'Bob', bio: null, avatar: 'https://av' };
    const mod = new AccountMappingModule(mockClient(raw));
    expect(await mod.getAccountMetadata('0xid')).toEqual({
      displayName: 'Bob',
      bio: null,
      avatar: 'https://av',
    });
  });

  it('returns null when no metadata', async () => {
    expect(await new AccountMappingModule(mockClient(null)).getAccountMetadata('0xid')).toBeNull();
  });

  it('returns null on RPC error', async () => {
    expect(await new AccountMappingModule(failingClient()).getAccountMetadata('0xid')).toBeNull();
  });
});

// ─── getLinkOwner ─────────────────────────────────────────────────────────────

describe('AccountMappingModule.getLinkOwner', () => {
  it('returns the owner account hex', async () => {
    const mod = new AccountMappingModule(mockClient('0xowner'));
    expect(await mod.getLinkOwner(60, '0xaddr')).toBe('0xowner');
  });

  it('returns null when not found', async () => {
    expect(await new AccountMappingModule(mockClient(null)).getLinkOwner(60, '0xaddr')).toBeNull();
  });

  it('returns null on RPC error', async () => {
    expect(await new AccountMappingModule(failingClient()).getLinkOwner(60, '0xaddr')).toBeNull();
  });
});

// ─── getSupportedChains ───────────────────────────────────────────────────────

describe('AccountMappingModule.getSupportedChains', () => {
  it('maps raw pairs to SupportedChain array', async () => {
    const raw = [[60, 'Eip191'], [501, 'Ed25519']] as [number, unknown][];
    const mod = new AccountMappingModule(mockClient(raw));
    const result = await mod.getSupportedChains();
    expect(result).toEqual([
      { chainId: 60, scheme: 'Eip191' },
      { chainId: 501, scheme: 'Ed25519' },
    ]);
  });

  it('normalises lowercase scheme variants', async () => {
    const mod = new AccountMappingModule(mockClient([[60, 'eip191']]));
    const result = await mod.getSupportedChains();
    expect(result[0]?.scheme).toBe('Eip191');
  });

  it('returns empty array on RPC error', async () => {
    expect(await new AccountMappingModule(failingClient()).getSupportedChains()).toEqual([]);
  });
});

// ─── getPrivateLinks ──────────────────────────────────────────────────────────

describe('AccountMappingModule.getPrivateLinks', () => {
  it('maps raw response to PrivateLink array', async () => {
    const raw = [
      { chain_id: 60, commitment: '0xcommit1' },
      { chain_id: 501, commitment: '0xcommit2' },
    ];
    const mod = new AccountMappingModule(mockClient(raw));
    const result = await mod.getPrivateLinks('@alice');
    expect(result).toEqual([
      { chainId: 60, commitment: '0xcommit1' },
      { chainId: 501, commitment: '0xcommit2' },
    ]);
  });

  it('returns null when alias does not exist', async () => {
    expect(await new AccountMappingModule(mockClient(null)).getPrivateLinks('@unknown')).toBeNull();
  });

  it('returns null on RPC error', async () => {
    expect(await new AccountMappingModule(failingClient()).getPrivateLinks('@alice')).toBeNull();
  });
});

// ─── hasPrivateLink ───────────────────────────────────────────────────────────

describe('AccountMappingModule.hasPrivateLink', () => {
  it('returns true when link exists', async () => {
    expect(
      await new AccountMappingModule(mockClient(true)).hasPrivateLink('@alice', '0xcommit'),
    ).toBe(true);
  });

  it('returns false when link does not exist', async () => {
    expect(
      await new AccountMappingModule(mockClient(false)).hasPrivateLink('@alice', '0xcommit'),
    ).toBe(false);
  });

  it('returns false on RPC error', async () => {
    expect(
      await new AccountMappingModule(failingClient()).hasPrivateLink('@alice', '0xcommit'),
    ).toBe(false);
  });
});

// ─── getListingInfo ───────────────────────────────────────────────────────────

describe('AccountMappingModule.getListingInfo', () => {
  it('maps price string to bigint', async () => {
    const raw = { alias: '@alice', price: '1000000000', private: false, whitelist_count: 0 };
    const mod = new AccountMappingModule(mockClient(raw));
    const result = await mod.getListingInfo('@alice');
    expect(result?.price).toBe(1_000_000_000n);
  });

  it('maps private flag and whitelist count', async () => {
    const raw = { alias: '@alice', price: '0', private: true, whitelist_count: 3 };
    const mod = new AccountMappingModule(mockClient(raw));
    const result = await mod.getListingInfo('@alice');
    expect(result?.private).toBe(true);
    expect(result?.whitelistCount).toBe(3);
  });

  it('returns null when not listed', async () => {
    expect(await new AccountMappingModule(mockClient(null)).getListingInfo('@alice')).toBeNull();
  });

  it('returns null on RPC error', async () => {
    expect(await new AccountMappingModule(failingClient()).getListingInfo('@alice')).toBeNull();
  });
});

// ─── getAccountListing ────────────────────────────────────────────────────────

describe('AccountMappingModule.getAccountListing', () => {
  it('maps raw response to AccountListing', async () => {
    const raw = { alias: '@bob', price: '500', private: false, whitelist_count: 0 };
    const mod = new AccountMappingModule(mockClient(raw));
    const result = await mod.getAccountListing('0xid');
    expect(result).toEqual({
      alias: '@bob',
      listing: { price: 500n, private: false, whitelistCount: 0 },
    });
  });

  it('returns null when account has no listing', async () => {
    expect(
      await new AccountMappingModule(mockClient(null)).getAccountListing('0xid'),
    ).toBeNull();
  });

  it('returns null on RPC error', async () => {
    expect(
      await new AccountMappingModule(failingClient()).getAccountListing('0xid'),
    ).toBeNull();
  });
});

// ─── canBuy ───────────────────────────────────────────────────────────────────

describe('AccountMappingModule.canBuy', () => {
  it('returns true when buyer is eligible', async () => {
    expect(await new AccountMappingModule(mockClient(true)).canBuy('@alice', '0xbuyer')).toBe(true);
  });

  it('returns false when buyer is not eligible', async () => {
    expect(
      await new AccountMappingModule(mockClient(false)).canBuy('@alice', '0xbuyer'),
    ).toBe(false);
  });

  it('returns false on RPC error', async () => {
    expect(await new AccountMappingModule(failingClient()).canBuy('@alice', '0xbuyer')).toBe(false);
  });
});

// ─── Extrinsics ───────────────────────────────────────────────────────────────

describe('AccountMappingModule extrinsics — toTxResult mapping', () => {
  const signer = {} as never;

  it('mapAccount: returns ok TxResult', async () => {
    const client = txClient('accountMapping', 'mapAccount', FINALIZED_OK);
    const mod = new AccountMappingModule(client);
    const result = await mod.mapAccount(signer);
    expect(result).toEqual({ txHash: '0xabc', blockHash: '0xblock', blockNumber: 42, ok: true });
  });

  it('mapAccount: includes error field when tx fails', async () => {
    const client = txClient('accountMapping', 'mapAccount', FINALIZED_ERR);
    const mod = new AccountMappingModule(client);
    const result = await mod.mapAccount(signer);
    expect(result.ok).toBe(false);
    expect(result.error).toBe('Module');
  });

  it('unmapAccount: submits correctly', async () => {
    const client = txClient('accountMapping', 'unmapAccount', FINALIZED_OK);
    const result = await new AccountMappingModule(client).unmapAccount(signer);
    expect(result.ok).toBe(true);
  });

  it('registerAlias: submits alias as Binary', async () => {
    const client = txClient('accountMapping', 'registerAlias', FINALIZED_OK);
    const mod = new AccountMappingModule(client);
    const result = await mod.registerAlias('alice', signer);
    expect(result.ok).toBe(true);
    const txEntry = (client as unknown as { _txEntry: ReturnType<typeof vi.fn> })._txEntry;
    expect(txEntry).toHaveBeenCalledOnce();
  });

  it('releaseAlias: submits correctly', async () => {
    const client = txClient('accountMapping', 'releaseAlias', FINALIZED_OK);
    expect((await new AccountMappingModule(client).releaseAlias(signer)).ok).toBe(true);
  });

  it('transferAlias: passes newOwnerHex', async () => {
    const client = txClient('accountMapping', 'transferAlias', FINALIZED_OK);
    const mod = new AccountMappingModule(client);
    await mod.transferAlias('0xnewowner', signer);
    const txEntry = (client as unknown as { _txEntry: ReturnType<typeof vi.fn> })._txEntry;
    expect(txEntry).toHaveBeenCalledWith('0xnewowner');
  });

  it('removeChainLink: passes chainId', async () => {
    const client = txClient('accountMapping', 'removeChainLink', FINALIZED_OK);
    const mod = new AccountMappingModule(client);
    await mod.removeChainLink(60, signer);
    const txEntry = (client as unknown as { _txEntry: ReturnType<typeof vi.fn> })._txEntry;
    expect(txEntry).toHaveBeenCalledWith(60);
  });

  it('resolveTx: throws a descriptive error for unknown pallet', async () => {
    const client = {
      request: vi.fn(),
      unsafe: { tx: {} },
    } as unknown as SubstrateClient;
    const mod = new AccountMappingModule(client);
    await expect(mod.mapAccount(signer)).rejects.toThrow(/Pallet "accountMapping" not found/);
  });
});
