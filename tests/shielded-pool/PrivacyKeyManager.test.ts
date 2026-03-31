import { describe, it, expect, beforeEach } from 'vitest';
import { PrivacyKeyManager } from '../../src/shielded-pool/PrivacyKeyManager';
import { deriveViewingKey, deriveOwnerPk } from '../../src/shielded-pool/PrivacyKeys';
import { bigintTo32Le } from '../../src/utils/bytes';
import { BN254_R } from '../../src/shielded-pool/constants';

const TEST_SK = 12345678901234567890n;

let pkm: PrivacyKeyManager;

// Ensure a fresh instance before each test
beforeEach(() => {
  pkm = new PrivacyKeyManager();
});

// ─── load / isLoaded / clear ──────────────────────────────────────────────────

describe('pkm.load / isLoaded / clear', () => {
  it('starts unloaded', () => {
    expect(pkm.isLoaded()).toBe(false);
  });

  it('isLoaded returns true after load()', async () => {
    await pkm.load(TEST_SK);
    expect(pkm.isLoaded()).toBe(true);
  });

  it('clear() unloads the key', async () => {
    await pkm.load(TEST_SK);
    pkm.clear();
    expect(pkm.isLoaded()).toBe(false);
  });

  it('loading a second key replaces the first', async () => {
    await pkm.load(1n);
    await pkm.load(2n);
    expect(pkm.getSpendingKey()).toBe(2n);
  });
});

// ─── getSpendingKey ───────────────────────────────────────────────────────────

describe('pkm.getSpendingKey', () => {
  it('returns the spending key after load()', async () => {
    await pkm.load(TEST_SK);
    expect(pkm.getSpendingKey()).toBe(TEST_SK);
  });

  it('throws if not loaded', () => {
    expect(() => pkm.getSpendingKey()).toThrow(/no key loaded/i);
  });
});

// ─── getViewingKey ────────────────────────────────────────────────────────────

describe('pkm.getViewingKey', () => {
  it('returns a 32-byte Uint8Array equal to deriveViewingKey(sk)', async () => {
    await pkm.load(TEST_SK);
    const vk = pkm.getViewingKey();
    expect(vk).toBeInstanceOf(Uint8Array);
    expect(vk).toHaveLength(32);
    expect(vk).toEqual(deriveViewingKey(TEST_SK));
  });

  it('throws if not loaded', () => {
    expect(() => pkm.getViewingKey()).toThrow(/no key loaded/i);
  });
});

// ─── getOwnerPk ───────────────────────────────────────────────────────────────

describe('pkm.getOwnerPk', () => {
  it('returns a bigint equal to deriveOwnerPk(sk)', async () => {
    await pkm.load(TEST_SK);
    const pk = pkm.getOwnerPk();
    expect(typeof pk).toBe('bigint');
    expect(pk).toBe(deriveOwnerPk(TEST_SK));
  });

  it('throws if not loaded', () => {
    expect(() => pkm.getOwnerPk()).toThrow(/no key loaded/i);
  });
});

// ─── getSpendingKeyBytes ──────────────────────────────────────────────────────

describe('pkm.getSpendingKeyBytes', () => {
  it('returns bigintTo32Le(spendingKey)', async () => {
    await pkm.load(TEST_SK);
    const bytes = pkm.getSpendingKeyBytes();
    expect(bytes).toEqual(bigintTo32Le(TEST_SK));
  });

  it('throws if not loaded', () => {
    expect(() => pkm.getSpendingKeyBytes()).toThrow(/no key loaded/i);
  });
});

// ─── exportHex ────────────────────────────────────────────────────────────────

describe('pkm.exportHex', () => {
  it('returns a 0x-prefixed 64-char hex string', async () => {
    await pkm.load(TEST_SK);
    const hex = pkm.exportHex();
    expect(hex).toMatch(/^0x[0-9a-f]{64}$/);
  });

  it('hex encodes spending key correctly', async () => {
    await pkm.load(1n);
    expect(pkm.exportHex()).toBe('0x' + '0'.repeat(63) + '1');
  });

  it('throws if not loaded', () => {
    expect(() => pkm.exportHex()).toThrow(/no key loaded/i);
  });
});

// ─── importFromHex ────────────────────────────────────────────────────────────

describe('pkm.importFromHex', () => {
  it('loads the spending key from a valid hex string', async () => {
    await pkm.load(TEST_SK);
    const hex = pkm.exportHex();
    pkm.clear();

    await pkm.importFromHex(hex);
    expect(pkm.getSpendingKey()).toBe(TEST_SK);
  });

  it('accepts hex without 0x prefix', async () => {
    await pkm.load(TEST_SK);
    const hex = pkm.exportHex().slice(2); // strip 0x
    pkm.clear();

    await pkm.importFromHex(hex);
    expect(pkm.getSpendingKey()).toBe(TEST_SK);
  });

  it('rounds-trips through exportHex → importFromHex', async () => {
    await pkm.load(TEST_SK);
    const hex = pkm.exportHex();
    const vk = pkm.getViewingKey();
    const pk = pkm.getOwnerPk();

    pkm.clear();
    await pkm.importFromHex(hex);

    expect(pkm.getSpendingKey()).toBe(TEST_SK);
    expect(pkm.getViewingKey()).toEqual(vk);
    expect(pkm.getOwnerPk()).toBe(pk);
  });

  it('throws for key = 0', async () => {
    await expect(
      pkm.importFromHex('0x' + '0'.repeat(64)),
    ).rejects.toThrow(/invalid spending key/i);
  });

  it('throws for key >= BN254_R', async () => {
    const tooBig = '0x' + BN254_R.toString(16);
    await expect(pkm.importFromHex(tooBig)).rejects.toThrow(/invalid spending key/i);
  });
});
