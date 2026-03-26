import { describe, it, expect } from 'vitest';
import {
    deriveVaultKey,
    encryptJson,
    decryptJson,
    vaultReplacer,
    vaultReviver,
} from '../../src/shielded-pool/VaultCrypto';
import { bigintTo32Le } from '../../src/utils/bytes';

const SPENDING_KEY = 12345678901234567890n;
const SK_BYTES = bigintTo32Le(SPENDING_KEY);

// ─── vaultReplacer ────────────────────────────────────────────────────────────

describe('vaultReplacer', () => {
  it('converts bigint to { __bigint: string }', () => {
    expect(vaultReplacer('', 42n)).toEqual({ __bigint: '42' });
  });

  it('leaves non-bigint values untouched', () => {
    expect(vaultReplacer('', 'hello')).toBe('hello');
    expect(vaultReplacer('', 123)).toBe(123);
    expect(vaultReplacer('', null)).toBeNull();
    expect(vaultReplacer('', true)).toBe(true);
  });

  it('works inside JSON.stringify', () => {
    const obj = { value: 9999999999999999999n, name: 'test' };
    const json = JSON.stringify(obj, vaultReplacer);
    const parsed = JSON.parse(json) as { value: { __bigint: string }; name: string };
    expect(parsed.value).toEqual({ __bigint: '9999999999999999999' });
    expect(parsed.name).toBe('test');
  });
});

// ─── vaultReviver ─────────────────────────────────────────────────────────────

describe('vaultReviver', () => {
  it('converts { __bigint: string } back to bigint', () => {
    expect(vaultReviver('', { __bigint: '42' })).toBe(42n);
  });

  it('leaves other values untouched', () => {
    expect(vaultReviver('', 'hello')).toBe('hello');
    expect(vaultReviver('', 123)).toBe(123);
    expect(vaultReviver('', null)).toBeNull();
    expect(vaultReviver('', { other: 1 })).toEqual({ other: 1 });
  });

  it('roundtrips bigint through JSON.stringify + JSON.parse', () => {
    const original = { value: 21888242871839275222246405745257275088548364400416034343698204186575808495617n };
    const json = JSON.stringify(original, vaultReplacer);
    const restored = JSON.parse(json, vaultReviver) as { value: bigint };
    expect(restored.value).toBe(original.value);
  });
});

// ─── deriveVaultKey ───────────────────────────────────────────────────────────

describe('deriveVaultKey', () => {
  it('returns a CryptoKey', async () => {
    const key = await deriveVaultKey(SK_BYTES);
    expect(key).toBeInstanceOf(CryptoKey);
  });

  it('key algorithm is AES-GCM', async () => {
    const key = await deriveVaultKey(SK_BYTES);
    expect(key.algorithm.name).toBe('AES-GCM');
  });

  it('is deterministic — same spending key bytes produce the same derived key behaviour', async () => {
    // CryptoKey is not directly comparable, but we verify encrypt/decrypt consistency.
    const k1 = await deriveVaultKey(SK_BYTES);
    const k2 = await deriveVaultKey(SK_BYTES);
    const { iv, ciphertext } = await encryptJson(k1, { test: true });
    const result = await decryptJson(k2, iv, ciphertext);
    expect(result).toEqual({ test: true });
  });

  it('different spending keys produce different key behaviour', async () => {
    const k1 = await deriveVaultKey(bigintTo32Le(1n));
    const k2 = await deriveVaultKey(bigintTo32Le(2n));
    const { iv, ciphertext } = await encryptJson(k1, { secret: 'data' });
    await expect(decryptJson(k2, iv, ciphertext)).rejects.toThrow();
  });
});

// ─── encryptJson / decryptJson ────────────────────────────────────────────────

describe('encryptJson / decryptJson', () => {
  it('roundtrips a plain object', async () => {
    const key = await deriveVaultKey(SK_BYTES);
    const payload = { foo: 'bar', num: 42 };
    const { iv, ciphertext } = await encryptJson(key, payload);
    const result = await decryptJson(key, iv, ciphertext);
    expect(result).toEqual(payload);
  });

  it('roundtrips an object containing bigint values', async () => {
    const key = await deriveVaultKey(SK_BYTES);
    const payload = { sk: SPENDING_KEY, label: 'test' };
    const { iv, ciphertext } = await encryptJson(key, payload);
    const result = await decryptJson(key, iv, ciphertext) as { sk: bigint; label: string };
    expect(result.sk).toBe(SPENDING_KEY);
    expect(result.label).toBe('test');
  });

  it('roundtrips nested bigint values', async () => {
    const key = await deriveVaultKey(SK_BYTES);
    const payload = { keys: { a: 1n, b: 2n }, note: null };
    const { iv, ciphertext } = await encryptJson(key, payload);
    const result = await decryptJson(key, iv, ciphertext) as { keys: { a: bigint; b: bigint }; note: null };
    expect(result.keys.a).toBe(1n);
    expect(result.keys.b).toBe(2n);
    expect(result.note).toBeNull();
  });

  it('each encryption produces a different iv', async () => {
    const key = await deriveVaultKey(SK_BYTES);
    const a = await encryptJson(key, { x: 1 });
    const b = await encryptJson(key, { x: 1 });
    expect(a.iv).not.toBe(b.iv);
  });

  it('ciphertext is not plaintext', async () => {
    const key = await deriveVaultKey(SK_BYTES);
    const { ciphertext } = await encryptJson(key, { secret: 'do-not-expose' });
    expect(ciphertext).not.toContain('do-not-expose');
  });

  it('throws on wrong key during decryption', async () => {
    const k1 = await deriveVaultKey(SK_BYTES);
    const k2 = await deriveVaultKey(bigintTo32Le(999n));
    const { iv, ciphertext } = await encryptJson(k1, { x: 1 });
    await expect(decryptJson(k2, iv, ciphertext)).rejects.toThrow();
  });

  it('throws on corrupted ciphertext', async () => {
    const key = await deriveVaultKey(SK_BYTES);
    const { iv } = await encryptJson(key, { x: 1 });
    await expect(decryptJson(key, iv, 'bm90YXZhbGlkY2lwaGVydGV4dA==')).rejects.toThrow();
  });
});
