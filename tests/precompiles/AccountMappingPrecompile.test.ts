import { describe, it, expect, vi, afterEach } from 'vitest';
import { AccountMappingPrecompile } from '../../src/precompiles/AccountMappingPrecompile';
import { AM_SEL, PRECOMPILE_ADDR } from '../../src/precompiles/addresses';
import { toHex } from '../../src/utils/hex';
import type { EvmClient } from '../../src/evm/EvmClient';
import type { EvmSigner } from '../../src/precompiles/ShieldedPoolPrecompile';

// ─── Mock helpers ─────────────────────────────────────────────────────────────

function mockEvm(callResult: string = '0x'): EvmClient {
  return {
    call: vi.fn().mockResolvedValue(callResult),
    estimateGas: vi.fn(),
  } as unknown as EvmClient;
}

function mockEvmFailing(): EvmClient {
  return {
    call: vi.fn().mockRejectedValue(new Error('eth_call failed')),
  } as unknown as EvmClient;
}

/** Build a 32-byte ABI address slot (right-aligned, bytes 12-31). */
function addressSlot(hex: string): Uint8Array {
  const s = new Uint8Array(32);
  const clean = hex.startsWith('0x') ? hex.slice(2) : hex;
  for (let i = 0; i < 20; i++) {
    s[12 + i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  }
  return s;
}

/** Build a 64-byte ABI response with two address slots. */
function twoAddressResponse(owner: string, evm: string): string {
  const buf = new Uint8Array(64);
  buf.set(addressSlot(owner), 0);
  buf.set(addressSlot(evm), 32);
  return toHex(buf);
}

/** Build an ABI dynamic bytes/string response for a single string param. */
function dynamicStringResponse(text: string): string {
  const encoded = new TextEncoder().encode(text);
  const padLen = encoded.length % 32 === 0 ? encoded.length : encoded.length + (32 - (encoded.length % 32));

  const ptr = new Uint8Array(32); ptr[31] = 32;          // pointer = 32
  const len = new Uint8Array(32); len[31] = encoded.length; // length
  const data = new Uint8Array(padLen); data.set(encoded);

  const buf = new Uint8Array(32 + 32 + padLen);
  buf.set(ptr, 0);
  buf.set(len, 32);
  buf.set(data, 64);
  return toHex(buf);
}

/** Build a 32-byte bool response. */
function boolResponse(value: boolean): string {
  const buf = new Uint8Array(32);
  buf[31] = value ? 1 : 0;
  return toHex(buf);
}

const ZERO_ADDR = '0x0000000000000000000000000000000000000000';
const OWNER_ADDR = '0xabcdef1234567890abcdef1234567890abcdef12';
const EVM_ADDR   = '0x1234567890abcdef1234567890abcdef12345678';

afterEach(() => vi.clearAllMocks());

// ─── resolveAlias ─────────────────────────────────────────────────────────────

describe('AccountMappingPrecompile.resolveAlias', () => {
  it('returns owner and evmAddress from ABI response', async () => {
    const evm = mockEvm(twoAddressResponse(OWNER_ADDR, EVM_ADDR));
    const result = await new AccountMappingPrecompile(evm).resolveAlias('@alice');
    expect(result?.owner).toBe(OWNER_ADDR);
    expect(result?.evmAddress).toBe(EVM_ADDR);
  });

  it('sets evmAddress to null when zero address', async () => {
    const evm = mockEvm(twoAddressResponse(OWNER_ADDR, ZERO_ADDR));
    const result = await new AccountMappingPrecompile(evm).resolveAlias('@alice');
    expect(result?.evmAddress).toBeNull();
  });

  it('normalizes evmAddress to lowercase', async () => {
    const upper = '0xABCDEF1234567890ABCDEF1234567890ABCDEF12';
    const evm = mockEvm(twoAddressResponse(OWNER_ADDR, upper));
    const result = await new AccountMappingPrecompile(evm).resolveAlias('@alice');
    expect(result?.evmAddress).toMatch(/^0x[0-9a-f]+$/);
  });

  it('returns null if response is shorter than 64 bytes', async () => {
    const evm = mockEvm(toHex(new Uint8Array(32))); // only 32 bytes
    expect(await new AccountMappingPrecompile(evm).resolveAlias('@alice')).toBeNull();
  });

  it('returns null on eth_call error', async () => {
    expect(
      await new AccountMappingPrecompile(mockEvmFailing()).resolveAlias('@alice'),
    ).toBeNull();
  });

  it('calls the ACCOUNT_MAPPING precompile address', async () => {
    const evm = mockEvm(twoAddressResponse(OWNER_ADDR, EVM_ADDR));
    await new AccountMappingPrecompile(evm).resolveAlias('@alice');
    expect(vi.mocked(evm.call).mock.calls[0]?.[0]).toBe(PRECOMPILE_ADDR.ACCOUNT_MAPPING);
  });

  it('calldata starts with RESOLVE_ALIAS selector', async () => {
    const evm = mockEvm(twoAddressResponse(OWNER_ADDR, EVM_ADDR));
    await new AccountMappingPrecompile(evm).resolveAlias('@alice');
    const calldata = vi.mocked(evm.call).mock.calls[0]?.[1] as string;
    expect(calldata.startsWith(toHex(AM_SEL.RESOLVE_ALIAS))).toBe(true);
  });
});

// ─── getAliasOf ───────────────────────────────────────────────────────────────

describe('AccountMappingPrecompile.getAliasOf', () => {
  it('returns alias string from ABI dynamic bytes response', async () => {
    const evm = mockEvm(dynamicStringResponse('@alice'));
    expect(await new AccountMappingPrecompile(evm).getAliasOf(EVM_ADDR)).toBe('@alice');
  });

  it('returns null when response is empty', async () => {
    expect(await new AccountMappingPrecompile(mockEvm('0x')).getAliasOf(EVM_ADDR)).toBeNull();
  });

  it('returns null when alias string is empty', async () => {
    const evm = mockEvm(dynamicStringResponse(''));
    expect(await new AccountMappingPrecompile(evm).getAliasOf(EVM_ADDR)).toBeNull();
  });

  it('returns null on eth_call error', async () => {
    expect(await new AccountMappingPrecompile(mockEvmFailing()).getAliasOf(EVM_ADDR)).toBeNull();
  });

  it('normalizes evmAddress to lowercase before encoding', async () => {
    const evm = mockEvm(dynamicStringResponse('@bob'));
    const upper = '0xABCDEF1234567890ABCDEF1234567890ABCDEF12';
    await new AccountMappingPrecompile(evm).getAliasOf(upper);
    // calldata must NOT contain uppercase hex address
    const calldata = vi.mocked(evm.call).mock.calls[0]?.[1] as string;
    expect(calldata).not.toContain('ABCDEF');
  });

  it('calldata starts with GET_ALIAS_OF selector', async () => {
    const evm = mockEvm(dynamicStringResponse('@bob'));
    await new AccountMappingPrecompile(evm).getAliasOf(EVM_ADDR);
    const calldata = vi.mocked(evm.call).mock.calls[0]?.[1] as string;
    expect(calldata.startsWith(toHex(AM_SEL.GET_ALIAS_OF))).toBe(true);
  });
});

// ─── hasPrivateLink ───────────────────────────────────────────────────────────

describe('AccountMappingPrecompile.hasPrivateLink', () => {
  it('returns true when link exists', async () => {
    const evm = mockEvm(boolResponse(true));
    expect(
      await new AccountMappingPrecompile(evm).hasPrivateLink('@alice', '0x' + 'aa'.repeat(32)),
    ).toBe(true);
  });

  it('returns false when link does not exist', async () => {
    const evm = mockEvm(boolResponse(false));
    expect(
      await new AccountMappingPrecompile(evm).hasPrivateLink('@alice', '0x' + 'bb'.repeat(32)),
    ).toBe(false);
  });

  it('returns false if response is shorter than 32 bytes', async () => {
    const evm = mockEvm(toHex(new Uint8Array(16)));
    expect(
      await new AccountMappingPrecompile(evm).hasPrivateLink('@alice', '0x' + '00'.repeat(32)),
    ).toBe(false);
  });

  it('returns false on eth_call error', async () => {
    expect(
      await new AccountMappingPrecompile(mockEvmFailing()).hasPrivateLink('@alice', '0x01'),
    ).toBe(false);
  });

  it('calldata starts with HAS_PRIVATE_LINK selector', async () => {
    const evm = mockEvm(boolResponse(false));
    await new AccountMappingPrecompile(evm).hasPrivateLink('@alice', '0x' + '00'.repeat(32));
    const calldata = vi.mocked(evm.call).mock.calls[0]?.[1] as string;
    expect(calldata.startsWith(toHex(AM_SEL.HAS_PRIVATE_LINK))).toBe(true);
  });
});

// ─── No-arg write methods ─────────────────────────────────────────────────────

const SELECTORS = {
  mapAccount:    AM_SEL.MAP_ACCOUNT,
  unmapAccount:  AM_SEL.UNMAP_ACCOUNT,
  releaseAlias:  AM_SEL.RELEASE_ALIAS,
  cancelSale:    AM_SEL.CANCEL_SALE,
} as const;

for (const [method, sel] of Object.entries(SELECTORS)) {
  describe(`AccountMappingPrecompile.${method}`, () => {
    it('calls signer with ACCOUNT_MAPPING address', async () => {
      const signer: EvmSigner = vi.fn().mockResolvedValue('0xtxhash');
      const precompile = new AccountMappingPrecompile(mockEvm());
      await (precompile as unknown as Record<string, (s: EvmSigner) => Promise<string>>)[method]!(signer);
      const callArg = (vi.mocked(signer).mock.calls[0]?.[0]);
      expect(callArg?.to).toBe(PRECOMPILE_ADDR.ACCOUNT_MAPPING);
    });

    it(`calldata equals encodeHex of ${method} selector`, async () => {
      const signer: EvmSigner = vi.fn().mockResolvedValue('0xtxhash');
      const precompile = new AccountMappingPrecompile(mockEvm());
      await (precompile as unknown as Record<string, (s: EvmSigner) => Promise<string>>)[method]!(signer);
      const callArg = (vi.mocked(signer).mock.calls[0]?.[0]);
      expect(callArg?.data.startsWith(toHex(sel))).toBe(true);
    });

    it('returns the tx hash from signer', async () => {
      const signer: EvmSigner = vi.fn().mockResolvedValue('0xdeadbeef');
      const precompile = new AccountMappingPrecompile(mockEvm());
      const result = await (precompile as unknown as Record<string, (s: EvmSigner) => Promise<string>>)[method]!(signer);
      expect(result).toBe('0xdeadbeef');
    });
  });
}

// ─── Write methods with arguments ────────────────────────────────────────────

describe('AccountMappingPrecompile.registerAlias', () => {
  it('calls signer with ACCOUNT_MAPPING address', async () => {
    const signer: EvmSigner = vi.fn().mockResolvedValue('0xtx');
    await new AccountMappingPrecompile(mockEvm()).registerAlias('@alice', signer);
    expect(vi.mocked(signer).mock.calls[0]?.[0]?.to).toBe(PRECOMPILE_ADDR.ACCOUNT_MAPPING);
  });

  it('calldata starts with REGISTER_ALIAS selector', async () => {
    const signer: EvmSigner = vi.fn().mockResolvedValue('0xtx');
    await new AccountMappingPrecompile(mockEvm()).registerAlias('@alice', signer);
    const data = vi.mocked(signer).mock.calls[0]?.[0]?.data as string;
    expect(data.startsWith(toHex(AM_SEL.REGISTER_ALIAS))).toBe(true);
  });
});

describe('AccountMappingPrecompile.transferAlias', () => {
  it('calldata starts with TRANSFER_ALIAS selector', async () => {
    const signer: EvmSigner = vi.fn().mockResolvedValue('0xtx');
    await new AccountMappingPrecompile(mockEvm()).transferAlias(EVM_ADDR, signer);
    const data = vi.mocked(signer).mock.calls[0]?.[0]?.data as string;
    expect(data.startsWith(toHex(AM_SEL.TRANSFER_ALIAS))).toBe(true);
  });
});
