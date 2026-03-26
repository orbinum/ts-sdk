import { describe, it, expect } from 'vitest';
import {
  encode,
  encodeHex,
  hexToBytes,
  decodeUint,
  decodeAddress,
  decodeBool,
  decodeBytes,
  decodeString,
} from '../../src/precompiles/abi';

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** 4-byte test selector */
const SEL = new Uint8Array([0x12, 0x34, 0x56, 0x78]);

/** Build a 32-byte slot with value right-aligned. */
function slot32(value: number): Uint8Array {
  const s = new Uint8Array(32);
  s[31] = value;
  return s;
}

/** Build a 32-byte slot with a 20-byte hex address right-aligned (bytes 12-31). */
function addressSlot(hex: string): Uint8Array {
  const s = new Uint8Array(32);
  const clean = hex.startsWith('0x') ? hex.slice(2) : hex;
  for (let i = 0; i < 20; i++) {
    s[12 + i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  }
  return s;
}

// ─── hexToBytes ───────────────────────────────────────────────────────────────

describe('hexToBytes', () => {
  it("returns empty array for '0x'", () => {
    expect(hexToBytes('0x')).toEqual(new Uint8Array(0));
  });

  it('returns empty array for empty string', () => {
    expect(hexToBytes('')).toEqual(new Uint8Array(0));
  });

  it('decodes 0x1234 to [0x12, 0x34]', () => {
    expect(hexToBytes('0x1234')).toEqual(new Uint8Array([0x12, 0x34]));
  });

  it('handles string without 0x prefix', () => {
    expect(hexToBytes('deadbeef')).toEqual(new Uint8Array([0xde, 0xad, 0xbe, 0xef]));
  });
});

// ─── decodeUint ───────────────────────────────────────────────────────────────

describe('decodeUint', () => {
  it('returns 0n for a zero slot', () => {
    expect(decodeUint(new Uint8Array(32))).toBe(0n);
  });

  it('reads 1n from last byte', () => {
    expect(decodeUint(slot32(1))).toBe(1n);
  });

  it('reads 255n from last byte', () => {
    expect(decodeUint(slot32(255))).toBe(255n);
  });

  it('respects the offset parameter', () => {
    const data = new Uint8Array(64);
    data[63] = 7; // value at slot 1 (offset=32)
    expect(decodeUint(data, 32)).toBe(7n);
  });

  it('reads a 256n correctly (bytes 30=0x01, 31=0x00)', () => {
    const s = new Uint8Array(32);
    s[30] = 1;
    expect(decodeUint(s)).toBe(256n);
  });
});

// ─── decodeAddress ────────────────────────────────────────────────────────────

describe('decodeAddress', () => {
  it('returns 0x-prefixed lowercase address from slot', () => {
    const addr = '0xabcdef1234567890abcdef1234567890abcdef12';
    const data = addressSlot(addr);
    expect(decodeAddress(data)).toBe(addr);
  });

  it('respects the offset parameter', () => {
    const addr = '0x1111111111111111111111111111111111111111';
    const data = new Uint8Array(64);
    data.set(addressSlot(addr), 32);
    expect(decodeAddress(data, 32)).toBe(addr);
  });

  it('returns zero address for empty slot', () => {
    expect(decodeAddress(new Uint8Array(32))).toBe(
      '0x0000000000000000000000000000000000000000',
    );
  });
});

// ─── decodeBool ───────────────────────────────────────────────────────────────

describe('decodeBool', () => {
  it('returns true when last byte is 1', () => {
    expect(decodeBool(slot32(1))).toBe(true);
  });

  it('returns false when last byte is 0', () => {
    expect(decodeBool(new Uint8Array(32))).toBe(false);
  });

  it('returns true for any non-zero last byte', () => {
    expect(decodeBool(slot32(255))).toBe(true);
  });

  it('uses only last byte — leading bytes are ignored', () => {
    const s = new Uint8Array(32);
    s[0] = 1; // first byte is 1, last byte is 0
    expect(decodeBool(s)).toBe(false);
  });

  it('respects the offset parameter', () => {
    const data = new Uint8Array(64);
    data[63] = 1; // last byte of second slot
    expect(decodeBool(data, 32)).toBe(true);
  });
});

// ─── decodeBytes / decodeString ───────────────────────────────────────────────

/** Build ABI `bytes` response with a single dynamic param starting at byte 0. */
function buildBytesResponse(payload: Uint8Array): Uint8Array {
  // Head: uint256(32) — pointer to tail starting after one head slot
  const ptr = new Uint8Array(32);
  ptr[31] = 32; // pointer = 32
  // Tail: uint256(length) + payload padded to 32 bytes
  const lenSlot = new Uint8Array(32);
  const len = payload.length;
  lenSlot[31] = len % 256;
  if (len >= 256) lenSlot[30] = Math.floor(len / 256);
  const padLen = len % 32 === 0 ? len : len + (32 - (len % 32));
  const data = new Uint8Array(padLen);
  data.set(payload);
  const result = new Uint8Array(32 + 32 + padLen);
  result.set(ptr, 0);
  result.set(lenSlot, 32);
  result.set(data, 64);
  return result;
}

describe('decodeBytes', () => {
  it('extracts payload bytes from an ABI dynamic bytes response', () => {
    const payload = new Uint8Array([0x01, 0x02, 0x03]);
    const response = buildBytesResponse(payload);
    expect(decodeBytes(response, 0)).toEqual(payload);
  });

  it('returns empty Uint8Array for zero-length payload', () => {
    const response = buildBytesResponse(new Uint8Array(0));
    expect(decodeBytes(response, 0)).toEqual(new Uint8Array(0));
  });
});

describe('decodeString', () => {
  it('decodes UTF-8 string from ABI dynamic response', () => {
    const text = '@alice';
    const payload = new TextEncoder().encode(text);
    const response = buildBytesResponse(payload);
    expect(decodeString(response, 0)).toBe('@alice');
  });

  it('decodes empty string', () => {
    const response = buildBytesResponse(new Uint8Array(0));
    expect(decodeString(response, 0)).toBe('');
  });
});

// ─── encode / encodeHex ───────────────────────────────────────────────────────

describe('encode — static types', () => {
  it('prepends the 4-byte selector', () => {
    const result = encode(SEL);
    expect(Array.from(result.slice(0, 4))).toEqual([0x12, 0x34, 0x56, 0x78]);
  });

  it('encodes uint right-aligned in 32 bytes', () => {
    const result = encode(SEL, { type: 'uint', value: 1n });
    // bytes 4..35: uint256(1) → last byte = 1, rest zeros
    expect(result[35]).toBe(1);
    for (let i = 4; i < 35; i++) expect(result[i]).toBe(0);
  });

  it('encodes uint 256n as [30]=1,[31]=0', () => {
    const result = encode(SEL, { type: 'uint', value: 256n });
    expect(result[34]).toBe(1);
    expect(result[35]).toBe(0);
  });

  it('encodes bool true as last byte 1', () => {
    const result = encode(SEL, { type: 'bool', value: true });
    expect(result[35]).toBe(1);
  });

  it('encodes bool false as all zeros', () => {
    const result = encode(SEL, { type: 'bool', value: false });
    for (let i = 4; i < 36; i++) expect(result[i]).toBe(0);
  });

  it('encodes address right-aligned with 12 zero bytes', () => {
    const addr = '0xabcdef1234567890abcdef1234567890abcdef12';
    const result = encode(SEL, { type: 'address', value: addr });
    // bytes 4..15 should be zeros, bytes 16..35 should be address
    for (let i = 4; i < 16; i++) expect(result[i]).toBe(0);
    expect(result[16]).toBe(0xab);
    expect(result[35]).toBe(0x12);
  });

  it('encodes bytes32 left-aligned in slot', () => {
    const b32 = new Uint8Array(32).fill(0xaa);
    const result = encode(SEL, { type: 'bytes32', value: b32 });
    for (let i = 0; i < 32; i++) expect(result[4 + i]).toBe(0xaa);
  });

  it('total size for 2 static params is 4 + 2×32 = 68 bytes', () => {
    const result = encode(SEL, { type: 'uint', value: 1n }, { type: 'uint', value: 2n });
    expect(result.length).toBe(68);
  });
});

describe('encode — dynamic types', () => {
  it('encodes bytes: selector(4) + ptr(32) + len(32) + data_padded', () => {
    const payload = new Uint8Array([0x01, 0x02, 0x03]);
    const result = encode(SEL, { type: 'bytes', value: payload });
    // 4 + 32 (head: ptr=32) + 32 (len=3) + 32 (padded data) = 100
    expect(result.length).toBe(100);
    // head slot = uint256(32)
    expect(result[35]).toBe(32);
    // length slot = uint256(3)
    expect(result[67]).toBe(3);
    // first 3 bytes of data
    expect(result[68]).toBe(0x01);
    expect(result[69]).toBe(0x02);
    expect(result[70]).toBe(0x03);
  });

  it('encodes string the same as bytes (UTF-8)', () => {
    const text = 'hi';
    const result = encode(SEL, { type: 'string', value: text });
    // length = 2
    expect(result[67]).toBe(2);
    expect(result[68]).toBe('h'.charCodeAt(0));
    expect(result[69]).toBe('i'.charCodeAt(0));
  });

  it('round-trips bytes through decodeBytes', () => {
    const payload = new Uint8Array([0xde, 0xad, 0xbe, 0xef]);
    const encoded = encode(SEL, { type: 'bytes', value: payload });
    // strip selector (4 bytes) before decoding
    const body = encoded.slice(4);
    expect(decodeBytes(body, 0)).toEqual(payload);
  });

  it('round-trips string through decodeString', () => {
    const text = 'orbinum';
    const encoded = encode(SEL, { type: 'string', value: text });
    const body = encoded.slice(4);
    expect(decodeString(body, 0)).toBe(text);
  });

  it('encodes bytes32[] correctly — head is pointer, tail has count + elements', () => {
    const b32 = new Uint8Array(32).fill(0xbb);
    const result = encode(SEL, { type: 'bytes32[]', value: [b32] });
    // 4 + 32 (ptr=32) + 32 (count=1) + 32 (element) = 100
    expect(result.length).toBe(100);
    expect(result[67]).toBe(1); // count = 1
    for (let i = 0; i < 32; i++) expect(result[68 + i]).toBe(0xbb);
  });

  it('encodes address[] correctly', () => {
    const addr = '0x1111111111111111111111111111111111111111';
    const result = encode(SEL, { type: 'address[]', value: [addr] });
    // 4 + 32 (ptr) + 32 (count=1) + 32 (slot) = 100
    expect(result.length).toBe(100);
    expect(result[67]).toBe(1); // count
    // address right-aligned: bytes 68+12..68+31 should be 0x11
    for (let i = 0; i < 20; i++) expect(result[80 + i]).toBe(0x11);
  });
});

describe('encodeHex', () => {
  it('returns 0x-prefixed hex string', () => {
    const result = encodeHex(SEL, { type: 'uint', value: 0n });
    expect(result.startsWith('0x')).toBe(true);
  });

  it('starts with the selector hex', () => {
    expect(encodeHex(SEL).startsWith('0x12345678')).toBe(true);
  });

  it('result length is 2 + 2 × (4 + n×32) chars for n static params', () => {
    // 0 params: '0x' + 8 hex chars (4 bytes selector)
    expect(encodeHex(SEL).length).toBe(10);
    // 1 static param: '0x' + (4+32)×2 = 72
    expect(encodeHex(SEL, { type: 'uint', value: 1n }).length).toBe(74);
  });
});
