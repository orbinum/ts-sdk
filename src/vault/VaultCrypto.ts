/**
 * VaultCrypto
 *
 * WebCrypto-based encryption utilities for protecting Orbinum vault data.
 * Works in browser and Node.js 18+ (both expose the WebCrypto API as `crypto`).
 * Pure functions — no state, no side effects.
 *
 * Key derivation: HKDF-SHA-256(ikm=masterBytes, salt=empty, info="orbinum-vault-key-v1")
 * Cipher: AES-GCM 256
 */

import { fromBase64, toBase64 } from '../utils/encoding';
import { vaultReplacer, vaultReviver } from './VaultJson';

// ─── Key derivation ───────────────────────────────────────────────────────────

const VAULT_KEY_INFO = new TextEncoder().encode('orbinum-vault-key-v1');
const VAULT_BLIND_INFO = new TextEncoder().encode('orbinum-vault-blind-v1');
const IV_BYTES = 12;

/**
 * Derives an AES-GCM-256 CryptoKey from master key bytes using HKDF-SHA-256.
 *
 * IMPORTANT: pass masterBytes from deriveMasterKeyBytes(), NOT bigintTo32Le(spendingKey).
 * The vault key must be stable across circuit field changes — it depends only on
 * the wallet signature, never on the modulus used to reduce the circuit scalar.
 *
 * @param masterBytes 32-byte pre-modulus key material from deriveMasterKeyBytes().
 */
export async function deriveVaultKey(masterBytes: Uint8Array): Promise<CryptoKey> {
    const keyMaterial = await crypto.subtle.importKey('raw', masterBytes.slice(0), 'HKDF', false, [
        'deriveKey',
    ]);
    return crypto.subtle.deriveKey(
        {
            name: 'HKDF',
            hash: 'SHA-256',
            salt: new Uint8Array(0),
            info: VAULT_KEY_INFO,
        },
        keyMaterial,
        { name: 'AES-GCM', length: 256 },
        false,
        ['encrypt', 'decrypt']
    );
}

/**
 * Derives an HMAC-SHA-256 key ("blind key") from the same master key bytes,
 * for deterministically tagging note identifiers (commitment/nullifier) in the
 * vault WITHOUT storing them in plaintext.
 *
 * The tag `HMAC(blindKey, hex)` is stable, so equality lookups still work
 * (find a note by commitment/nullifier), but a raw storage dump reveals no
 * on-chain identifiers — an attacker with disk access can't link the vault to
 * chain activity. Derived from masterBytes, so it's device-independent and
 * survives reload (unlike a random per-session salt).
 *
 * @param masterBytes 32-byte pre-modulus key material from deriveMasterKeyBytes().
 */
export async function deriveVaultBlindKey(masterBytes: Uint8Array): Promise<CryptoKey> {
    const keyMaterial = await crypto.subtle.importKey('raw', masterBytes.slice(0), 'HKDF', false, [
        'deriveKey',
    ]);
    return crypto.subtle.deriveKey(
        {
            name: 'HKDF',
            hash: 'SHA-256',
            salt: new Uint8Array(0),
            info: VAULT_BLIND_INFO,
        },
        keyMaterial,
        { name: 'HMAC', hash: 'SHA-256', length: 256 },
        false,
        ['sign']
    );
}

/**
 * Deterministic tag for a note identifier hex, as `0x`-prefixed HMAC-SHA-256.
 * Used as the blinded storage key for commitment / nullifier / assetId.
 */
export async function blindTag(blindKey: CryptoKey, value: string): Promise<string> {
    const data = new TextEncoder().encode(value.toLowerCase());
    const sig = await crypto.subtle.sign('HMAC', blindKey, data);
    return (
        '0x' +
        toBase64(sig)
            .replace(/[^a-zA-Z0-9]/g, '')
            .toLowerCase()
    );
}

// ─── Encrypt / Decrypt ────────────────────────────────────────────────────────

/**
 * Serialises `payload` to JSON (bigint-safe) and encrypts it with AES-GCM.
 * Returns base64-encoded `iv` and `ciphertext`.
 */
export async function encryptJson(
    key: CryptoKey,
    payload: unknown
): Promise<{ iv: string; ciphertext: string }> {
    const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
    const plaintext = new TextEncoder().encode(JSON.stringify(payload, vaultReplacer));
    const ciphertextBuf = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, plaintext);
    return { iv: toBase64(iv), ciphertext: toBase64(ciphertextBuf) };
}

/**
 * Decrypts AES-GCM ciphertext and parses the JSON payload (bigint-safe).
 * Throws `DOMException` on authentication failure (wrong key or corrupted data).
 */
export async function decryptJson(
    key: CryptoKey,
    iv: string,
    ciphertext: string
): Promise<unknown> {
    const plainBuf = await crypto.subtle.decrypt(
        { name: 'AES-GCM', iv: new Uint8Array(fromBase64(iv)) },
        key,
        new Uint8Array(fromBase64(ciphertext))
    );
    return JSON.parse(new TextDecoder().decode(plainBuf), vaultReviver);
}
