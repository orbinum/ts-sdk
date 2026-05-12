import { describe, it, expect } from 'vitest';
import { sha256 } from '@noble/hashes/sha2.js';
import { mulPointEscalar, Base8 } from '@zk-kit/baby-jubjub';
import {
    serializeMemo,
    deriveEncryptionKey,
} from '../../src/shielded-pool/protocol/memo';
import { deriveStealthOwnerPk, deriveStealthSk } from '../../src/utils/stealth';
import { recoverOwnerPkPoint } from '../../src/utils/bjj';
import { toBase64, fromBase64 } from '../../src/utils/encoding';
import { deriveOwnerPk } from '../../src/privacy-keys/PrivacyKeys';

// ─── serializeMemo ────────────────────────────────────────────────────────────
//
// Plaintext layout (116 bytes — mirrors Rust MemoData::to_bytes()):
//   value_lo(8 LE) | value_hi(8 LE) | ownerPk(32) | blinding(32) | assetId(4 LE) | counterpartyPk(32)
//
// value is stored as a 128-bit LE unsigned integer (two uint64 words).
// This is the Memo v2 format. Total plaintext size is 116 bytes.

describe('serializeMemo', () => {
  const value = 1_000_000n;
  const ownerPk = new Uint8Array(32).fill(0x01);
  const blinding = new Uint8Array(32).fill(0x02);
  const assetId = 3;
  const counterpartyPk = new Uint8Array(32).fill(0x04);

  it('returns a Uint8Array of exactly 116 bytes', () => {
    const buf = serializeMemo(value, ownerPk, blinding, assetId, counterpartyPk);
    expect(buf).toBeInstanceOf(Uint8Array);
    expect(buf).toHaveLength(116);
  });

  it('value is serialized as u128 little-endian at offsets 0..16', () => {
    const buf = serializeMemo(value, ownerPk, blinding, assetId, counterpartyPk);
    const dv = new DataView(buf.buffer, buf.byteOffset);
    const lo = dv.getBigUint64(0, true);
    const hi = dv.getBigUint64(8, true);
    expect(lo | (hi << 64n)).toBe(value);
  });

  it('ownerPk occupies bytes [16, 48)', () => {
    const buf = serializeMemo(value, ownerPk, blinding, assetId, counterpartyPk);
    expect(buf.slice(16, 48)).toEqual(ownerPk);
  });

  it('blinding occupies bytes [48, 80)', () => {
    const buf = serializeMemo(value, ownerPk, blinding, assetId, counterpartyPk);
    expect(buf.slice(48, 80)).toEqual(blinding);
  });

  it('assetId is serialized as u32 little-endian at offset 80', () => {
    const buf = serializeMemo(value, ownerPk, blinding, assetId, counterpartyPk);
    const dv = new DataView(buf.buffer, buf.byteOffset);
    expect(dv.getUint32(80, true)).toBe(assetId);
  });

  it('counterpartyPk occupies bytes [84, 116) — Memo v2 field', () => {
    const buf = serializeMemo(value, ownerPk, blinding, assetId, counterpartyPk);
    expect(buf.slice(84, 116)).toEqual(counterpartyPk);
  });

  it('zero counterpartyPk (shield/unshield) serializes to 32 zero bytes', () => {
    const zeroCpk = new Uint8Array(32);
    const buf = serializeMemo(value, ownerPk, blinding, assetId, zeroCpk);
    expect(buf.slice(84, 116)).toEqual(new Uint8Array(32));
  });

  it('value = 0n serializes correctly', () => {
    const buf = serializeMemo(0n, ownerPk, blinding, assetId, counterpartyPk);
    const dv = new DataView(buf.buffer, buf.byteOffset);
    const lo = dv.getBigUint64(0, true);
    const hi = dv.getBigUint64(8, true);
    expect(lo | (hi << 64n)).toBe(0n);
  });

  it('max u64 value serializes and deserializes correctly (fits in lo word)', () => {
    const maxU64 = 0xffff_ffff_ffff_ffffn;
    const buf = serializeMemo(maxU64, ownerPk, blinding, assetId, counterpartyPk);
    const dv = new DataView(buf.buffer, buf.byteOffset);
    const lo = dv.getBigUint64(0, true);
    const hi = dv.getBigUint64(8, true);
    expect(lo | (hi << 64n)).toBe(maxU64);
  });

  it('value > u64 max uses hi word (u128)', () => {
    // 50 * 10^18 — realistic large shield amount that overflows u64
    const bigValue = 50_000_000_000_000_000_000n;
    const buf = serializeMemo(bigValue, ownerPk, blinding, assetId, counterpartyPk);
    const dv = new DataView(buf.buffer, buf.byteOffset);
    const lo = dv.getBigUint64(0, true);
    const hi = dv.getBigUint64(8, true);
    expect(lo | (hi << 64n)).toBe(bigValue);
  });

  it('assetId = 0 produces four zero bytes at offset 80', () => {
    const buf = serializeMemo(value, ownerPk, blinding, 0, counterpartyPk);
    expect(buf.slice(80, 84)).toEqual(new Uint8Array(4));
  });

  it('different values produce different serializations', () => {
    const buf1 = serializeMemo(100n, ownerPk, blinding, assetId, counterpartyPk);
    const buf2 = serializeMemo(200n, ownerPk, blinding, assetId, counterpartyPk);
    expect(buf1).not.toEqual(buf2);
  });

  it('different ownerPks produce different serializations', () => {
    const pk1 = new Uint8Array(32).fill(0xaa);
    const pk2 = new Uint8Array(32).fill(0xbb);
    expect(serializeMemo(value, pk1, blinding, assetId, counterpartyPk)).not.toEqual(
      serializeMemo(value, pk2, blinding, assetId, counterpartyPk),
    );
  });

  it('different counterpartyPks produce different serializations', () => {
    const cpk1 = new Uint8Array(32).fill(0x11);
    const cpk2 = new Uint8Array(32).fill(0x22);
    expect(serializeMemo(value, ownerPk, blinding, assetId, cpk1)).not.toEqual(
      serializeMemo(value, ownerPk, blinding, assetId, cpk2),
    );
  });

  it('mirrors the Rust MemoData::to_bytes() layout: value_lo|value_hi|ownerPk|blinding|assetId|counterpartyPk', () => {
    const buf = serializeMemo(value, ownerPk, blinding, assetId, counterpartyPk);
    // Verify each region independently against the known layout
    const dv = new DataView(buf.buffer, buf.byteOffset);
    const lo = dv.getBigUint64(0, true);
    const hi = dv.getBigUint64(8, true);
    expect(lo | (hi << 64n)).toBe(value);          // [0,16) value (u128)
    expect(buf.slice(16, 48)).toEqual(ownerPk);    // [16,48) ownerPk
    expect(buf.slice(48, 80)).toEqual(blinding);   // [48,80) blinding
    expect(dv.getUint32(80, true)).toBe(assetId);  // [80,84) assetId
    expect(buf.slice(84, 116)).toEqual(counterpartyPk); // [84,116) counterpartyPk
  });

  it('ownerPk is truncated to 32 bytes when provided as longer slice', () => {
    const longPk = new Uint8Array(64).fill(0x07);
    const buf = serializeMemo(value, longPk, blinding, assetId, counterpartyPk);
    expect(buf.slice(16, 48)).toEqual(longPk.slice(0, 32));
  });
});

// ─── deriveEncryptionKey ──────────────────────────────────────────────────────
//
// key = SHA256(viewingKey || commitment || "orbinum-note-encryption-v1")
// Mirrors Rust: derive_encryption_key(viewing_key, commitment)

describe('deriveEncryptionKey', () => {
  const viewingKey = new Uint8Array(32).fill(0xab);
  const commitment = new Uint8Array(32).fill(0xcd);

  it('returns a Uint8Array of exactly 32 bytes', () => {
    const key = deriveEncryptionKey(viewingKey, commitment);
    expect(key).toBeInstanceOf(Uint8Array);
    expect(key).toHaveLength(32);
  });

  it('is deterministic — same inputs always produce the same key', () => {
    const k1 = deriveEncryptionKey(viewingKey, commitment);
    const k2 = deriveEncryptionKey(viewingKey, commitment);
    expect(k1).toEqual(k2);
  });

  it('different viewing keys produce different derived keys', () => {
    const k1 = deriveEncryptionKey(new Uint8Array(32).fill(0x01), commitment);
    const k2 = deriveEncryptionKey(new Uint8Array(32).fill(0x02), commitment);
    expect(k1).not.toEqual(k2);
  });

  it('different commitments produce different derived keys', () => {
    const k1 = deriveEncryptionKey(viewingKey, new Uint8Array(32).fill(0x01));
    const k2 = deriveEncryptionKey(viewingKey, new Uint8Array(32).fill(0x02));
    expect(k1).not.toEqual(k2);
  });

  it('matches manual SHA256(viewingKey || commitment || domain)', () => {
    const domain = new TextEncoder().encode('orbinum-note-encryption-v1');
    const h = sha256.create();
    h.update(viewingKey);
    h.update(commitment);
    h.update(domain);
    const expected = h.digest();
    expect(deriveEncryptionKey(viewingKey, commitment)).toEqual(expected);
  });

  it('zero viewing key with zero commitment produces a non-zero key (SHA256 is non-trivial)', () => {
    const key = deriveEncryptionKey(new Uint8Array(32), new Uint8Array(32));
    expect(key.some((b) => b !== 0)).toBe(true);
  });

  it('is sensitive to viewing key byte order (commitment is position-sensitive)', () => {
    const vk1 = new Uint8Array(32);
    vk1[0] = 1;
    const vk2 = new Uint8Array(32);
    vk2[31] = 1;
    expect(deriveEncryptionKey(vk1, commitment)).not.toEqual(
      deriveEncryptionKey(vk2, commitment),
    );
  });
});

// ─── toBase64 / fromBase64 ────────────────────────────────────────────────────

describe('toBase64', () => {
  it('returns a string', () => {
    expect(typeof toBase64(new Uint8Array([1, 2, 3]))).toBe('string');
  });

  it('encodes empty bytes to empty string', () => {
    expect(toBase64(new Uint8Array(0))).toBe('');
  });

  it('encodes known ASCII bytes: "Hello" → "SGVsbG8="', () => {
    const hello = new Uint8Array([0x48, 0x65, 0x6c, 0x6c, 0x6f]);
    expect(toBase64(hello)).toBe('SGVsbG8=');
  });

  it('accepts an ArrayBuffer as input', () => {
    const buf = new Uint8Array([1, 2, 3]).buffer;
    expect(typeof toBase64(buf)).toBe('string');
    expect(toBase64(buf)).toBe(toBase64(new Uint8Array([1, 2, 3])));
  });

  it('produces a valid base64 string (only base64 characters)', () => {
    const data = new Uint8Array(33).map((_, i) => i * 7);
    const b64 = toBase64(data);
    expect(/^[A-Za-z0-9+/]*={0,2}$/.test(b64)).toBe(true);
  });
});

describe('fromBase64', () => {
  it('decodes empty string to empty Uint8Array', () => {
    expect(fromBase64('')).toEqual(new Uint8Array(0));
  });

  it('decodes "SGVsbG8=" → "Hello" bytes', () => {
    expect(fromBase64('SGVsbG8=')).toEqual(new Uint8Array([0x48, 0x65, 0x6c, 0x6c, 0x6f]));
  });

  it('returns a Uint8Array', () => {
    expect(fromBase64('AAAA')).toBeInstanceOf(Uint8Array);
  });
});

describe('toBase64 / fromBase64 round-trip', () => {
  it('all 256 possible byte values survive the round-trip', () => {
    const original = new Uint8Array(256).map((_, i) => i);
    expect(fromBase64(toBase64(original))).toEqual(original);
  });

  it('32-byte viewing key survives the round-trip', () => {
    const key = new Uint8Array(32).map((_, i) => (i * 13 + 7) % 256);
    expect(fromBase64(toBase64(key))).toEqual(key);
  });

  it('136-byte encrypted memo size survives the round-trip', () => {
    const memo = new Uint8Array(136).map((_, i) => i % 251);
    expect(fromBase64(toBase64(memo))).toEqual(memo);
  });

  it('round-trip is stable (calling twice produces same result)', () => {
    const data = new Uint8Array([10, 20, 30, 40, 50]);
    const b64 = toBase64(data);
    expect(fromBase64(b64)).toEqual(fromBase64(b64));
  });
});

// ─── Stealth address crypto ────────────────────────────────────────────────────
//
// Invariant: BabyPbk(stealthSk).Ax == deriveStealthOwnerPk(sharedSecret, ownerPk, ownerPkPoint)
// This is what allows the ZK circuits to validate stealth note ownership without modification.

describe('deriveStealthOwnerPk', () => {
    // Fixed test fixtures
    const spendingKey = 42n;
    const ownerPkPoint = mulPointEscalar(Base8, spendingKey);
    const ownerPkBigint = ownerPkPoint[0];
    const sharedSecret = new Uint8Array(32).fill(0xab);

    it('returns a bigint', () => {
        const result = deriveStealthOwnerPk(sharedSecret, ownerPkBigint, ownerPkPoint);
        expect(typeof result).toBe('bigint');
    });

    it('is deterministic — same inputs produce same output', () => {
        const a = deriveStealthOwnerPk(sharedSecret, ownerPkBigint, ownerPkPoint);
        const b = deriveStealthOwnerPk(sharedSecret, ownerPkBigint, ownerPkPoint);
        expect(a).toBe(b);
    });

    it('differs from ownerPkBigint (stealth point != original point)', () => {
        const stealth = deriveStealthOwnerPk(sharedSecret, ownerPkBigint, ownerPkPoint);
        expect(stealth).not.toBe(ownerPkBigint);
    });

    it('two different senders (different sharedSecret) produce different stealthOwnerPk', () => {
        const shared1 = new Uint8Array(32).fill(0x01);
        const shared2 = new Uint8Array(32).fill(0x02);
        const pk1 = deriveStealthOwnerPk(shared1, ownerPkBigint, ownerPkPoint);
        const pk2 = deriveStealthOwnerPk(shared2, ownerPkBigint, ownerPkPoint);
        expect(pk1).not.toBe(pk2);
    });

    it('two different recipients produce different stealthOwnerPk from same sharedSecret', () => {
        const spendingKey2 = 99n;
        const ownerPkPoint2 = mulPointEscalar(Base8, spendingKey2);
        const ownerPkBigint2 = ownerPkPoint2[0];
        const pk1 = deriveStealthOwnerPk(sharedSecret, ownerPkBigint, ownerPkPoint);
        const pk2 = deriveStealthOwnerPk(sharedSecret, ownerPkBigint2, ownerPkPoint2);
        expect(pk1).not.toBe(pk2);
    });

    it('result is within BJJ prime field (< BJJ_P)', () => {
        const BJJ_P = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;
        const stealth = deriveStealthOwnerPk(sharedSecret, ownerPkBigint, ownerPkPoint);
        expect(stealth < BJJ_P).toBe(true);
    });

    it('result is non-zero', () => {
        const stealth = deriveStealthOwnerPk(sharedSecret, ownerPkBigint, ownerPkPoint);
        expect(stealth).not.toBe(0n);
    });
});

describe('deriveStealthSk', () => {
    const spendingKey = 42n;
    const ownerPkPoint = mulPointEscalar(Base8, spendingKey);
    const ownerPkBigint = ownerPkPoint[0];
    const sharedSecret = new Uint8Array(32).fill(0xab);
    const BABYJUB_SUBORDER = 2736030358979909402780800718157159386076813972158567259200215660948447373041n;

    it('returns a bigint', () => {
        const sk = deriveStealthSk(sharedSecret, ownerPkBigint, spendingKey);
        expect(typeof sk).toBe('bigint');
    });

    it('is deterministic', () => {
        const a = deriveStealthSk(sharedSecret, ownerPkBigint, spendingKey);
        const b = deriveStealthSk(sharedSecret, ownerPkBigint, spendingKey);
        expect(a).toBe(b);
    });

    it('result is within [1, BABYJUB_SUBORDER)', () => {
        const sk = deriveStealthSk(sharedSecret, ownerPkBigint, spendingKey);
        expect(sk >= 1n).toBe(true);
        expect(sk < BABYJUB_SUBORDER).toBe(true);
    });

    it('differs from global spendingKey', () => {
        const sk = deriveStealthSk(sharedSecret, ownerPkBigint, spendingKey);
        expect(sk).not.toBe(spendingKey);
    });

    it('BabyPbk(stealthSk).Ax == deriveStealthOwnerPk — core invariant', () => {
        const stealthSk = deriveStealthSk(sharedSecret, ownerPkBigint, spendingKey);
        const stealthPk = mulPointEscalar(Base8, stealthSk);
        const expectedStealthOwnerPk = deriveStealthOwnerPk(sharedSecret, ownerPkBigint, ownerPkPoint);
        // BabyPbk uses Base8 (cofactor-cleared base point), same as mulPointEscalar(Base8, sk)
        expect(stealthPk[0]).toBe(expectedStealthOwnerPk);
    });

    it('different sharedSecrets produce different stealthSk values', () => {
        const shared1 = new Uint8Array(32).fill(0x11);
        const shared2 = new Uint8Array(32).fill(0x22);
        const sk1 = deriveStealthSk(shared1, ownerPkBigint, spendingKey);
        const sk2 = deriveStealthSk(shared2, ownerPkBigint, spendingKey);
        expect(sk1).not.toBe(sk2);
    });
});

// ─── recoverOwnerPkPoint ────────────────────────────────────────────────────────────────────
const BJJ_P = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;
const BJJ_A = 168700n;
const BJJ_D = 168696n;

describe('recoverOwnerPkPoint', () => {
    it('recovers a valid [Ax, Ay] from a known ownerPk', () => {
        const sk = 12345678901234567890n;
        const ownerPk = deriveOwnerPk(sk);
        const point = recoverOwnerPkPoint(ownerPk);
        expect(point).not.toBeNull();
        expect(point![0]).toBe(ownerPk);
        expect(point![1]).toBeGreaterThanOrEqual(0n);
        expect(point![1]).toBeLessThan(BJJ_P);
    });

    it('recovered point satisfies the BJJ curve equation (a=168700, d=168696)', () => {
        const sk = 99999999999999999n;
        const ownerPk = deriveOwnerPk(sk);
        const point = recoverOwnerPkPoint(ownerPk)!;
        const [x, y] = point;
        const lhs = (BJJ_A * x * x + y * y) % BJJ_P;
        const rhs = (1n + BJJ_D * x * x * y * y) % BJJ_P;
        expect(lhs).toBe(rhs);
    });

    it('recovered point is in the prime subgroup (BABYJUB_SUBORDER × point = identity)', () => {
        // recoverOwnerPkPoint now returns the y that places the point in the prime
        // subgroup, not necessarily the smaller y. This is required for the stealth
        // invariant BJJ(stealthSk).x == stealthOwnerPk to hold.
        const BABYJUB_SUBORDER_VAL = 2736030358979909402780800718157159386076813972158567259200215660948447373041n;
        const sk = 98765432109876543210n;
        const ownerPk = deriveOwnerPk(sk);
        const point = recoverOwnerPkPoint(ownerPk)!;
        const identity = mulPointEscalar(point, BABYJUB_SUBORDER_VAL);
        expect(identity[0]).toBe(0n);
        expect(identity[1]).toBe(1n);
    });

    it('any returned point must satisfy the curve equation', () => {
        for (const x of [0n, 1n, 3n, 7n]) {
            const result = recoverOwnerPkPoint(x);
            if (result !== null) {
                const [rx, ry] = result;
                const lhs = (BJJ_A * rx * rx + ry * ry) % BJJ_P;
                const rhs = (1n + BJJ_D * rx * rx * ry * ry) % BJJ_P;
                expect(lhs).toBe(rhs);
            }
        }
    });
});
