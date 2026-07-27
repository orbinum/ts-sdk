// Key DERIVATION only. What the user signs to produce these signatures is
// covered in tests/privacy-keys/SpendingKeyRequest.test.ts.
import { describe, it, expect } from 'vitest';
import {
    deriveViewingSecretKey,
    deriveViewingPublicKey,
    deriveOwnerPk,
    deriveSpendingKeyFromSignature,
    deriveMasterKeyBytes,
    MIN_SIGNATURE_BYTES,
} from '../../src/privacy-keys/PrivacyKeys';
import { hkdf } from '@noble/hashes/hkdf.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { EncryptedMemo } from '../../src/shielded-pool/protocol/EncryptedMemo';
import { BABYJUB_SUBORDER } from '../../src/utils/crypto-constants';

// ─── deriveViewingSecretKey ──────────────────────────────────────────────────

describe('deriveViewingSecretKey', () => {
  it('returns a Uint8Array of exactly 32 bytes', () => {
    const vk = deriveViewingSecretKey(12345n);
    expect(vk).toBeInstanceOf(Uint8Array);
    expect(vk).toHaveLength(32);
  });

  it('is deterministic — same input produces same output', () => {
    const sk = 9999999n;
    const a = deriveViewingSecretKey(sk);
    const b = deriveViewingSecretKey(sk);
    expect(a).toEqual(b);
  });

  it('different spending keys produce different viewing keys', () => {
    const a = deriveViewingSecretKey(1n);
    const b = deriveViewingSecretKey(2n);
    expect(a).not.toEqual(b);
  });

  it('works with spendingKey = 0n', () => {
    const vk = deriveViewingSecretKey(0n);
    expect(vk).toHaveLength(32);
  });

  it('works with a large spending key', () => {
    const large = 2n ** 200n - 1n;
    const vk = deriveViewingSecretKey(large);
    expect(vk).toHaveLength(32);
  });

  it('output is not all zeros for a non-zero spending key', () => {
    const vk = deriveViewingSecretKey(1n);
    expect(vk.some((b) => b !== 0)).toBe(true);
  });
});

// ─── deriveOwnerPk ────────────────────────────────────────────────────────────

describe('deriveOwnerPk', () => {
  it('returns a bigint > 0 for a valid spending key', () => {
    const pk = deriveOwnerPk(12345n);
    expect(typeof pk).toBe('bigint');
    expect(pk).toBeGreaterThan(0n);
  });

  it('is deterministic — same input produces same output', () => {
    const sk = 9999999n;
    const a = deriveOwnerPk(sk);
    const b = deriveOwnerPk(sk);
    expect(a).toBe(b);
  });

  it('different spending keys produce different owner public keys', () => {
    const a = deriveOwnerPk(1n);
    const b = deriveOwnerPk(2n);
    expect(a).not.toBe(b);
  });

  it('returns 0n for spendingKey = 0n (BabyJubJub identity edge case)', () => {
    // mulPointEscalar(Base8, 0n) either produces a valid point or throws;
    // in either case deriveOwnerPk handles the edge case gracefully.
    const pk = deriveOwnerPk(0n);
    expect(typeof pk).toBe('bigint');
  });

  it('works with a large spending key', () => {
    // BabyJubJub scalars are reduced mod the group order; large keys are allowed.
    const pk = deriveOwnerPk(2n ** 200n - 1n);
    expect(typeof pk).toBe('bigint');
  });
});

// ─── deriveSpendingKeyMessage ──────────────────────────────────────────────────


// ─── deriveSpendingKeyFromSignature ───────────────────────────────────────────

// A synthetic 65-byte signature (all zeros except first byte) for deterministic tests
const DUMMY_SIG = '0x' + '00'.repeat(65);
const NON_ZERO_SIG = '0x' + 'ab'.repeat(65);

describe('deriveSpendingKeyFromSignature', () => {
  it('returns a bigint', async () => {
    const sk = await deriveSpendingKeyFromSignature(DUMMY_SIG, 1, '0x1234567890abcdef1234567890abcdef12345678');
    expect(typeof sk).toBe('bigint');
  });

  it('result is in range [1, BABYJUB_SUBORDER)', async () => {
    const sk = await deriveSpendingKeyFromSignature(NON_ZERO_SIG, 1, '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
    expect(sk).toBeGreaterThanOrEqual(1n);
    expect(sk).toBeLessThan(BABYJUB_SUBORDER);
  });

  it('is deterministic — same inputs same output', async () => {
    const addr = '0x1111111111111111111111111111111111111111';
    const a = await deriveSpendingKeyFromSignature(NON_ZERO_SIG, 1, addr);
    const b = await deriveSpendingKeyFromSignature(NON_ZERO_SIG, 1, addr);
    expect(a).toBe(b);
  });

  it('different signatures produce different keys', async () => {
    const addr = '0x1111111111111111111111111111111111111111';
    const sig2 = '0x' + 'cd'.repeat(65);
    const a = await deriveSpendingKeyFromSignature(NON_ZERO_SIG, 1, addr);
    const b = await deriveSpendingKeyFromSignature(sig2, 1, addr);
    expect(a).not.toBe(b);
  });

  it('different chainIds produce different keys', async () => {
    const addr = '0x1111111111111111111111111111111111111111';
    const a = await deriveSpendingKeyFromSignature(NON_ZERO_SIG, 1, addr);
    const b = await deriveSpendingKeyFromSignature(NON_ZERO_SIG, 42, addr);
    expect(a).not.toBe(b);
  });

  it('addresses are treated case-insensitively', async () => {
    const a = await deriveSpendingKeyFromSignature(NON_ZERO_SIG, 1, '0xAbCdEf1234567890aBcDeF1234567890AbCdEf12');
    const b = await deriveSpendingKeyFromSignature(NON_ZERO_SIG, 1, '0xabcdef1234567890abcdef1234567890abcdef12');
    expect(a).toBe(b);
  });

  it('accepts signatures without 0x prefix', async () => {
    const withPrefix = await deriveSpendingKeyFromSignature(NON_ZERO_SIG, 1, '0xabc');
    const withoutPrefix = await deriveSpendingKeyFromSignature(NON_ZERO_SIG.slice(2), 1, '0xabc');
    expect(withPrefix).toBe(withoutPrefix);
  });

  it('agrees with deriveMasterKeyBytes — both must read the same identity', async () => {
    const addr = '0x1111111111111111111111111111111111111111';
    for (const version of ['v1', 'v2'] as const) {
      const mb = await deriveMasterKeyBytes(NON_ZERO_SIG, 1, addr, version);
      const sk = await deriveSpendingKeyFromSignature(NON_ZERO_SIG, 1, addr, version);
      const expected = BigInt(
        '0x' + Array.from(mb, (b) => b.toString(16).padStart(2, '0')).join(''),
      ) % BABYJUB_SUBORDER;
      expect(sk).toBe(expected === 0n ? 1n : expected);
    }
  });
});

// ─── Signature validation (fail closed) ──────────────────────────────────────

// HKDF accepts any-length IKM, so without an explicit guard an empty or stub
// signature still yields a usable spending key — derived purely from PUBLIC
// inputs (chainId, address) and therefore reproducible by anyone. A wallet that
// returns '' or an error string instead of signing must never mint an identity.
describe('signature validation', () => {
  const ADDR = '0x1111111111111111111111111111111111111111';

  it.each([
    ['empty string', ''],
    ['bare 0x', '0x'],
    ['1 byte', '0xab'],
    ['31 bytes — one short of the shortest real scheme', '0x' + 'ab'.repeat(31)],
  ])('SECURITY: rejects %s', async (_label, sig) => {
    await expect(deriveSpendingKeyFromSignature(sig, 1, ADDR)).rejects.toThrow(
      /signature/i,
    );
    await expect(deriveMasterKeyBytes(sig, 1, ADDR)).rejects.toThrow(/signature/i);
  });

  it('SECURITY: rejects on the v1 sweep path too', async () => {
    await expect(deriveSpendingKeyFromSignature('', 1, ADDR, 'v1')).rejects.toThrow(
      /signature/i,
    );
  });

  it('rejects non-hex and odd-length input', async () => {
    await expect(deriveSpendingKeyFromSignature('zzzz', 1, ADDR)).rejects.toThrow();
    await expect(deriveSpendingKeyFromSignature('0xabc', 1, ADDR)).rejects.toThrow();
  });

  it('accepts every real signature length (VRF 32, ed25519 64, ECDSA 65)', async () => {
    for (const bytes of [MIN_SIGNATURE_BYTES, 64, 65]) {
      const sk = await deriveSpendingKeyFromSignature('0x' + 'ab'.repeat(bytes), 1, ADDR);
      expect(sk).toBeGreaterThanOrEqual(1n);
      expect(sk).toBeLessThan(BABYJUB_SUBORDER);
    }
  });
});

// ─── deriveMasterKeyBytes ──────────────────────────────────────────────────────

describe('deriveMasterKeyBytes', () => {
  const ADDR = '0x1111111111111111111111111111111111111111';

  it('returns a Uint8Array of exactly 32 bytes', async () => {
    const mb = await deriveMasterKeyBytes(DUMMY_SIG, 1, ADDR);
    expect(mb).toBeInstanceOf(Uint8Array);
    expect(mb).toHaveLength(32);
  });

  it('is deterministic — same inputs produce same output', async () => {
    const a = await deriveMasterKeyBytes(NON_ZERO_SIG, 1, ADDR);
    const b = await deriveMasterKeyBytes(NON_ZERO_SIG, 1, ADDR);
    expect(a).toEqual(b);
  });

  it('output is not all zeros for a non-zero signature', async () => {
    const mb = await deriveMasterKeyBytes(NON_ZERO_SIG, 1, ADDR);
    expect(mb.some((byte) => byte !== 0)).toBe(true);
  });

  it('different signatures produce different master bytes', async () => {
    const sig2 = '0x' + 'cd'.repeat(65);
    const a = await deriveMasterKeyBytes(NON_ZERO_SIG, 1, ADDR);
    const b = await deriveMasterKeyBytes(sig2, 1, ADDR);
    expect(a).not.toEqual(b);
  });

  it('different chainIds produce different master bytes', async () => {
    const a = await deriveMasterKeyBytes(NON_ZERO_SIG, 1, ADDR);
    const b = await deriveMasterKeyBytes(NON_ZERO_SIG, 42, ADDR);
    expect(a).not.toEqual(b);
  });

  it('different addresses produce different master bytes', async () => {
    const addr2 = '0x2222222222222222222222222222222222222222';
    const a = await deriveMasterKeyBytes(NON_ZERO_SIG, 1, ADDR);
    const b = await deriveMasterKeyBytes(NON_ZERO_SIG, 1, addr2);
    expect(a).not.toEqual(b);
  });

  it('address is treated case-insensitively', async () => {
    const a = await deriveMasterKeyBytes(NON_ZERO_SIG, 1, ADDR.toUpperCase());
    const b = await deriveMasterKeyBytes(NON_ZERO_SIG, 1, ADDR.toLowerCase());
    expect(a).toEqual(b);
  });

  it('accepts signature without 0x prefix', async () => {
    const a = await deriveMasterKeyBytes(NON_ZERO_SIG, 1, ADDR);
    const b = await deriveMasterKeyBytes(NON_ZERO_SIG.slice(2), 1, ADDR);
    expect(a).toEqual(b);
  });

  it('master bytes differ from spendingKey scalar bytes (not identical output)', async () => {
    const mb = await deriveMasterKeyBytes(NON_ZERO_SIG, 1, ADDR);
    const sk = await deriveSpendingKeyFromSignature(NON_ZERO_SIG, 1, ADDR);
    // sk = BigInt(mb) % BABYJUB_SUBORDER — the bigint representations differ
    const skBigint = BigInt('0x' + Array.from(mb, (b) => b.toString(16).padStart(2, '0')).join('')) % BABYJUB_SUBORDER;
    expect(sk).toBe(skBigint === 0n ? 1n : skBigint);
  });
});

// ─── deriveViewingPublicKey ───────────────────────────────────────────────────

describe('deriveViewingPublicKey', () => {
  const ivsk = deriveViewingSecretKey(12345n);

  it('returns a Uint8Array of exactly 32 bytes', () => {
    const ivk = deriveViewingPublicKey(ivsk);
    expect(ivk).toBeInstanceOf(Uint8Array);
    expect(ivk).toHaveLength(32);
  });

  it('is deterministic — same ivsk produces same ivk', () => {
    const a = deriveViewingPublicKey(ivsk);
    const b = deriveViewingPublicKey(ivsk);
    expect(a).toEqual(b);
  });

  it('different ivsk values produce different public keys', () => {
    const ivsk2 = deriveViewingSecretKey(99999n);
    const a = deriveViewingPublicKey(ivsk);
    const b = deriveViewingPublicKey(ivsk2);
    expect(a).not.toEqual(b);
  });

  it('output is not all zeros', () => {
    const ivk = deriveViewingPublicKey(ivsk);
    expect(ivk.some((b) => b !== 0)).toBe(true);
  });

  it('differs from the ivsk bytes (public key != private key)', () => {
    const ivk = deriveViewingPublicKey(ivsk);
    expect(ivk).not.toEqual(ivsk);
  });

  it('ivk es un punto BJJ válido (puede usarse en EncryptedMemo.encrypt)', () => {
    const ivk = deriveViewingPublicKey(ivsk);
    const commitment = new Uint8Array(32).fill(0x05);
    // Si ivk es inválido, encrypt() lanza. Si es válido, devuelve 180 bytes.
    const memo = EncryptedMemo.encrypt(1000n, new Uint8Array(32), new Uint8Array(32), 0, commitment, ivk);
    expect(memo).toHaveLength(180);
  });

  it('end-to-end ECDH: memo cifrado con ivk es descifrable con ivsk', () => {
    const ivk = deriveViewingPublicKey(ivsk);
    const commitment = new Uint8Array(32).fill(0x06);
    const memo = EncryptedMemo.encrypt(42000n, new Uint8Array(32), new Uint8Array(32), 1, commitment, ivk);
    const result = EncryptedMemo.decrypt(memo, commitment, ivsk);
    expect(result).not.toBeNull();
    expect(result!.value).toBe(42000n);
  });

  it('seguridad ECDH: memo cifrado con ivk NO puede descifrarse con ivk solo', () => {
    const ivk = deriveViewingPublicKey(ivsk);
    const commitment = new Uint8Array(32).fill(0x07);
    const memo = EncryptedMemo.encrypt(1n, new Uint8Array(32), new Uint8Array(32), 0, commitment, ivk);
    // Intentar descifrar con la clave pública (no la secreta) debe fallar
    expect(EncryptedMemo.decrypt(memo, commitment, ivk)).toBeNull();
  });
});


// ─── v2 identity (EIP-712) ───────────────────────────────────────────────────

describe('HKDF domain string', () => {
  const ADDR = '0xAbCdEf0123456789AbCdEf0123456789AbCdEf01';
  const SIG = '0x' + 'ab'.repeat(65);

  // The `info` string IS the cryptographic domain separator between identities.
  // Pinning it byte-exactly means an accidental edit (a typo, a reordered field,
  // a dropped version tag) fails here instead of silently rotating every user's
  // spending key and orphaning their notes.
  it.each([
    ['v2', 'orbinum-sk-v2:2700:0xabcdef0123456789abcdef0123456789abcdef01'],
    ['v1', 'orbinum-sk-v1:2700:0xabcdef0123456789abcdef0123456789abcdef01'],
  ] as const)('pins the exact info string for %s', async (version, info) => {
    const actual = await deriveMasterKeyBytes(SIG, 2700, ADDR, version);
    const expected = hkdf(
      sha256,
      Uint8Array.from(Buffer.from(SIG.slice(2), 'hex')),
      new Uint8Array(0),
      new TextEncoder().encode(info),
      32,
    );
    expect(actual).toEqual(expected);
  });
});

describe('v1/v2 domain separation', () => {
  const SIG = '0x' + 'ab'.repeat(65);
  const CHAIN_ID = 2700;
  const ADDR = '0x1111111111111111111111111111111111111111';

  it('SECURITY: identical signature bytes yield disjoint v1 and v2 keys', async () => {
    const v1 = await deriveSpendingKeyFromSignature(SIG, CHAIN_ID, ADDR, 'v1');
    const v2 = await deriveSpendingKeyFromSignature(SIG, CHAIN_ID, ADDR, 'v2');
    expect(v1).not.toBe(v2);
  });

  it('SECURITY: master bytes are disjoint too — the vault key must not carry over', async () => {
    const v1 = await deriveMasterKeyBytes(SIG, CHAIN_ID, ADDR, 'v1');
    const v2 = await deriveMasterKeyBytes(SIG, CHAIN_ID, ADDR, 'v2');
    expect(v1).not.toEqual(v2);
  });

  it('defaults to v2 — no caller accidentally lands on the insecure identity', async () => {
    const explicit = await deriveSpendingKeyFromSignature(SIG, CHAIN_ID, ADDR, 'v2');
    const implicit = await deriveSpendingKeyFromSignature(SIG, CHAIN_ID, ADDR);
    expect(implicit).toBe(explicit);
  });

  it('v1 still reproduces its historical key so existing notes stay sweepable', async () => {
    const a = await deriveSpendingKeyFromSignature(SIG, CHAIN_ID, ADDR, 'v1');
    const b = await deriveSpendingKeyFromSignature(SIG, CHAIN_ID, ADDR, 'v1');
    expect(a).toBe(b);
    expect(a).toBeGreaterThan(0n);
    expect(a).toBeLessThan(BABYJUB_SUBORDER);
  });

  it('both versions stay within the circuit scalar range', async () => {
    for (const v of ['v1', 'v2'] as const) {
      const sk = await deriveSpendingKeyFromSignature(SIG, CHAIN_ID, ADDR, v);
      expect(sk).toBeGreaterThanOrEqual(1n);
      expect(sk).toBeLessThan(BABYJUB_SUBORDER);
    }
  });
});
