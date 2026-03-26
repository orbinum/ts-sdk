import { describe, it, expect } from 'vitest';
import { toHex, fromHex, ensureHexPrefix, hexToNumber, hexToBigint } from '../../src/utils/hex';

describe('toHex', () => {
  it('encodes empty array to "0x"', () => {
    expect(toHex(new Uint8Array())).toBe('0x');
  });

  it('encodes bytes to lowercase hex with 0x prefix', () => {
    expect(toHex(new Uint8Array([0, 1, 255]))).toBe('0x0001ff');
  });

  it('pads single-nibble bytes', () => {
    expect(toHex(new Uint8Array([10, 15]))).toBe('0x0a0f');
  });

  it('roundtrips with fromHex', () => {
    const original = new Uint8Array([0xde, 0xad, 0xbe, 0xef]);
    expect(fromHex(toHex(original))).toEqual(original);
  });
});

describe('fromHex', () => {
  it('decodes 0x-prefixed string', () => {
    expect(fromHex('0x0001ff')).toEqual(new Uint8Array([0, 1, 255]));
  });

  it('decodes unprefixed string', () => {
    expect(fromHex('0001ff')).toEqual(new Uint8Array([0, 1, 255]));
  });

  it('decodes empty string to empty array', () => {
    expect(fromHex('')).toEqual(new Uint8Array());
  });

  it('decodes "0x" to empty array', () => {
    expect(fromHex('0x')).toEqual(new Uint8Array());
  });

  it('throws on odd-length hex string', () => {
    expect(() => fromHex('0x0')).toThrow(/odd length/);
  });

  it('throws on invalid hex character', () => {
    expect(() => fromHex('0xzz')).toThrow();
  });

  it('decodes full byte range 0x00–0xff', () => {
    const bytes = new Uint8Array(256);
    for (let i = 0; i < 256; i++) bytes[i] = i;
    expect(fromHex(toHex(bytes))).toEqual(bytes);
  });
});

describe('ensureHexPrefix', () => {
  it('adds 0x when missing', () => {
    expect(ensureHexPrefix('aabb')).toBe('0xaabb');
  });

  it('keeps 0x when already present', () => {
    expect(ensureHexPrefix('0xaabb')).toBe('0xaabb');
  });

  it('handles empty string', () => {
    expect(ensureHexPrefix('')).toBe('0x');
  });

  it('does not double-prefix', () => {
    expect(ensureHexPrefix('0x0x')).toBe('0x0x');
  });
});

describe('hexToNumber', () => {
  it('converts 0x-prefixed hex to number', () => {
    expect(hexToNumber('0x1')).toBe(1);
    expect(hexToNumber('0xff')).toBe(255);
    expect(hexToNumber('0x100')).toBe(256);
  });

  it('converts unprefixed hex to number', () => {
    expect(hexToNumber('ff')).toBe(255);
    expect(hexToNumber('10')).toBe(16);
  });

  it('converts 0x0 to 0', () => {
    expect(hexToNumber('0x0')).toBe(0);
  });

  it('handles typical JSON-RPC block number', () => {
    expect(hexToNumber('0x4b7')).toBe(1207);
  });

  it('handles large block numbers', () => {
    expect(hexToNumber('0xf4240')).toBe(1000000);
  });
});

describe('hexToBigint', () => {
  it('converts 0x-prefixed hex to bigint', () => {
    expect(hexToBigint('0x1')).toBe(1n);
    expect(hexToBigint('0xff')).toBe(255n);
  });

  it('converts 0x0 to 0n', () => {
    expect(hexToBigint('0x0')).toBe(0n);
  });

  it('handles typical wei balance', () => {
    // 1 ETH in wei = 1_000_000_000_000_000_000
    expect(hexToBigint('0xde0b6b3a7640000')).toBe(1_000_000_000_000_000_000n);
  });

  it('handles very large values without precision loss', () => {
    const large = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;
    const asHex = '0x' + large.toString(16);
    expect(hexToBigint(asHex)).toBe(large);
  });
});
