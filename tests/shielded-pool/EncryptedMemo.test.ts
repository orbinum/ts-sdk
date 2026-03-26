import { describe, it, expect } from 'vitest';
import { EncryptedMemo, ENCRYPTED_MEMO_SIZE } from '../../src/shielded-pool/EncryptedMemo';
import { sha256 } from '@noble/hashes/sha2.js';
import { chacha20poly1305 } from '@noble/ciphers/chacha.js';

// ─── Inline decrypt helper ────────────────────────────────────────────────────
// Mirrors the encryption logic to enable round-trip verification.
// Key: SHA256(viewingKey || commitment || "orbinum-note-encryption-v1")
// Cipher: ChaCha20-Poly1305, nonce = first 12 bytes of the encrypted blob.
function decrypt(encrypted: Uint8Array, viewingKey: Uint8Array, commitment: Uint8Array): Uint8Array {
  const domain = new TextEncoder().encode('orbinum-note-encryption-v1');
  const h = sha256.create();
  h.update(viewingKey);
  h.update(commitment);
  h.update(domain);
  const key = h.digest();
  const nonce = encrypted.slice(0, 12);
  const ciphertext = encrypted.slice(12);
  const cipher = chacha20poly1305(key, nonce);
  return cipher.decrypt(ciphertext);
}

// ─── ENCRYPTED_MEMO_SIZE ──────────────────────────────────────────────────────

describe('ENCRYPTED_MEMO_SIZE', () => {
  it('equals 104', () => {
    expect(ENCRYPTED_MEMO_SIZE).toBe(104);
  });
});

// ─── EncryptedMemo.dummy ──────────────────────────────────────────────────────

describe('EncryptedMemo.dummy', () => {
  it('returns exactly 104 bytes', () => {
    expect(EncryptedMemo.dummy()).toHaveLength(104);
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
  const value = 1_000_000n;
  const ownerPk = new Uint8Array(32).fill(0x01);
  const blinding = new Uint8Array(32).fill(0x02);
  const assetId = 3;
  const commitment = new Uint8Array(32).fill(0x04);
  const viewingKey = new Uint8Array(32).fill(0x05);

  it('returns exactly 104 bytes', () => {
    const memo = EncryptedMemo.encrypt(value, ownerPk, blinding, assetId, commitment, viewingKey);
    expect(memo).toHaveLength(ENCRYPTED_MEMO_SIZE);
  });

  it('returns a Uint8Array', () => {
    const memo = EncryptedMemo.encrypt(value, ownerPk, blinding, assetId, commitment, viewingKey);
    expect(memo).toBeInstanceOf(Uint8Array);
  });

  it('nonce (first 12 bytes) differs between calls', () => {
    // Random nonce guarantees non-determinism with overwhelming probability
    const a = EncryptedMemo.encrypt(value, ownerPk, blinding, assetId, commitment, viewingKey);
    const b = EncryptedMemo.encrypt(value, ownerPk, blinding, assetId, commitment, viewingKey);
    expect(a.slice(0, 12)).not.toEqual(b.slice(0, 12));
  });

  it('round-trip: decrypt recovers value (u64 LE at offset 0)', () => {
    const memo = EncryptedMemo.encrypt(value, ownerPk, blinding, assetId, commitment, viewingKey);
    const plain = decrypt(memo, viewingKey, commitment);
    const dv = new DataView(plain.buffer);
    expect(dv.getBigUint64(0, true)).toBe(value);
  });

  it('round-trip: decrypt recovers ownerPk at offset 8', () => {
    const memo = EncryptedMemo.encrypt(value, ownerPk, blinding, assetId, commitment, viewingKey);
    const plain = decrypt(memo, viewingKey, commitment);
    expect(plain.slice(8, 40)).toEqual(ownerPk);
  });

  it('round-trip: decrypt recovers blinding at offset 40', () => {
    const memo = EncryptedMemo.encrypt(value, ownerPk, blinding, assetId, commitment, viewingKey);
    const plain = decrypt(memo, viewingKey, commitment);
    expect(plain.slice(40, 72)).toEqual(blinding);
  });

  it('round-trip: decrypt recovers assetId at offset 72 (u32 LE)', () => {
    const memo = EncryptedMemo.encrypt(value, ownerPk, blinding, assetId, commitment, viewingKey);
    const plain = decrypt(memo, viewingKey, commitment);
    const dv = new DataView(plain.buffer);
    expect(dv.getUint32(72, true)).toBe(assetId);
  });

  it('fails to decrypt with wrong viewing key', () => {
    const memo = EncryptedMemo.encrypt(value, ownerPk, blinding, assetId, commitment, viewingKey);
    const wrongKey = new Uint8Array(32).fill(0xff);
    expect(() => decrypt(memo, wrongKey, commitment)).toThrow();
  });

  it('fails to decrypt with wrong commitment', () => {
    const memo = EncryptedMemo.encrypt(value, ownerPk, blinding, assetId, commitment, viewingKey);
    const wrongCommitment = new Uint8Array(32).fill(0xdd);
    expect(() => decrypt(memo, viewingKey, wrongCommitment)).toThrow();
  });

  it('works with value = 0n', () => {
    const memo = EncryptedMemo.encrypt(0n, ownerPk, blinding, assetId, commitment, viewingKey);
    const plain = decrypt(memo, viewingKey, commitment);
    const dv = new DataView(plain.buffer);
    expect(dv.getBigUint64(0, true)).toBe(0n);
  });

  it('works with maximum u64 value', () => {
    const maxU64 = 0xffff_ffff_ffff_ffffn;
    const memo = EncryptedMemo.encrypt(maxU64, ownerPk, blinding, assetId, commitment, viewingKey);
    const plain = decrypt(memo, viewingKey, commitment);
    const dv = new DataView(plain.buffer);
    expect(dv.getBigUint64(0, true)).toBe(maxU64);
  });
});

// ─── EncryptedMemo.encryptPublic ──────────────────────────────────────────────

describe('EncryptedMemo.encryptPublic', () => {
  it('returns exactly 104 bytes', () => {
    const memo = EncryptedMemo.encryptPublic(
      100n,
      new Uint8Array(32),
      new Uint8Array(32),
      0,
      new Uint8Array(32),
    );
    expect(memo).toHaveLength(ENCRYPTED_MEMO_SIZE);
  });

  it('is decryptable with a zero viewing key', () => {
    const value = 500n;
    const commitment = new Uint8Array(32).fill(0x07);
    const memo = EncryptedMemo.encryptPublic(
      value,
      new Uint8Array(32),
      new Uint8Array(32),
      0,
      commitment,
    );
    const plain = decrypt(memo, new Uint8Array(32), commitment);
    const dv = new DataView(plain.buffer);
    expect(dv.getBigUint64(0, true)).toBe(value);
  });
});
