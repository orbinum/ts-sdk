/**
 * VaultCrypto
 *
 * WebCrypto-based encryption utilities for protecting Orbinum vault data.
 * Works in browser and Node.js 18+ (both expose the WebCrypto API as `crypto`).
 * Pure functions — no state, no side effects.
 *
 * Key derivation: HKDF-SHA-256(ikm=spendingKeyBytes, salt=empty, info="orbinum-vault-key-v1")
 * Cipher: AES-GCM 256
 *
 * BigInt serialisation uses `{ __bigint: "<decimal string>" }` so plain
 * `JSON.stringify` never receives a bigint. Use `vaultReplacer` / `vaultReviver`
 * for all vault payloads.
 */

// ─── BigInt JSON helpers ──────────────────────────────────────────────────────

/**
 * `JSON.stringify` replacer that serialises bigint values as
 * `{ __bigint: "<decimal string>" }` (JSON-safe).
 */
export function vaultReplacer(_key: string, value: unknown): unknown {
    if (typeof value === 'bigint') return { __bigint: value.toString() };
    return value;
}

/**
 * `JSON.parse` reviver that deserialises `{ __bigint: "<decimal string>" }`
 * back into native bigint values.
 */
export function vaultReviver(_key: string, value: unknown): unknown {
    if (value !== null && typeof value === 'object' && '__bigint' in (value as object)) {
        return BigInt((value as { __bigint: string }).__bigint);
    }
    return value;
}

// ─── Base64 helpers ───────────────────────────────────────────────────────────

function toBase64(buf: ArrayBuffer | Uint8Array): string {
    const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
    let str = '';
    for (const b of bytes) str += String.fromCharCode(b);
    return btoa(str);
}

function fromBase64(b64: string): Uint8Array {
    const bin = atob(b64);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
}

// ─── Key derivation ───────────────────────────────────────────────────────────

const VAULT_KEY_INFO = new TextEncoder().encode('orbinum-vault-key-v1');
const IV_BYTES = 12;

/**
 * Derives an AES-GCM-256 CryptoKey from spending key bytes using HKDF-SHA-256.
 * The spending key carries ≥256 bits of entropy so no salt / iteration
 * stretching is required.
 *
 * @param spendingKeyBytes 32-byte spending key (little-endian bigint representation).
 */
export async function deriveVaultKey(spendingKeyBytes: Uint8Array): Promise<CryptoKey> {
    const keyMaterial = await crypto.subtle.importKey(
        'raw',
        spendingKeyBytes.slice(0),
        'HKDF',
        false,
        ['deriveKey']
    );
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
