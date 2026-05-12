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
