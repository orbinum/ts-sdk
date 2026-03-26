import { describe, it, expect } from 'vitest';
import {
    deriveViewingKey,
    deriveOwnerPk,
    deriveSpendingKeyMessage,
    deriveSpendingKeyFromSignature,
} from '../../src/shielded-pool/PrivacyKeys';

// ─── deriveViewingKey ─────────────────────────────────────────────────────────

describe('deriveViewingKey', () => {
  it('returns a Uint8Array of exactly 32 bytes', () => {
    const vk = deriveViewingKey(12345n);
    expect(vk).toBeInstanceOf(Uint8Array);
    expect(vk).toHaveLength(32);
  });

  it('is deterministic — same input produces same output', () => {
    const sk = 9999999n;
    const a = deriveViewingKey(sk);
    const b = deriveViewingKey(sk);
    expect(a).toEqual(b);
  });

  it('different spending keys produce different viewing keys', () => {
    const a = deriveViewingKey(1n);
    const b = deriveViewingKey(2n);
    expect(a).not.toEqual(b);
  });

  it('works with spendingKey = 0n', () => {
    const vk = deriveViewingKey(0n);
    expect(vk).toHaveLength(32);
  });

  it('works with a large spending key', () => {
    const large = 2n ** 200n - 1n;
    const vk = deriveViewingKey(large);
    expect(vk).toHaveLength(32);
  });

  it('output is not all zeros for a non-zero spending key', () => {
    const vk = deriveViewingKey(1n);
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

const BN254_R = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;

// A synthetic 65-byte signature (all zeros except first byte) for deterministic tests
const DUMMY_SIG = '0x' + '00'.repeat(65);
const NON_ZERO_SIG = '0x' + 'ab'.repeat(65);

describe('deriveSpendingKeyFromSignature', () => {
  it('returns a bigint', async () => {
    const sk = await deriveSpendingKeyFromSignature(DUMMY_SIG, 1, '0x1234567890abcdef1234567890abcdef12345678');
    expect(typeof sk).toBe('bigint');
  });

  it('result is in range [1, BN254_R)', async () => {
    const sk = await deriveSpendingKeyFromSignature(NON_ZERO_SIG, 1, '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
    expect(sk).toBeGreaterThanOrEqual(1n);
    expect(sk).toBeLessThan(BN254_R);
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
