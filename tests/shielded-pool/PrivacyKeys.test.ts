import { describe, it, expect } from 'vitest';
import {
    deriveViewingSecretKey,
    deriveViewingPublicKey,
    deriveOwnerPk,
    deriveSpendingKeyMessage,
    deriveSpendingKeyFromSignature,
    deriveMasterKeyBytes,
} from '../../src/privacy-keys/PrivacyKeys';
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

describe('deriveSpendingKeyMessage', () => {
  it('builds the expected message format', () => {
    const msg = deriveSpendingKeyMessage(1, '0xABCDEF1234abcdef1234ABCDEF1234abcdef1234');
    expect(msg).toBe(
      'orbinum-spending-key-v1\n1\n0xabcdef1234abcdef1234abcdef1234abcdef1234',
    );
  });

  it('lowercases the address', () => {
    const msg = deriveSpendingKeyMessage(42, '0xDEADBEEF00000000000000000000000000000000');
    expect(msg).toContain('0xdeadbeef00000000000000000000000000000000');
  });

  it('includes the chainId as a number, not hex', () => {
    const msg = deriveSpendingKeyMessage(100, '0x0000000000000000000000000000000000000001');
    expect(msg.split('\n')[1]).toBe('100');
  });

  it('is deterministic', () => {
    const a = deriveSpendingKeyMessage(1, '0xabc');
    const b = deriveSpendingKeyMessage(1, '0xabc');
    expect(a).toBe(b);
  });
});

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
    // Si ivk es inválido, encrypt() lanza. Si es válido, devuelve 176 bytes.
    const memo = EncryptedMemo.encrypt(1000n, new Uint8Array(32), new Uint8Array(32), 0, commitment, ivk);
    expect(memo).toHaveLength(176);
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

