import { describe, it, expect, vi } from 'vitest';
import { CryptoPrecompiles } from '../../src/precompiles/CryptoPrecompiles';
import { PRECOMPILE_ADDR } from '../../src/precompiles/addresses';
import { toHex } from '../../src/utils/hex';
import type { EvmClient } from '../../src/evm/EvmClient';

// ─── Mock helpers ─────────────────────────────────────────────────────────────

function mockEvm(callResult: string): EvmClient {
  return {
    call: vi.fn().mockResolvedValue(callResult),
  } as unknown as EvmClient;
}

/** Build a 32-byte hex string with all bytes set to `v`. */
function hex32(v = 0xab): string {
  return toHex(new Uint8Array(32).fill(v));
}

// ─── sha256 ───────────────────────────────────────────────────────────────────

describe('CryptoPrecompiles.sha256', () => {
  it('returns the bytes from the precompile response', async () => {
    const digest = new Uint8Array(32).fill(0xcc);
    const evm = mockEvm(toHex(digest));
    const result = await new CryptoPrecompiles(evm).sha256(new Uint8Array([1, 2, 3]));
    expect(result).toEqual(digest);
  });

  it('calls SHA256 precompile address', async () => {
    const evm = mockEvm(hex32());
    await new CryptoPrecompiles(evm).sha256(new Uint8Array([1]));
    expect(vi.mocked(evm.call).mock.calls[0]?.[0]).toBe(PRECOMPILE_ADDR.SHA256);
  });

  it('passes input as hex to eth_call', async () => {
    const evm = mockEvm(hex32());
    const data = new Uint8Array([0xde, 0xad]);
    await new CryptoPrecompiles(evm).sha256(data);
    expect(vi.mocked(evm.call).mock.calls[0]?.[1]).toBe(toHex(data));
  });
});

// ─── keccak256 ────────────────────────────────────────────────────────────────

describe('CryptoPrecompiles.keccak256', () => {
  it('returns the bytes from the precompile response', async () => {
    const digest = new Uint8Array(32).fill(0xdd);
    const evm = mockEvm(toHex(digest));
    const result = await new CryptoPrecompiles(evm).keccak256(new Uint8Array([1]));
    expect(result).toEqual(digest);
  });

  it('calls SHA3_FIPS256 precompile address', async () => {
    const evm = mockEvm(hex32());
    await new CryptoPrecompiles(evm).keccak256(new Uint8Array([1]));
    expect(vi.mocked(evm.call).mock.calls[0]?.[0]).toBe(PRECOMPILE_ADDR.SHA3_FIPS256);
  });
});

// ─── ripemd160 ────────────────────────────────────────────────────────────────

describe('CryptoPrecompiles.ripemd160', () => {
  it('trims the 12-byte left padding and returns 20 bytes', async () => {
    // Simulate: 12 zero bytes + 20 bytes of 0xeef
    const raw = new Uint8Array(32);
    raw.fill(0xee, 12, 32);
    const evm = mockEvm(toHex(raw));
    const result = await new CryptoPrecompiles(evm).ripemd160(new Uint8Array([1]));
    expect(result).toHaveLength(20);
    expect(result.every((b) => b === 0xee)).toBe(true);
  });

  it('calls RIPEMD160 precompile address', async () => {
    const evm = mockEvm(toHex(new Uint8Array(32)));
    await new CryptoPrecompiles(evm).ripemd160(new Uint8Array([1]));
    expect(vi.mocked(evm.call).mock.calls[0]?.[0]).toBe(PRECOMPILE_ADDR.RIPEMD160);
  });

  it('returns raw bytes when response is shorter than 32 bytes', async () => {
    const short = new Uint8Array(20).fill(0x11);
    const evm = mockEvm(toHex(short));
    const result = await new CryptoPrecompiles(evm).ripemd160(new Uint8Array([1]));
    expect(result).toEqual(short);
  });
});

// ─── identity ─────────────────────────────────────────────────────────────────

describe('CryptoPrecompiles.identity', () => {
  it('returns input bytes unchanged', async () => {
    const data = new Uint8Array([0x01, 0x02, 0x03]);
    const evm = mockEvm(toHex(data));
    const result = await new CryptoPrecompiles(evm).identity(data);
    expect(result).toEqual(data);
  });

  it('calls IDENTITY precompile address', async () => {
    const data = new Uint8Array([0xff]);
    const evm = mockEvm(toHex(data));
    await new CryptoPrecompiles(evm).identity(data);
    expect(vi.mocked(evm.call).mock.calls[0]?.[0]).toBe(PRECOMPILE_ADDR.IDENTITY);
  });
});

// ─── ecRecover ────────────────────────────────────────────────────────────────

describe('CryptoPrecompiles.ecRecover', () => {
  it('returns address from precompile response (last 20 bytes)', async () => {
    const raw = new Uint8Array(32);
    // Set bytes 12-31 to '0xab' → address = 0xabab...
    raw.fill(0xab, 12, 32);
    const evm = mockEvm(toHex(raw));
    const hash = new Uint8Array(32).fill(0x01);
    const r    = new Uint8Array(32).fill(0x02);
    const s    = new Uint8Array(32).fill(0x03);
    const result = await new CryptoPrecompiles(evm).ecRecover(hash, 27, r, s);
    expect(result).toBe('0x' + 'ab'.repeat(20));
  });

  it('returns zero address when response is shorter than 32 bytes', async () => {
    const evm = mockEvm(toHex(new Uint8Array(10)));
    const hash = new Uint8Array(32);
    const r    = new Uint8Array(32);
    const s    = new Uint8Array(32);
    const result = await new CryptoPrecompiles(evm).ecRecover(hash, 27, r, s);
    expect(result).toBe('0x' + '00'.repeat(20));
  });

  it('calls EC_RECOVER precompile address', async () => {
    const evm = mockEvm(hex32());
    const hash = new Uint8Array(32);
    const r    = new Uint8Array(32);
    const s    = new Uint8Array(32);
    await new CryptoPrecompiles(evm).ecRecover(hash, 28, r, s);
    expect(vi.mocked(evm.call).mock.calls[0]?.[0]).toBe(PRECOMPILE_ADDR.EC_RECOVER);
  });

  it('packs 128-byte input: hash(32) + v_padded(32) + r(32) + s(32)', async () => {
    const evm = mockEvm(hex32());
    const hash = new Uint8Array(32).fill(0x11);
    const r    = new Uint8Array(32).fill(0x22);
    const s    = new Uint8Array(32).fill(0x33);
    await new CryptoPrecompiles(evm).ecRecover(hash, 27, r, s);
    // The second argument passed to call() is the hex of the input
    const inputHex = vi.mocked(evm.call).mock.calls[0]?.[1] as string;
    const input = inputHex.startsWith('0x')
      ? Uint8Array.from(inputHex.slice(2).match(/.{2}/g)!.map((b) => parseInt(b, 16)))
      : new Uint8Array(0);
    expect(input).toHaveLength(128);
    // hash at [0..31]
    expect(input[0]).toBe(0x11);
    expect(input[31]).toBe(0x11);
    // v at [63] (right-aligned in slot [32..63])
    expect(input[63]).toBe(27);
    // r at [64..95]
    expect(input[64]).toBe(0x22);
    // s at [96..127]
    expect(input[96]).toBe(0x33);
  });
});

// ─── ecRecoverPublicKey ───────────────────────────────────────────────────────

describe('CryptoPrecompiles.ecRecoverPublicKey', () => {
  it('returns raw bytes from precompile response (full public key)', async () => {
    const pubkey = new Uint8Array(64).fill(0xfe);
    const evm = mockEvm(toHex(pubkey));
    const hash = new Uint8Array(32);
    const r    = new Uint8Array(32);
    const s    = new Uint8Array(32);
    const result = await new CryptoPrecompiles(evm).ecRecoverPublicKey(hash, 28, r, s);
    expect(result).toEqual(pubkey);
  });

  it('calls EC_RECOVER_PUBKEY precompile address', async () => {
    const evm = mockEvm(toHex(new Uint8Array(64)));
    await new CryptoPrecompiles(evm).ecRecoverPublicKey(
      new Uint8Array(32), 27, new Uint8Array(32), new Uint8Array(32),
    );
    expect(vi.mocked(evm.call).mock.calls[0]?.[0]).toBe(PRECOMPILE_ADDR.EC_RECOVER_PUBKEY);
  });
});

// ─── curve25519Add ────────────────────────────────────────────────────────────

describe('CryptoPrecompiles.curve25519Add', () => {
  it('returns the sum point bytes', async () => {
    const sum = new Uint8Array(32).fill(0x99);
    const evm = mockEvm(toHex(sum));
    const pt = new Uint8Array(32).fill(0x01);
    const result = await new CryptoPrecompiles(evm).curve25519Add([pt, pt]);
    expect(result).toEqual(sum);
  });

  it('concatenates all points into a single input', async () => {
    const evm = mockEvm(hex32());
    const pt1 = new Uint8Array(32).fill(0x01);
    const pt2 = new Uint8Array(32).fill(0x02);
    await new CryptoPrecompiles(evm).curve25519Add([pt1, pt2]);
    const inputHex = vi.mocked(evm.call).mock.calls[0]?.[1] as string;
    const input = Uint8Array.from(inputHex.slice(2).match(/.{2}/g)!.map((b) => parseInt(b, 16)));
    expect(input).toHaveLength(64);
    expect(input[0]).toBe(0x01);  // first point
    expect(input[32]).toBe(0x02); // second point
  });

  it('calls CURVE25519_ADD precompile address', async () => {
    const evm = mockEvm(hex32());
    await new CryptoPrecompiles(evm).curve25519Add([new Uint8Array(32)]);
    expect(vi.mocked(evm.call).mock.calls[0]?.[0]).toBe(PRECOMPILE_ADDR.CURVE25519_ADD);
  });

  it('throws when 0 points are provided', async () => {
    const evm = mockEvm(hex32());
    await expect(new CryptoPrecompiles(evm).curve25519Add([])).rejects.toThrow(
      'curve25519Add: expected 1–10 points, got 0',
    );
  });

  it('throws when more than 10 points are provided', async () => {
    const evm = mockEvm(hex32());
    const points = Array.from({ length: 11 }, () => new Uint8Array(32));
    await expect(new CryptoPrecompiles(evm).curve25519Add(points)).rejects.toThrow(
      'curve25519Add: expected 1–10 points, got 11',
    );
  });

  it('throws when a point is not 32 bytes', async () => {
    const evm = mockEvm(hex32());
    await expect(
      new CryptoPrecompiles(evm).curve25519Add([new Uint8Array(31)]),
    ).rejects.toThrow('curve25519Add: point[0] must be exactly 32 bytes');
  });
});

// ─── curve25519ScalarMul ──────────────────────────────────────────────────────

describe('CryptoPrecompiles.curve25519ScalarMul', () => {
  it('returns the result point bytes', async () => {
    const result = new Uint8Array(32).fill(0x77);
    const evm = mockEvm(toHex(result));
    const scalar = new Uint8Array(32).fill(0x05);
    const point  = new Uint8Array(32).fill(0x06);
    expect(await new CryptoPrecompiles(evm).curve25519ScalarMul(scalar, point)).toEqual(result);
  });

  it('packs 64-byte input: scalar(32) + point(32)', async () => {
    const evm = mockEvm(hex32());
    const scalar = new Uint8Array(32).fill(0xaa);
    const point  = new Uint8Array(32).fill(0xbb);
    await new CryptoPrecompiles(evm).curve25519ScalarMul(scalar, point);
    const inputHex = vi.mocked(evm.call).mock.calls[0]?.[1] as string;
    const input = Uint8Array.from(inputHex.slice(2).match(/.{2}/g)!.map((b) => parseInt(b, 16)));
    expect(input).toHaveLength(64);
    expect(input[0]).toBe(0xaa);   // scalar start
    expect(input[32]).toBe(0xbb);  // point start
  });

  it('calls CURVE25519_SCALAR_MUL precompile address', async () => {
    const evm = mockEvm(hex32());
    await new CryptoPrecompiles(evm).curve25519ScalarMul(
      new Uint8Array(32), new Uint8Array(32),
    );
    expect(vi.mocked(evm.call).mock.calls[0]?.[0]).toBe(PRECOMPILE_ADDR.CURVE25519_SCALAR_MUL);
  });

  it('throws when scalar is not 32 bytes', async () => {
    const evm = mockEvm(hex32());
    await expect(
      new CryptoPrecompiles(evm).curve25519ScalarMul(new Uint8Array(16), new Uint8Array(32)),
    ).rejects.toThrow('curve25519ScalarMul: scalar must be 32 bytes');
  });

  it('throws when point is not 32 bytes', async () => {
    const evm = mockEvm(hex32());
    await expect(
      new CryptoPrecompiles(evm).curve25519ScalarMul(new Uint8Array(32), new Uint8Array(16)),
    ).rejects.toThrow('curve25519ScalarMul: point must be 32 bytes');
  });
});
