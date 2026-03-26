import { describe, it, expect, beforeEach } from 'vitest';
import { PrivacyKeyManager } from '../../src/shielded-pool/PrivacyKeyManager';
import { deriveViewingKey, deriveOwnerPk } from '../../src/shielded-pool/PrivacyKeys';
import { bigintTo32Le } from '../../src/utils/bytes';

const BN254_R = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;

const TEST_SK = 12345678901234567890n;

// Ensure clean state before each test
beforeEach(() => {
  PrivacyKeyManager.clear();
});

// ─── load / isLoaded / clear ──────────────────────────────────────────────────

describe('PrivacyKeyManager.load / isLoaded / clear', () => {
  it('starts unloaded', () => {
    expect(PrivacyKeyManager.isLoaded()).toBe(false);
  });

  it('isLoaded returns true after load()', async () => {
    await PrivacyKeyManager.load(TEST_SK);
    expect(PrivacyKeyManager.isLoaded()).toBe(true);
  });

  it('clear() unloads the key', async () => {
    await PrivacyKeyManager.load(TEST_SK);
    PrivacyKeyManager.clear();
    expect(PrivacyKeyManager.isLoaded()).toBe(false);
  });

  it('loading a second key replaces the first', async () => {
    await PrivacyKeyManager.load(1n);
    await PrivacyKeyManager.load(2n);
    expect(PrivacyKeyManager.getSpendingKey()).toBe(2n);
  });
});

// ─── getSpendingKey ───────────────────────────────────────────────────────────

describe('PrivacyKeyManager.getSpendingKey', () => {
  it('returns the spending key after load()', async () => {
    await PrivacyKeyManager.load(TEST_SK);
    expect(PrivacyKeyManager.getSpendingKey()).toBe(TEST_SK);
  });

  it('throws if not loaded', () => {
    expect(() => PrivacyKeyManager.getSpendingKey()).toThrow(/no key loaded/i);
  });
});

// ─── getViewingKey ────────────────────────────────────────────────────────────

describe('PrivacyKeyManager.getViewingKey', () => {
  it('returns a 32-byte Uint8Array equal to deriveViewingKey(sk)', async () => {
    await PrivacyKeyManager.load(TEST_SK);
    const vk = PrivacyKeyManager.getViewingKey();
    expect(vk).toBeInstanceOf(Uint8Array);
    expect(vk).toHaveLength(32);
    expect(vk).toEqual(deriveViewingKey(TEST_SK));
  });

  it('throws if not loaded', () => {
    expect(() => PrivacyKeyManager.getViewingKey()).toThrow(/no key loaded/i);
  });
});

// ─── getOwnerPk ───────────────────────────────────────────────────────────────

describe('PrivacyKeyManager.getOwnerPk', () => {
  it('returns a bigint equal to deriveOwnerPk(sk)', async () => {
    await PrivacyKeyManager.load(TEST_SK);
    const pk = PrivacyKeyManager.getOwnerPk();
    expect(typeof pk).toBe('bigint');
    expect(pk).toBe(deriveOwnerPk(TEST_SK));
  });

  it('throws if not loaded', () => {
    expect(() => PrivacyKeyManager.getOwnerPk()).toThrow(/no key loaded/i);
  });
});

// ─── getSpendingKeyBytes ──────────────────────────────────────────────────────

describe('PrivacyKeyManager.getSpendingKeyBytes', () => {
  it('returns bigintTo32Le(spendingKey)', async () => {
    await PrivacyKeyManager.load(TEST_SK);
    const bytes = PrivacyKeyManager.getSpendingKeyBytes();
    expect(bytes).toEqual(bigintTo32Le(TEST_SK));
  });

  it('throws if not loaded', () => {
    expect(() => PrivacyKeyManager.getSpendingKeyBytes()).toThrow(/no key loaded/i);
  });
});

// ─── exportHex ────────────────────────────────────────────────────────────────

describe('PrivacyKeyManager.exportHex', () => {
  it('returns a 0x-prefixed 64-char hex string', async () => {
    await PrivacyKeyManager.load(TEST_SK);
    const hex = PrivacyKeyManager.exportHex();
    expect(hex).toMatch(/^0x[0-9a-f]{64}$/);
  });

  it('hex encodes spending key correctly', async () => {
    await PrivacyKeyManager.load(1n);
    expect(PrivacyKeyManager.exportHex()).toBe('0x' + '0'.repeat(63) + '1');
  });

  it('throws if not loaded', () => {
    expect(() => PrivacyKeyManager.exportHex()).toThrow(/no key loaded/i);
  });
});

// ─── importFromHex ────────────────────────────────────────────────────────────

describe('PrivacyKeyManager.importFromHex', () => {
  it('loads the spending key from a valid hex string', async () => {
    await PrivacyKeyManager.load(TEST_SK);
    const hex = PrivacyKeyManager.exportHex();
    PrivacyKeyManager.clear();

    await PrivacyKeyManager.importFromHex(hex);
    expect(PrivacyKeyManager.getSpendingKey()).toBe(TEST_SK);
  });

  it('accepts hex without 0x prefix', async () => {
    await PrivacyKeyManager.load(TEST_SK);
    const hex = PrivacyKeyManager.exportHex().slice(2); // strip 0x
    PrivacyKeyManager.clear();

    await PrivacyKeyManager.importFromHex(hex);
    expect(PrivacyKeyManager.getSpendingKey()).toBe(TEST_SK);
  });

  it('rounds-trips through exportHex → importFromHex', async () => {
    await PrivacyKeyManager.load(TEST_SK);
    const hex = PrivacyKeyManager.exportHex();
    const vk = PrivacyKeyManager.getViewingKey();
    const pk = PrivacyKeyManager.getOwnerPk();

    PrivacyKeyManager.clear();
    await PrivacyKeyManager.importFromHex(hex);

    expect(PrivacyKeyManager.getSpendingKey()).toBe(TEST_SK);
    expect(PrivacyKeyManager.getViewingKey()).toEqual(vk);
    expect(PrivacyKeyManager.getOwnerPk()).toBe(pk);
  });

  it('throws for key = 0', async () => {
    await expect(
      PrivacyKeyManager.importFromHex('0x' + '0'.repeat(64)),
    ).rejects.toThrow(/invalid spending key/i);
  });

  it('throws for key >= BN254_R', async () => {
    const tooBig = '0x' + BN254_R.toString(16);
    await expect(PrivacyKeyManager.importFromHex(tooBig)).rejects.toThrow(/invalid spending key/i);
  });
});
