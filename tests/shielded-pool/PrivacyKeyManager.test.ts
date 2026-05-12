import { describe, it, expect, beforeEach } from 'vitest';
import { PrivacyKeyManager } from '../../src/privacy-keys/PrivacyKeyManager';
import { deriveViewingSecretKey, deriveOwnerPk } from '../../src/privacy-keys/PrivacyKeys';
import { bigintTo32Le } from '../../src/utils/bytes';
import { BABYJUB_SUBORDER } from '../../src/utils/crypto-constants';

// ─── Fixtures ─────────────────────────────────────────────────────────────────

// Stable 32-byte master bytes fixture (deterministic, distinct from all-zeros)
const MASTER_BYTES = new Uint8Array(32).fill(0xab);

// Expected sk derived from MASTER_BYTES (same formula as importFromHex)
const MASTER_BIGINT = BigInt('0x' + Array.from(MASTER_BYTES, (b) => b.toString(16).padStart(2, '0')).join(''));
const TEST_SK = MASTER_BIGINT % BABYJUB_SUBORDER || 1n;

// Second distinct masterBytes for isolation tests
const OTHER_MASTER_BYTES = new Uint8Array(32).fill(0x12);
const OTHER_BIGINT = BigInt('0x' + Array.from(OTHER_MASTER_BYTES, (b) => b.toString(16).padStart(2, '0')).join(''));
const OTHER_SK = OTHER_BIGINT % BABYJUB_SUBORDER || 1n;

const MASTER_HEX = 'mk:0x' + Array.from(MASTER_BYTES, (b) => b.toString(16).padStart(2, '0')).join('');

let pkm: PrivacyKeyManager;

beforeEach(() => {
  pkm = new PrivacyKeyManager();
});

// ─── load / isLoaded / clear ──────────────────────────────────────────────────

describe('pkm.load / isLoaded / clear', () => {
  it('starts unloaded', () => {
    expect(pkm.isLoaded()).toBe(false);
  });

  it('isLoaded returns true after load()', async () => {
    await pkm.load(TEST_SK, MASTER_BYTES);
    expect(pkm.isLoaded()).toBe(true);
  });

  it('clear() unloads the key', async () => {
    await pkm.load(TEST_SK, MASTER_BYTES);
    pkm.clear();
    expect(pkm.isLoaded()).toBe(false);
  });

  it('loading a second key replaces the first', async () => {
    await pkm.load(TEST_SK, MASTER_BYTES);
    await pkm.load(OTHER_SK, OTHER_MASTER_BYTES);
    expect(pkm.getSpendingKey()).toBe(OTHER_SK);
    expect(pkm.getMasterBytes()).toEqual(OTHER_MASTER_BYTES);
  });
});

// ─── getSpendingKey ───────────────────────────────────────────────────────────

describe('pkm.getSpendingKey', () => {
  it('returns the spending key after load()', async () => {
    await pkm.load(TEST_SK, MASTER_BYTES);
    expect(pkm.getSpendingKey()).toBe(TEST_SK);
  });

  it('throws if not loaded', () => {
    expect(() => pkm.getSpendingKey()).toThrow(/no key loaded/i);
  });
});

// ─── getMasterBytes ───────────────────────────────────────────────────────────

describe('pkm.getMasterBytes', () => {
  it('returns the master bytes after load()', async () => {
    await pkm.load(TEST_SK, MASTER_BYTES);
    expect(pkm.getMasterBytes()).toEqual(MASTER_BYTES);
  });

  it('returns a Uint8Array of exactly 32 bytes', async () => {
    await pkm.load(TEST_SK, MASTER_BYTES);
    const mb = pkm.getMasterBytes();
    expect(mb).toBeInstanceOf(Uint8Array);
    expect(mb).toHaveLength(32);
  });

  it('throws if not loaded', () => {
    expect(() => pkm.getMasterBytes()).toThrow(/no key loaded/i);
  });

  it('is cleared by clear()', async () => {
    await pkm.load(TEST_SK, MASTER_BYTES);
    pkm.clear();
    expect(() => pkm.getMasterBytes()).toThrow(/no key loaded/i);
  });

  it('different masterBytes are stored independently', async () => {
    await pkm.load(TEST_SK, MASTER_BYTES);
    expect(pkm.getMasterBytes()).toEqual(MASTER_BYTES);
    expect(pkm.getMasterBytes()).not.toEqual(OTHER_MASTER_BYTES);
  });
});

// ─── getViewingSecretKey ─────────────────────────────────────────────────────────────────────────

describe('pkm.getViewingSecretKey', () => {
  it('returns a 32-byte Uint8Array equal to deriveViewingSecretKey(sk)', async () => {
    await pkm.load(TEST_SK, MASTER_BYTES);
    const vk = pkm.getViewingSecretKey();
    expect(vk).toBeInstanceOf(Uint8Array);
    expect(vk).toHaveLength(32);
    expect(vk).toEqual(deriveViewingSecretKey(TEST_SK));
  });

  it('throws if not loaded', () => {
    expect(() => pkm.getViewingSecretKey()).toThrow(/no key loaded/i);
  });
});

// ─── getOwnerPk ───────────────────────────────────────────────────────────────

describe('pkm.getOwnerPk', () => {
  it('returns a bigint equal to deriveOwnerPk(sk)', async () => {
    await pkm.load(TEST_SK, MASTER_BYTES);
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
    await pkm.load(TEST_SK, MASTER_BYTES);
    const bytes = pkm.getSpendingKeyBytes();
    expect(bytes).toEqual(bigintTo32Le(TEST_SK));
  });

  it('throws if not loaded', () => {
    expect(() => pkm.getSpendingKeyBytes()).toThrow(/no key loaded/i);
  });
});

// ─── exportHex ────────────────────────────────────────────────────────────────

describe('pkm.exportHex', () => {
  it('returns a "mk:0x"-prefixed string with 64 hex digits', async () => {
    await pkm.load(TEST_SK, MASTER_BYTES);
    const hex = pkm.exportHex();
    expect(hex).toMatch(/^mk:0x[0-9a-f]{64}$/);
  });

  it('encodes masterBytes (not spendingKey scalar) in hex', async () => {
    await pkm.load(TEST_SK, MASTER_BYTES);
    expect(pkm.exportHex()).toBe(MASTER_HEX);
  });

  it('different masterBytes produce different exportHex output', async () => {
    await pkm.load(TEST_SK, MASTER_BYTES);
    const h1 = pkm.exportHex();
    await pkm.load(OTHER_SK, OTHER_MASTER_BYTES);
    const h2 = pkm.exportHex();
    expect(h1).not.toBe(h2);
  });

  it('is deterministic for the same masterBytes', async () => {
    await pkm.load(TEST_SK, MASTER_BYTES);
    expect(pkm.exportHex()).toBe(pkm.exportHex());
  });

  it('throws if not loaded', () => {
    expect(() => pkm.exportHex()).toThrow(/no key loaded/i);
  });
});

// ─── importFromHex ────────────────────────────────────────────────────────────

describe('pkm.importFromHex', () => {
  it('loads the correct spendingKey from a valid "mk:0x" string', async () => {
    await pkm.importFromHex(MASTER_HEX);
    expect(pkm.getSpendingKey()).toBe(TEST_SK);
  });

  it('loads the correct masterBytes from a valid "mk:0x" string', async () => {
    await pkm.importFromHex(MASTER_HEX);
    expect(pkm.getMasterBytes()).toEqual(MASTER_BYTES);
  });

  it('accepts "mk:" without inner "0x" prefix', async () => {
    const noInnerPrefix = 'mk:' + Array.from(MASTER_BYTES, (b) => b.toString(16).padStart(2, '0')).join('');
    await pkm.importFromHex(noInnerPrefix);
    expect(pkm.getMasterBytes()).toEqual(MASTER_BYTES);
  });

  it('sets isLoaded() to true after import', async () => {
    await pkm.importFromHex(MASTER_HEX);
    expect(pkm.isLoaded()).toBe(true);
  });

  it('round-trips through exportHex → importFromHex', async () => {
    await pkm.load(TEST_SK, MASTER_BYTES);
    const exported = pkm.exportHex();
    const vk = pkm.getViewingSecretKey();
    const pk = pkm.getOwnerPk();

    pkm.clear();
    await pkm.importFromHex(exported);

    expect(pkm.getMasterBytes()).toEqual(MASTER_BYTES);
    expect(pkm.getSpendingKey()).toBe(TEST_SK);
    expect(pkm.getViewingSecretKey()).toEqual(vk);
    expect(pkm.getOwnerPk()).toBe(pk);
  });

  it('throws if format does not start with "mk:" (legacy plain hex rejected)', async () => {
    const plainHex = '0x' + Array.from(MASTER_BYTES, (b) => b.toString(16).padStart(2, '0')).join('');
    await expect(pkm.importFromHex(plainHex)).rejects.toThrow(/invalid cache format/i);
    expect(pkm.isLoaded()).toBe(false);
  });

  it('throws for empty string', async () => {
    await expect(pkm.importFromHex('')).rejects.toThrow();
    expect(pkm.isLoaded()).toBe(false);
  });

  it('throws if decoded bytes are not exactly 32 bytes (too short — 31 bytes)', async () => {
    const short = 'mk:0x' + 'ab'.repeat(31);
    await expect(pkm.importFromHex(short)).rejects.toThrow(/32 bytes/i);
  });

  it('throws if decoded bytes are not exactly 32 bytes (too long — 33 bytes)', async () => {
    const long = 'mk:0x' + 'ab'.repeat(33);
    await expect(pkm.importFromHex(long)).rejects.toThrow(/32 bytes/i);
  });

  it('clamps sk to 1n when masterBytes BigInt reduces to 0 mod BABYJUB_SUBORDER (all-zero bytes)', async () => {
    // all-zero bytes → BigInt = 0n → 0n % BABYJUB_SUBORDER = 0n → clamped to 1n
    const zeroHex = 'mk:0x' + '00'.repeat(32);
    await pkm.importFromHex(zeroHex);
    expect(pkm.getSpendingKey()).toBe(1n);
    expect(pkm.getMasterBytes()).toEqual(new Uint8Array(32));
  });
});

// ─── encodePrivacyAddress ─────────────────────────────────────────────────────

describe('pkm.encodePrivacyAddress', () => {
  it('throws if not loaded', () => {
    expect(() => pkm.encodePrivacyAddress()).toThrow(/no key loaded/i);
  });

  it('returns a string starting with "orbpriv1:"', async () => {
    await pkm.load(TEST_SK, MASTER_BYTES);
    expect(pkm.encodePrivacyAddress()).toMatch(/^orbpriv1:/);
  });

  it('has exactly 3 colon-separated parts', async () => {
    await pkm.load(TEST_SK, MASTER_BYTES);
    const parts = pkm.encodePrivacyAddress().split(':');
    expect(parts).toHaveLength(3);
  });

  it('ownerPk part is a 0x-prefixed 64-nibble hex string', async () => {
    await pkm.load(TEST_SK, MASTER_BYTES);
    const [, ownerPkHex] = pkm.encodePrivacyAddress().split(':');
    expect(ownerPkHex).toMatch(/^0x[0-9a-f]{64}$/);
  });

  it('viewingPublicKey part is a 0x-prefixed 64-nibble hex string (32 bytes)', async () => {
    await pkm.load(TEST_SK, MASTER_BYTES);
    const [, , viewingKeyHex] = pkm.encodePrivacyAddress().split(':');
    expect(viewingKeyHex).toMatch(/^0x[0-9a-f]{64}$/);
  });

  it('ownerPk hex encodes getOwnerPk()', async () => {
    await pkm.load(TEST_SK, MASTER_BYTES);
    const [, ownerPkHex] = pkm.encodePrivacyAddress().split(':');
    const decoded = BigInt(ownerPkHex!);
    expect(decoded).toBe(pkm.getOwnerPk());
  });

  it('viewingPublicKey hex encodes getViewingPublicKeyPacked()', async () => {
    await pkm.load(TEST_SK, MASTER_BYTES);
    const [, , viewingPublicKeyHex] = pkm.encodePrivacyAddress().split(':');
    const raw = viewingPublicKeyHex!.slice(2);
    const bytes = new Uint8Array((raw.match(/.{2}/g) ?? []).map((b) => parseInt(b, 16)));
    expect(bytes).toEqual(pkm.getViewingPublicKeyPacked());
  });

  it('is deterministic — same key produces same address', async () => {
    await pkm.load(TEST_SK, MASTER_BYTES);
    const a = pkm.encodePrivacyAddress();
    const b = pkm.encodePrivacyAddress();
    expect(a).toBe(b);
  });

  it('different spending keys produce different privacy addresses', async () => {
    await pkm.load(TEST_SK, MASTER_BYTES);
    const addr1 = pkm.encodePrivacyAddress();
    await pkm.load(OTHER_SK, OTHER_MASTER_BYTES);
    const addr2 = pkm.encodePrivacyAddress();
    expect(addr1).not.toBe(addr2);
  });

  it('round-trips through decodePrivacyAddress', async () => {
    await pkm.load(TEST_SK, MASTER_BYTES);
    const addr = pkm.encodePrivacyAddress();
    const decoded = PrivacyKeyManager.decodePrivacyAddress(addr);
    expect(decoded).not.toBeNull();
    expect(BigInt(decoded!.ownerPkHex)).toBe(pkm.getOwnerPk());
    const raw = decoded!.viewingPublicKeyHex.slice(2);
    const bytes = new Uint8Array((raw.match(/.{2}/g) ?? []).map((b) => parseInt(b, 16)));
    expect(bytes).toEqual(pkm.getViewingPublicKeyPacked());
  });
});

// ─── decodePrivacyAddress (static) ───────────────────────────────────────────

describe('PrivacyKeyManager.decodePrivacyAddress', () => {
  it('returns null for empty string', () => {
    expect(PrivacyKeyManager.decodePrivacyAddress('')).toBeNull();
  });

  it('returns null for arbitrary string', () => {
    expect(PrivacyKeyManager.decodePrivacyAddress('hello')).toBeNull();
  });

  it('returns null for wrong prefix', () => {
    expect(PrivacyKeyManager.decodePrivacyAddress('orbpub1:0xaabb:0xccdd')).toBeNull();
  });

  it('returns null when only prefix present (no colons)', () => {
    expect(PrivacyKeyManager.decodePrivacyAddress('orbpriv1')).toBeNull();
  });

  it('returns null for too few parts (only prefix + 1)', () => {
    expect(PrivacyKeyManager.decodePrivacyAddress('orbpriv1:0xaabb')).toBeNull();
  });

  it('returns null for too many parts (4 colons)', () => {
    expect(PrivacyKeyManager.decodePrivacyAddress('orbpriv1:0xaa:0xbb:0xcc')).toBeNull();
  });

  it('returns null when ownerPkHex part is empty', () => {
    expect(PrivacyKeyManager.decodePrivacyAddress('orbpriv1::0xbb')).toBeNull();
  });

  it('returns null when viewingPublicKeyHex part is empty', () => {
    expect(PrivacyKeyManager.decodePrivacyAddress('orbpriv1:0xaa:')).toBeNull();
  });

  it('returns ownerPkHex and viewingPublicKeyHex for a valid address', () => {
    const result = PrivacyKeyManager.decodePrivacyAddress('orbpriv1:0xabcd:0xef01');
    expect(result).toEqual({ ownerPkHex: '0xabcd', viewingPublicKeyHex: '0xef01' });
  });

  it('decoded values are exactly the parts after the prefix', async () => {
    const pkm2 = new PrivacyKeyManager();
    await pkm2.load(TEST_SK, MASTER_BYTES);
    const addr = pkm2.encodePrivacyAddress();
    const [, expectedPk, expectedVk] = addr.split(':');
    const result = PrivacyKeyManager.decodePrivacyAddress(addr);
    expect(result?.ownerPkHex).toBe(expectedPk);
    expect(result?.viewingPublicKeyHex).toBe(expectedVk);
  });
});
