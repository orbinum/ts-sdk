import { describe, it, expect } from 'vitest';
import {
    bigintTo32Le,
    bytesToBigintLE,
    bigintTo32Be,
    bigintTo32LeArr,
    computePathIndices,
    leHexToBigint,
} from '../../src/utils/bytes';

describe('bigintTo32Le', () => {
  it('encodes 0n as 32 zero bytes', () => {
    expect(bigintTo32Le(0n)).toEqual(new Uint8Array(32));
  });

  it('encodes 1n as [1, 0, 0, ...]', () => {
    const result = bigintTo32Le(1n);
    expect(result[0]).toBe(1);
    expect(result.slice(1)).toEqual(new Uint8Array(31));
  });

  it('encodes 256n as [0, 1, 0, ...]', () => {
    const result = bigintTo32Le(256n);
    expect(result[0]).toBe(0);
    expect(result[1]).toBe(1);
    expect(result.slice(2)).toEqual(new Uint8Array(30));
  });

  it('encodes 0xffn as [0xff, 0, ...]', () => {
    const result = bigintTo32Le(0xffn);
    expect(result[0]).toBe(0xff);
    expect(result.slice(1)).toEqual(new Uint8Array(31));
  });

  it('always returns exactly 32 bytes', () => {
    expect(bigintTo32Le(0n)).toHaveLength(32);
    expect(bigintTo32Le(1n)).toHaveLength(32);
    expect(bigintTo32Le(2n ** 255n)).toHaveLength(32);
  });

  it('roundtrips with bytesToBigintLE', () => {
    const values = [0n, 1n, 255n, 256n, 2n ** 128n, 2n ** 255n - 1n];
    for (const v of values) {
      expect(bytesToBigintLE(bigintTo32Le(v))).toBe(v);
    }
  });
});

describe('bytesToBigintLE', () => {
  it('decodes empty array to 0n', () => {
    expect(bytesToBigintLE(new Uint8Array(0))).toBe(0n);
  });

  it('decodes all-zero bytes to 0n', () => {
    expect(bytesToBigintLE(new Uint8Array(32))).toBe(0n);
  });

  it('decodes [1] to 1n', () => {
    expect(bytesToBigintLE(new Uint8Array([1]))).toBe(1n);
  });

  it('decodes [0, 1] to 256n (little-endian)', () => {
    expect(bytesToBigintLE(new Uint8Array([0, 1]))).toBe(256n);
  });

  it('decodes [0xff] to 255n', () => {
    expect(bytesToBigintLE(new Uint8Array([0xff]))).toBe(255n);
  });

  it('decodes max 32-byte value correctly', () => {
    const max = new Uint8Array(32).fill(0xff);
    expect(bytesToBigintLE(max)).toBe(2n ** 256n - 1n);
  });

  it('roundtrips with bigintTo32Le', () => {
    const values = [0n, 1n, 255n, 256n, 0xdeadbeefn, 2n ** 200n];
    for (const v of values) {
      expect(bytesToBigintLE(bigintTo32Le(v))).toBe(v);
    }
  });
});

describe('bigintTo32Be', () => {
  it('encodes 0n as 32 zero bytes', () => {
    expect(bigintTo32Be(0n)).toEqual(new Uint8Array(32));
  });

  it('encodes 1n as [..., 0, 1] (last byte)', () => {
    const result = bigintTo32Be(1n);
    expect(result[31]).toBe(1);
    expect(result.slice(0, 31)).toEqual(new Uint8Array(31));
  });

  it('encodes 256n as [..., 0, 1, 0] (byte 30 = 1, byte 31 = 0)', () => {
    const result = bigintTo32Be(256n);
    expect(result[31]).toBe(0);
    expect(result[30]).toBe(1);
    expect(result.slice(0, 30)).toEqual(new Uint8Array(30));
  });

  it('encodes 0xffn as [..., 0, 0xff]', () => {
    const result = bigintTo32Be(0xffn);
    expect(result[31]).toBe(0xff);
    expect(result.slice(0, 31)).toEqual(new Uint8Array(31));
  });

  it('always returns exactly 32 bytes', () => {
    expect(bigintTo32Be(0n)).toHaveLength(32);
    expect(bigintTo32Be(1n)).toHaveLength(32);
    expect(bigintTo32Be(2n ** 255n)).toHaveLength(32);
  });

  it('is the byte-reversal of bigintTo32Le', () => {
    const values = [0n, 1n, 255n, 256n, 0xdeadbeefn, 2n ** 200n];
    for (const v of values) {
      const le = bigintTo32Le(v);
      const be = bigintTo32Be(v);
      expect(be).toEqual(le.slice().reverse());
    }
  });

  it('produces correct ABI uint256 encoding for known values', () => {
    // uint256(1) in ABI = 31 zero bytes + 0x01
    const result = bigintTo32Be(1n);
    expect(result[31]).toBe(1);
    expect(result.slice(0, 31).every((b) => b === 0)).toBe(true);
  });
});

describe('bigintTo32LeArr', () => {
  it('returns an array of 32 numbers', () => {
    expect(bigintTo32LeArr(0n)).toHaveLength(32);
    expect(bigintTo32LeArr(1n)).toHaveLength(32);
  });

  it('encodes 0n as 32 zeros', () => {
    expect(bigintTo32LeArr(0n)).toEqual(new Array(32).fill(0));
  });

  it('encodes 1n as [1, 0, 0, ...]', () => {
    const result = bigintTo32LeArr(1n);
    expect(result[0]).toBe(1);
    expect(result.slice(1).every((b) => b === 0)).toBe(true);
  });

  it('encodes 256n as [0, 1, 0, ...]', () => {
    const result = bigintTo32LeArr(256n);
    expect(result[0]).toBe(0);
    expect(result[1]).toBe(1);
    expect(result.slice(2).every((b) => b === 0)).toBe(true);
  });

  it('matches bigintTo32Le byte by byte', () => {
    const values = [0n, 1n, 255n, 0xdeadbeefn, 2n ** 200n];
    for (const v of values) {
      const arr = bigintTo32LeArr(v);
      const u8 = bigintTo32Le(v);
      expect(arr).toEqual(Array.from(u8));
    }
  });
});

describe('computePathIndices', () => {
  it('returns an array of length `depth`', () => {
    expect(computePathIndices(0, 5)).toHaveLength(5);
    expect(computePathIndices(7, 10)).toHaveLength(10);
  });

  it('leaf 0 at any depth returns all zeros', () => {
    expect(computePathIndices(0, 4)).toEqual([0, 0, 0, 0]);
  });

  it('leaf 1 at depth 4 returns [1, 0, 0, 0]', () => {
    expect(computePathIndices(1, 4)).toEqual([1, 0, 0, 0]);
  });

  it('leaf 6 (0b110) at depth 4 returns [0, 1, 1, 0]', () => {
    expect(computePathIndices(6, 4)).toEqual([0, 1, 1, 0]);
  });

  it('leaf 7 (0b111) at depth 3 returns [1, 1, 1]', () => {
    expect(computePathIndices(7, 3)).toEqual([1, 1, 1]);
  });

  it('all returned values are 0 or 1', () => {
    for (let leaf = 0; leaf < 16; leaf++) {
      const idx = computePathIndices(leaf, 8);
      expect(idx.every((b) => b === 0 || b === 1)).toBe(true);
    }
  });
});

describe('leHexToBigint', () => {
  it('decodes 0x00 to 0n', () => {
    expect(leHexToBigint('0x00')).toBe(0n);
  });

  it('decodes bare 00 to 0n', () => {
    expect(leHexToBigint('00')).toBe(0n);
  });

  it('decodes 0x01 to 1n', () => {
    expect(leHexToBigint('0x01')).toBe(1n);
  });

  it('decodes 0x0001 (LE) to 256n', () => {
    expect(leHexToBigint('0x0001')).toBe(256n);
  });

  it('roundtrips with bigintTo32Le via hex', () => {
    const values = [0n, 1n, 255n, 256n, 0xdeadbeefn, 2n ** 200n];
    for (const v of values) {
      const bytes = bigintTo32Le(v);
      const hex =
        '0x' +
        Array.from(bytes)
          .map((b) => b.toString(16).padStart(2, '0'))
          .join('');
      expect(leHexToBigint(hex)).toBe(v);
    }
  });
});
