import { describe, it, expect } from 'vitest';
import {
    deriveVaultKey,
    encryptJson,
    decryptJson,
} from '../../src/vault/VaultCrypto';
import { vaultReplacer, vaultReviver } from '../../src/vault/VaultJson';

// Stable 32-byte master bytes fixture — deriveVaultKey takes masterBytes, not sk scalar
const MASTER_BYTES = new Uint8Array(32).fill(0x77);
const OTHER_MASTER_BYTES = new Uint8Array(32).fill(0x33);

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
    const key = await deriveVaultKey(MASTER_BYTES);
    expect(key).toBeInstanceOf(CryptoKey);
  });

  it('key algorithm is AES-GCM', async () => {
    const key = await deriveVaultKey(MASTER_BYTES);
    expect(key.algorithm.name).toBe('AES-GCM');
  });

  it('is deterministic — same masterBytes produce the same derived key behaviour', async () => {
    // CryptoKey is not directly comparable; verify via encrypt/decrypt consistency.
    const k1 = await deriveVaultKey(MASTER_BYTES);
    const k2 = await deriveVaultKey(MASTER_BYTES);
    const { iv, ciphertext } = await encryptJson(k1, { test: true });
    const result = await decryptJson(k2, iv, ciphertext);
    expect(result).toEqual({ test: true });
  });

  it('different masterBytes produce different key behaviour (decryption fails across keys)', async () => {
    const k1 = await deriveVaultKey(MASTER_BYTES);
    const k2 = await deriveVaultKey(OTHER_MASTER_BYTES);
    const { iv, ciphertext } = await encryptJson(k1, { secret: 'data' });
    await expect(decryptJson(k2, iv, ciphertext)).rejects.toThrow();
  });

  it('masterBytes and sk_bytes are not interchangeable (vault key is stable post-modulus change)', async () => {
    // sk_bytes = bigintTo32Le(sk) where sk = BigInt(masterBytes) % BABYJUB_SUBORDER
    // These differ from masterBytes — confirms vault key no longer depends on the circuit modulus.
    const masterBigint = BigInt('0x' + Array.from(MASTER_BYTES, (b) => b.toString(16).padStart(2, '0')).join(''));
    const BABYJUB_SUBORDER = 2736030358979909402780800718157159386076813972158567259200215660948447373041n;
    const skBytes = new Uint8Array(32);
    const sk = masterBigint % BABYJUB_SUBORDER || 1n;
    let tmp = sk;
    for (let i = 0; i < 32; i++) { skBytes[i] = Number(tmp & 0xffn); tmp >>= 8n; }
    // The two keys produce different vault keys
    const kMaster = await deriveVaultKey(MASTER_BYTES);
    const kSk = await deriveVaultKey(skBytes);
    const { iv, ciphertext } = await encryptJson(kMaster, { x: 1 });
    await expect(decryptJson(kSk, iv, ciphertext)).rejects.toThrow();
  });
});

// ─── encryptJson / decryptJson ────────────────────────────────────────────────

describe('encryptJson / decryptJson', () => {
  it('roundtrips a plain object', async () => {
    const key = await deriveVaultKey(MASTER_BYTES);
    const payload = { foo: 'bar', num: 42 };
    const { iv, ciphertext } = await encryptJson(key, payload);
    const result = await decryptJson(key, iv, ciphertext);
    expect(result).toEqual(payload);
  });

  it('roundtrips an object containing bigint values', async () => {
    const key = await deriveVaultKey(MASTER_BYTES);
    const bigValue = 12345678901234567890n;
    const payload = { sk: bigValue, label: 'test' };
    const { iv, ciphertext } = await encryptJson(key, payload);
    const result = await decryptJson(key, iv, ciphertext) as { sk: bigint; label: string };
    expect(result.sk).toBe(bigValue);
    expect(result.label).toBe('test');
  });

  it('roundtrips nested bigint values', async () => {
    const key = await deriveVaultKey(MASTER_BYTES);
    const payload = { keys: { a: 1n, b: 2n }, note: null };
    const { iv, ciphertext } = await encryptJson(key, payload);
    const result = await decryptJson(key, iv, ciphertext) as { keys: { a: bigint; b: bigint }; note: null };
    expect(result.keys.a).toBe(1n);
    expect(result.keys.b).toBe(2n);
    expect(result.note).toBeNull();
  });

  it('each encryption produces a different iv', async () => {
    const key = await deriveVaultKey(MASTER_BYTES);
    const a = await encryptJson(key, { x: 1 });
    const b = await encryptJson(key, { x: 1 });
    expect(a.iv).not.toBe(b.iv);
  });

  it('ciphertext is not plaintext', async () => {
    const key = await deriveVaultKey(MASTER_BYTES);
    const { ciphertext } = await encryptJson(key, { secret: 'do-not-expose' });
    expect(ciphertext).not.toContain('do-not-expose');
  });

  it('throws on wrong key during decryption', async () => {
    const k1 = await deriveVaultKey(MASTER_BYTES);
    const k2 = await deriveVaultKey(OTHER_MASTER_BYTES);
    const { iv, ciphertext } = await encryptJson(k1, { x: 1 });
    await expect(decryptJson(k2, iv, ciphertext)).rejects.toThrow();
  });

  it('throws on corrupted ciphertext', async () => {
    const key = await deriveVaultKey(MASTER_BYTES);
    const { iv } = await encryptJson(key, { x: 1 });
    await expect(decryptJson(key, iv, 'bm90YXZhbGlkY2lwaGVydGV4dA==')).rejects.toThrow();
  });
});
