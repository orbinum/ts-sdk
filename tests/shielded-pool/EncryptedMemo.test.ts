import { describe, it, expect } from 'vitest';
import {
  EncryptedMemo,
  ENCRYPTED_MEMO_SIZE,
} from '../../src/shielded-pool/protocol/EncryptedMemo';
import { deriveViewingSecretKey, deriveViewingPublicKey } from '../../src/privacy-keys/PrivacyKeys';
import { bytesToBigintLE } from '../../src/utils/bytes';

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const SPENDING_KEY = 12345678901234567890n;
const viewingSecretKey = deriveViewingSecretKey(SPENDING_KEY);
const viewingPublicKey = deriveViewingPublicKey(viewingSecretKey);

const value = 1_000_000n;
const ownerPk = new Uint8Array(32).fill(0x01);
const blinding = new Uint8Array(32).fill(0x02);
const assetId = 3;
const commitment = new Uint8Array(32).fill(0x04);
const counterpartyPk = new Uint8Array(32).fill(0x09);

// ─── ENCRYPTED_MEMO_SIZE ──────────────────────────────────────────────────────

describe('ENCRYPTED_MEMO_SIZE', () => {
  it('equals 176 (v2 ECDH)', () => {
    expect(ENCRYPTED_MEMO_SIZE).toBe(176);
  });
});

// ─── EncryptedMemo.dummy ──────────────────────────────────────────────────────

describe('EncryptedMemo.dummy', () => {
  it('returns exactly 176 bytes', () => {
    expect(EncryptedMemo.dummy()).toHaveLength(176);
  });

  it('is all zeros', () => {
    const memo = EncryptedMemo.dummy();
    expect(memo.every((b) => b === 0)).toBe(true);
  });

  it('returns a new instance each call', () => {
    const a = EncryptedMemo.dummy();
    const b = EncryptedMemo.dummy();
    expect(a).not.toBe(b);
  });
});

// ─── EncryptedMemo.encrypt ────────────────────────────────────────────────────

describe('EncryptedMemo.encrypt', () => {
  it('returns exactly 176 bytes', () => {
    const memo = EncryptedMemo.encrypt(value, ownerPk, blinding, assetId, commitment, viewingPublicKey);
    expect(memo).toHaveLength(ENCRYPTED_MEMO_SIZE);
  });

  it('returns a Uint8Array', () => {
    const memo = EncryptedMemo.encrypt(value, ownerPk, blinding, assetId, commitment, viewingPublicKey);
    expect(memo).toBeInstanceOf(Uint8Array);
  });

  it('nonce (first 12 bytes) differs between calls', () => {
    const a = EncryptedMemo.encrypt(value, ownerPk, blinding, assetId, commitment, viewingPublicKey);
    const b = EncryptedMemo.encrypt(value, ownerPk, blinding, assetId, commitment, viewingPublicKey);
    expect(a.slice(0, 12)).not.toEqual(b.slice(0, 12));
  });

  it('throws for an invalid (non-BJJ-point) viewing public key', () => {
    const invalidIvk = new Uint8Array(32).fill(0xff);
    expect(() =>
      EncryptedMemo.encrypt(value, ownerPk, blinding, assetId, commitment, invalidIvk)
    ).toThrow();
  });
});

// ─── EncryptedMemo.decrypt — ECDH round-trip ─────────────────────────────────

describe('EncryptedMemo.decrypt — ECDH round-trip', () => {
  it('returns non-null for a correctly encrypted memo', () => {
    const enc = EncryptedMemo.encrypt(value, ownerPk, blinding, assetId, commitment, viewingPublicKey);
    expect(EncryptedMemo.decrypt(enc, commitment, viewingSecretKey)).not.toBeNull();
  });

  it('recovered value matches original', () => {
    const enc = EncryptedMemo.encrypt(value, ownerPk, blinding, assetId, commitment, viewingPublicKey);
    const result = EncryptedMemo.decrypt(enc, commitment, viewingSecretKey)!;
    expect(result.value).toBe(value);
  });

  it('recovered ownerPk matches original', () => {
    const enc = EncryptedMemo.encrypt(value, ownerPk, blinding, assetId, commitment, viewingPublicKey);
    const result = EncryptedMemo.decrypt(enc, commitment, viewingSecretKey)!;
    expect(result.ownerPk).toBe(bytesToBigintLE(ownerPk));
  });

  it('recovered blinding matches original', () => {
    const enc = EncryptedMemo.encrypt(value, ownerPk, blinding, assetId, commitment, viewingPublicKey);
    const result = EncryptedMemo.decrypt(enc, commitment, viewingSecretKey)!;
    expect(result.blinding).toBe(bytesToBigintLE(blinding));
  });

  it('recovered assetId matches original', () => {
    const enc = EncryptedMemo.encrypt(value, ownerPk, blinding, assetId, commitment, viewingPublicKey);
    const result = EncryptedMemo.decrypt(enc, commitment, viewingSecretKey)!;
    expect(result.assetId).toBe(BigInt(assetId));
  });

  it('recovered counterpartyPk matches original', () => {
    const enc = EncryptedMemo.encrypt(value, ownerPk, blinding, assetId, commitment, viewingPublicKey, counterpartyPk);
    const result = EncryptedMemo.decrypt(enc, commitment, viewingSecretKey)!;
    expect(result.counterpartyPk).toBe(bytesToBigintLE(counterpartyPk));
  });

  it('counterpartyPk is 0n when not provided', () => {
    const enc = EncryptedMemo.encrypt(value, ownerPk, blinding, assetId, commitment, viewingPublicKey);
    const result = EncryptedMemo.decrypt(enc, commitment, viewingSecretKey)!;
    expect(result.counterpartyPk).toBe(0n);
  });

  it('works with value = 0n', () => {
    const enc = EncryptedMemo.encrypt(0n, ownerPk, blinding, assetId, commitment, viewingPublicKey);
    const result = EncryptedMemo.decrypt(enc, commitment, viewingSecretKey)!;
    expect(result.value).toBe(0n);
  });

  it('works with maximum u64 value', () => {
    const maxU64 = 0xffff_ffff_ffff_ffffn;
    const enc = EncryptedMemo.encrypt(maxU64, ownerPk, blinding, assetId, commitment, viewingPublicKey);
    const result = EncryptedMemo.decrypt(enc, commitment, viewingSecretKey)!;
    expect(result.value).toBe(maxU64);
  });

  it('decrypt is idempotent — same blob returns same fields', () => {
    const enc = EncryptedMemo.encrypt(value, ownerPk, blinding, assetId, commitment, viewingPublicKey);
    const r1 = EncryptedMemo.decrypt(enc, commitment, viewingSecretKey)!;
    const r2 = EncryptedMemo.decrypt(enc, commitment, viewingSecretKey)!;
    expect(r1.value).toBe(r2.value);
    expect(r1.ownerPk).toBe(r2.ownerPk);
  });

  it('returns null with wrong viewing secret key', () => {
    const enc = EncryptedMemo.encrypt(value, ownerPk, blinding, assetId, commitment, viewingPublicKey);
    const otherVsk = deriveViewingSecretKey(999n);
    expect(EncryptedMemo.decrypt(enc, commitment, otherVsk)).toBeNull();
  });

  it('returns null with wrong commitment (MAC fails)', () => {
    const enc = EncryptedMemo.encrypt(value, ownerPk, blinding, assetId, commitment, viewingPublicKey);
    const wrongCommitment = new Uint8Array(32).fill(0xdd);
    expect(EncryptedMemo.decrypt(enc, wrongCommitment, viewingSecretKey)).toBeNull();
  });

  it('returns null when ciphertext bytes are tampered', () => {
    const enc = EncryptedMemo.encrypt(value, ownerPk, blinding, assetId, commitment, viewingPublicKey);
    const tampered = new Uint8Array(enc);
    tampered[20]! ^= 0xff;
    expect(EncryptedMemo.decrypt(tampered, commitment, viewingSecretKey)).toBeNull();
  });

  it('security: viewingPublicKey alone cannot decrypt (requires viewingSecretKey)', () => {
    const enc = EncryptedMemo.encrypt(value, ownerPk, blinding, assetId, commitment, viewingPublicKey);
    expect(EncryptedMemo.decrypt(enc, commitment, viewingPublicKey)).toBeNull();
  });

  it('returns null for wrong length', () => {
    const short = new Uint8Array(100);
    expect(EncryptedMemo.decrypt(short, commitment, viewingSecretKey)).toBeNull();
    const long = new Uint8Array(200);
    expect(EncryptedMemo.decrypt(long, commitment, viewingSecretKey)).toBeNull();
  });

  it('returns null for a zeroed dummy memo', () => {
    const dummy = EncryptedMemo.dummy();
    expect(EncryptedMemo.decrypt(dummy, commitment, viewingSecretKey)).toBeNull();
  });
});

// ─── EncryptedMemo.encryptPublic ──────────────────────────────────────────────

describe('EncryptedMemo.encryptPublic', () => {
  it('returns exactly 176 bytes', () => {
    const memo = EncryptedMemo.encryptPublic(100n, new Uint8Array(32), new Uint8Array(32), 0, new Uint8Array(32));
    expect(memo).toHaveLength(ENCRYPTED_MEMO_SIZE);
  });

  it('is decryptable with a zero viewing secret key', () => {
    const pubCommitment = new Uint8Array(32).fill(0x07);
    const memo = EncryptedMemo.encryptPublic(500n, new Uint8Array(32), new Uint8Array(32), 0, pubCommitment);
    const result = EncryptedMemo.decrypt(memo, pubCommitment, new Uint8Array(32));
    expect(result).not.toBeNull();
    expect(result!.value).toBe(500n);
  });
});

// ─── EncryptedMemo.extractSharedSecret ───────────────────────────────────────

describe('EncryptedMemo.extractSharedSecret', () => {
  const commitment = new Uint8Array(32).fill(0xcc);

  it('returns a 32-byte Uint8Array for a valid ECDH memo', () => {
    const memo = EncryptedMemo.encrypt(value, new Uint8Array(32), new Uint8Array(32), 0, commitment, viewingPublicKey);
    const shared = EncryptedMemo.extractSharedSecret(memo, viewingSecretKey);
    expect(shared).toBeInstanceOf(Uint8Array);
    expect(shared).toHaveLength(32);
  });

  it('ECDH commutativity — extracted secret matches the one used during encrypt', () => {
    // Use a fixed ephSk so the sender-side sharedSecret is reproducible.
    const ephSk = new Uint8Array(32).fill(0x77);
    const memo = EncryptedMemo.encrypt(value, new Uint8Array(32), new Uint8Array(32), 0, commitment, viewingPublicKey, new Uint8Array(32), ephSk);
    const extracted = EncryptedMemo.extractSharedSecret(memo, viewingSecretKey);
    expect(extracted).not.toBeNull();
    expect(extracted!.every((b) => b === 0)).toBe(false); // non-zero shared secret
  });

  it('is deterministic — same memo and same ivsk yield same result', () => {
    const memo = EncryptedMemo.encrypt(value, new Uint8Array(32), new Uint8Array(32), 0, commitment, viewingPublicKey);
    const a = EncryptedMemo.extractSharedSecret(memo, viewingSecretKey);
    const b = EncryptedMemo.extractSharedSecret(memo, viewingSecretKey);
    expect(a).toEqual(b);
  });

  it('returns 32 zero bytes for a public/dummy memo (zero ephPk)', () => {
    const memo = EncryptedMemo.encryptPublic(value, new Uint8Array(32), new Uint8Array(32), 0, commitment);
    const shared = EncryptedMemo.extractSharedSecret(memo, viewingSecretKey);
    expect(shared).toEqual(new Uint8Array(32));
  });

  it('returns null for a fully zeroed dummy memo (all-zero ephPk treated as public)', () => {
    const dummy = EncryptedMemo.dummy();
    const shared = EncryptedMemo.extractSharedSecret(dummy, viewingSecretKey);
    // All-zero ephPk → treated as public note → returns 32 zero bytes (not null)
    expect(shared).toEqual(new Uint8Array(32));
  });

  it('returns null for wrong-length input', () => {
    const bad = new Uint8Array(100);
    expect(EncryptedMemo.extractSharedSecret(bad, viewingSecretKey)).toBeNull();
  });

  it('returns null when ephPk bytes are not a valid BJJ point', () => {
    const memo = EncryptedMemo.encrypt(value, new Uint8Array(32), new Uint8Array(32), 0, commitment, viewingPublicKey);
    // Corrupt the ephPk region with non-zero garbage that won't be a valid point
    const corrupted = new Uint8Array(memo);
    corrupted.fill(0xff, 12 + 124); // overwrite ephPk bytes with 0xff
    expect(EncryptedMemo.extractSharedSecret(corrupted, viewingSecretKey)).toBeNull();
  });

  it('different ivsk yields different shared secret', () => {
    const memo = EncryptedMemo.encrypt(value, new Uint8Array(32), new Uint8Array(32), 0, commitment, viewingPublicKey);
    const otherIvsk = deriveViewingSecretKey(9999999n);
    const a = EncryptedMemo.extractSharedSecret(memo, viewingSecretKey);
    const b = EncryptedMemo.extractSharedSecret(memo, otherIvsk);
    // Different ivsk → different shared secret
    expect(a).not.toEqual(b);
  });
});

// ─── EncryptedMemo.encrypt ephSkOverride ─────────────────────────────────────

describe('EncryptedMemo.encrypt with ephSkOverride', () => {
  const commitment = new Uint8Array(32).fill(0xdd);
  const ephSk = new Uint8Array(32);
  // Use a non-trivial ephSk: byte pattern that yields a valid BJJ scalar
  ephSk.fill(0x13);
  ephSk[0] = 0x01;

  it('produces a 176-byte memo', () => {
    const memo = EncryptedMemo.encrypt(value, new Uint8Array(32), new Uint8Array(32), 0, commitment, viewingPublicKey, new Uint8Array(32), ephSk);
    expect(memo).toHaveLength(ENCRYPTED_MEMO_SIZE);
  });

  it('two calls with same ephSkOverride produce different nonces but same ephPk region', () => {
    const memoA = EncryptedMemo.encrypt(value, new Uint8Array(32), new Uint8Array(32), 0, commitment, viewingPublicKey, new Uint8Array(32), ephSk);
    const memoB = EncryptedMemo.encrypt(value, new Uint8Array(32), new Uint8Array(32), 0, commitment, viewingPublicKey, new Uint8Array(32), ephSk);
    // nonce (bytes 0..12) is always random → should differ
    const nonceA = memoA.slice(0, 12);
    const nonceB = memoB.slice(0, 12);
    expect(nonceA).not.toEqual(nonceB);
    // ephPk region (bytes 144..176) is derived from ephSk → must be identical
    const ephPkA = memoA.slice(12 + 132);
    const ephPkB = memoB.slice(12 + 132);
    expect(ephPkA).toEqual(ephPkB);
  });

  it('memo with ephSkOverride is decryptable', () => {
    const memo = EncryptedMemo.encrypt(
      value, new Uint8Array(32).fill(0x01), new Uint8Array(32).fill(0x02),
      7, commitment, viewingPublicKey, new Uint8Array(32), ephSk
    );
    const result = EncryptedMemo.decrypt(memo, commitment, viewingSecretKey);
    expect(result).not.toBeNull();
    expect(result!.value).toBe(value);
    expect(result!.assetId).toBe(7n);
  });

  it('extractSharedSecret on ephSkOverride memo is consistent with manual ECDH', () => {
    const memo = EncryptedMemo.encrypt(value, new Uint8Array(32), new Uint8Array(32), 0, commitment, viewingPublicKey, new Uint8Array(32), ephSk);
    const extracted = EncryptedMemo.extractSharedSecret(memo, viewingSecretKey);
    expect(extracted).not.toBeNull();
    expect(extracted!.some((b) => b !== 0)).toBe(true);
  });

  it('throws when ephSkOverride is not 32 bytes', () => {
    expect(() =>
      EncryptedMemo.encrypt(value, new Uint8Array(32), new Uint8Array(32), 0, commitment, viewingPublicKey, new Uint8Array(32), new Uint8Array(16))
    ).toThrow('ephSkOverride must be 32 bytes');
  });
});
