import { describe, it, expect } from 'vitest';
import {
    normalizeEvmAddress,
    isSs58,
    isEvmAddress,
    evmAddressToAccountId,
    evmToImplicitSubstrate,
    isImplicitEvmAccount,
    implicitSubstrateToEvm,
    isSubstrateAddress,
    isUnifiedAddress,
    substrateToEvm,
    evmToSubstrate,
    accountIdHexToSs58,
    substrateSs58ToAccountIdHex,
    addressToAccountIdHex,
} from '../../src/utils/address';

describe('normalizeEvmAddress', () => {
  it('lowercases and keeps 0x prefix', () => {
    expect(normalizeEvmAddress('0xABCDEF1234567890abcdef1234567890ABCDEF12')).toBe(
      '0xabcdef1234567890abcdef1234567890abcdef12',
    );
  });

  it('adds 0x prefix when missing', () => {
    expect(normalizeEvmAddress('AABB')).toBe('0xaabb');
  });

  it('handles already-normalized address', () => {
    const addr = '0xabcdef1234567890abcdef1234567890abcdef12';
    expect(normalizeEvmAddress(addr)).toBe(addr);
  });
});

describe('isSs58', () => {
  it('returns true for a typical Substrate SS58 address (47 chars)', () => {
    // Alice's SS58 on Substrate (default prefix 42)
    expect(isSs58('5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY')).toBe(true);
  });

  it('returns false for a 0x-prefixed EVM address', () => {
    expect(isSs58('0xabcdef1234567890abcdef1234567890abcdef12')).toBe(false);
  });

  it('returns false for a short string', () => {
    expect(isSs58('short')).toBe(false);
  });

  it('returns false for a string with 0x prefix regardless of length', () => {
    expect(isSs58('0x' + 'a'.repeat(48))).toBe(false);
  });
});

describe('isEvmAddress', () => {
  it('returns true for a valid lowercase EVM address', () => {
    expect(isEvmAddress('0xabcdef1234567890abcdef1234567890abcdef12')).toBe(true);
  });

  it('returns true for uppercase EVM address', () => {
    expect(isEvmAddress('0xABCDEF1234567890ABCDEF1234567890ABCDEF12')).toBe(true);
  });

  it('returns true for mixed-case (EIP-55 checksum)', () => {
    expect(isEvmAddress('0xAbCdEf1234567890AbCdEF1234567890aBCDeF12')).toBe(true);
  });

  it('returns false for too short', () => {
    expect(isEvmAddress('0xabc')).toBe(false);
  });

  it('returns false for too long', () => {
    expect(isEvmAddress('0x' + 'a'.repeat(42))).toBe(false);
  });

  it('returns false for missing 0x prefix', () => {
    expect(isEvmAddress('abcdef1234567890abcdef1234567890abcdef12')).toBe(false);
  });

  it('returns false for non-hex characters', () => {
    expect(isEvmAddress('0xZZZZef1234567890abcdef1234567890abcdef12')).toBe(false);
  });
});

describe('evmAddressToAccountId', () => {
  it('returns a 32-byte array', () => {
    const result = evmAddressToAccountId('0x' + '00'.repeat(20));
    expect(result).toHaveLength(32);
    expect(result).toBeInstanceOf(Uint8Array);
  });

  it('places zero address as trailing 20 bytes (all zeros)', () => {
    const result = evmAddressToAccountId('0x' + '00'.repeat(20));
    expect(result).toEqual(new Uint8Array(32));
  });

  it('places address bytes starting at offset 12', () => {
    // 0xff followed by 19 zero bytes
    const result = evmAddressToAccountId('0xff' + '00'.repeat(19));
    expect(result[0]).toBe(0x00); // leading padding
    expect(result[11]).toBe(0x00); // last padding byte
    expect(result[12]).toBe(0xff); // first address byte
    expect(result[31]).toBe(0x00); // last address byte
  });

  it('preserves all 20 address bytes correctly', () => {
    const addrBytes = new Uint8Array(20);
    for (let i = 0; i < 20; i++) addrBytes[i] = i + 1;
    const hex = '0x' + Array.from(addrBytes, (b) => b.toString(16).padStart(2, '0')).join('');
    const result = evmAddressToAccountId(hex);
    expect(result.slice(12)).toEqual(addrBytes);
    expect(result.slice(0, 12)).toEqual(new Uint8Array(12));
  });

  it('throws for a non 20-byte address', () => {
    expect(() => evmAddressToAccountId('0xabc')).toThrow(/Expected 20-byte/);
  });

  it('accepts address without 0x prefix', () => {
    const result = evmAddressToAccountId('ff' + '00'.repeat(19));
    expect(result[12]).toBe(0xff);
  });
});

describe('evmToImplicitSubstrate', () => {
  it('appends 24 zero hex chars (12 bytes) to the EVM address', () => {
    const evm = '0xabcdef1234567890abcdef1234567890abcdef12';
    const result = evmToImplicitSubstrate(evm);
    expect(result).toBe('0xabcdef1234567890abcdef1234567890abcdef12' + '0'.repeat(24));
  });

  it('lowercases the EVM part', () => {
    const result = evmToImplicitSubstrate('0xABCDEF1234567890ABCDEF1234567890ABCDEF12');
    expect(result.slice(2, 42)).toBe('abcdef1234567890abcdef1234567890abcdef12');
  });

  it('produces a 66-char 0x-prefixed string (32 bytes)', () => {
    const result = evmToImplicitSubstrate('0x' + 'ab'.repeat(20));
    expect(result).toHaveLength(66);
    expect(result.startsWith('0x')).toBe(true);
  });

  it('accepts address without 0x prefix', () => {
    const result = evmToImplicitSubstrate('ff' + '00'.repeat(19));
    expect(result).toBe('0x' + 'ff' + '00'.repeat(19) + '0'.repeat(24));
  });

  it('throws for wrong-length input', () => {
    expect(() => evmToImplicitSubstrate('0x1234')).toThrow(/Expected 20-byte/);
  });
});

describe('isImplicitEvmAccount', () => {
  it('returns true when last 12 bytes are zero', () => {
    const account = '0x' + 'ab'.repeat(20) + '0'.repeat(24);
    expect(isImplicitEvmAccount(account)).toBe(true);
  });

  it('returns false when last 12 bytes are not zero', () => {
    const account = '0x' + 'ab'.repeat(20) + 'ff'.repeat(12);
    expect(isImplicitEvmAccount(account)).toBe(false);
  });

  it('returns false for wrong total length', () => {
    expect(isImplicitEvmAccount('0xaabb')).toBe(false);
  });

  it('accepts account without 0x prefix', () => {
    const account = 'ab'.repeat(20) + '0'.repeat(24);
    expect(isImplicitEvmAccount(account)).toBe(true);
  });

  it('is case-insensitive for the trailing zeros check', () => {
    const account = '0x' + 'AB'.repeat(20) + '0'.repeat(24);
    expect(isImplicitEvmAccount(account)).toBe(true);
  });
});

describe('implicitSubstrateToEvm', () => {
  it('extracts the first 20 bytes as a 0x-prefixed lowercase EVM address', () => {
    const evm = '0xabcdef1234567890abcdef1234567890abcdef12';
    const account = evmToImplicitSubstrate(evm);
    expect(implicitSubstrateToEvm(account)).toBe(evm);
  });

  it('lowercases the result', () => {
    const account = '0x' + 'AB'.repeat(20) + '0'.repeat(24);
    const result = implicitSubstrateToEvm(account);
    expect(result).toBe('0x' + 'ab'.repeat(20));
  });

  it('roundtrips with evmToImplicitSubstrate', () => {
    const evm = '0x' + 'de'.repeat(20);
    expect(implicitSubstrateToEvm(evmToImplicitSubstrate(evm))).toBe(evm);
  });

  it('throws for non EVM-derived accounts', () => {
    const account = '0x' + 'ab'.repeat(20) + 'ff'.repeat(12);
    expect(() => implicitSubstrateToEvm(account)).toThrow(/not an implicit EVM/);
  });
});

// ─── isSubstrateAddress ───────────────────────────────────────────────────────

// Known Alice SS58 (prefix 42) from @polkadot test vectors
const ALICE_SS58 = '5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY';

describe('isSubstrateAddress', () => {
  it('returns true for a valid SS58 address', () => {
    expect(isSubstrateAddress(ALICE_SS58)).toBe(true);
  });

  it('returns false for an EVM address', () => {
    expect(isSubstrateAddress('0xd43593c715fdd31c61141abd04a99fd6822c8558')).toBe(false);
  });

  it('returns false for empty string', () => {
    expect(isSubstrateAddress('')).toBe(false);
  });

  it('returns false for a short string', () => {
    expect(isSubstrateAddress('abc')).toBe(false);
  });
});

// ─── isUnifiedAddress ─────────────────────────────────────────────────────────

describe('isUnifiedAddress', () => {
  it('returns true for an EVM address mapped to Substrate', () => {
    // Create a unified address: 20-byte evm + 12 zero bytes
    const evm = '0xd43593c715fdd31c61141abd04a99fd6822c8558';
    const unified = evmToSubstrate(evm);
    expect(unified).not.toBeNull();
    expect(isUnifiedAddress(unified!)).toBe(true);
  });

  it('returns false for a native Substrate address', () => {
    expect(isUnifiedAddress(ALICE_SS58)).toBe(false);
  });

  it('returns false for an EVM address', () => {
    expect(isUnifiedAddress('0x1234567890abcdef1234567890abcdef12345678')).toBe(false);
  });
});

// ─── substrateToEvm ───────────────────────────────────────────────────────────

describe('substrateToEvm', () => {
  it('converts unified SS58 → EVM H160', () => {
    const evm = '0xd43593c715fdd31c61141abd04a99fd6822c8558';
    const ss58 = evmToSubstrate(evm);
    expect(ss58).not.toBeNull();
    expect(substrateToEvm(ss58!)).toBe(evm);
  });

  it('returns null for a native Substrate address', () => {
    expect(substrateToEvm(ALICE_SS58)).toBeNull();
  });

  it('returns the same EVM address if given EVM input', () => {
    const evm = '0xd43593c715fdd31c61141abd04a99fd6822c8558';
    expect(substrateToEvm(evm)).toBe(evm);
  });
});

// ─── evmToSubstrate ───────────────────────────────────────────────────────────

describe('evmToSubstrate', () => {
  it('produces a valid unified SS58 from an EVM address', () => {
    const evm = '0xd43593c715fdd31c61141abd04a99fd6822c8558';
    const ss58 = evmToSubstrate(evm);
    expect(ss58).not.toBeNull();
    expect(isUnifiedAddress(ss58!)).toBe(true);
  });

  it('returns null for invalid input', () => {
    expect(evmToSubstrate('not-an-address')).toBeNull();
    expect(evmToSubstrate('')).toBeNull();
  });

  it('roundtrips with substrateToEvm', () => {
    const evm = '0x' + 'ab'.repeat(20);
    const ss58 = evmToSubstrate(evm)!;
    expect(substrateToEvm(ss58)).toBe(evm);
  });
});

// ─── accountIdHexToSs58 ───────────────────────────────────────────────────────

describe('accountIdHexToSs58', () => {
  it('encodes 32-byte hex to SS58', () => {
    const hex = substrateSs58ToAccountIdHex(ALICE_SS58);
    expect(hex).not.toBeNull();
    expect(accountIdHexToSs58(hex!)).toBe(ALICE_SS58);
  });

  it('returns null for wrong-length hex', () => {
    expect(accountIdHexToSs58('0x1234')).toBeNull();
  });

  it('returns null for empty string', () => {
    expect(accountIdHexToSs58('')).toBeNull();
  });
});

// ─── substrateSs58ToAccountIdHex ─────────────────────────────────────────────

describe('substrateSs58ToAccountIdHex', () => {
  it('returns 0x-prefixed 64-char hex for a valid SS58', () => {
    const hex = substrateSs58ToAccountIdHex(ALICE_SS58);
    expect(hex).toMatch(/^0x[0-9a-f]{64}$/);
  });

  it('returns null for empty string', () => {
    expect(substrateSs58ToAccountIdHex('')).toBeNull();
  });

  it('roundtrips with accountIdHexToSs58', () => {
    const hex = substrateSs58ToAccountIdHex(ALICE_SS58)!;
    expect(accountIdHexToSs58(hex)).toBe(ALICE_SS58);
  });
});

// ─── addressToAccountIdHex ────────────────────────────────────────────────────

describe('addressToAccountIdHex', () => {
  it('handles SS58 input', () => {
    const expected = substrateSs58ToAccountIdHex(ALICE_SS58);
    expect(addressToAccountIdHex(ALICE_SS58)).toBe(expected);
  });

  it('handles EVM H160 input (mapped)', () => {
    const evm = '0xd43593c715fdd31c61141abd04a99fd6822c8558';
    const result = addressToAccountIdHex(evm);
    expect(result).toMatch(/^0x[0-9a-f]{64}$/);
    // First 40 hex chars = evm address, last 24 = zeros
    expect(result!.slice(2, 42)).toBe(evm.slice(2).toLowerCase());
    expect(result!.slice(42)).toBe('0'.repeat(24));
  });

  it('handles 0x-prefixed 64-char hex as pass-through', () => {
    const hex = '0x' + 'ab'.repeat(32);
    expect(addressToAccountIdHex(hex)).toBe(hex.toLowerCase());
  });

  it('returns null for empty string', () => {
    expect(addressToAccountIdHex('')).toBeNull();
  });
});
