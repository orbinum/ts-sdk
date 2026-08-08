/**
 * The two keys a vault runs on, and the AES-GCM envelope they protect.
 *
 * Both derive from the same master bytes by HKDF-SHA-256 under different `info`
 * strings, so one signature yields a cipher key and an independent tagging key
 * that cannot be computed from each other.
 *
 * Reaches for the WebCrypto global only — present in browsers, Node 18+, Deno,
 * Bun and CF Workers — which is what keeps the vault portable to an extension or
 * a mobile runtime.
 */

import { fromBase64, toBase64 } from '../../../foundation/encoding/base64';
import { vaultReplacer, vaultReviver } from './json';

// ─── Constants ────────────────────────────────────────────────────────────────

/**
 * HKDF `info` strings. Changing either one makes every vault written under the
 * old value unreadable, so they are versioned rather than edited.
 */
const VAULT_KEY_INFO = new TextEncoder().encode('orbinum-vault-key-v1');
const VAULT_BLIND_INFO = new TextEncoder().encode('orbinum-vault-blind-v1');

/** AES-GCM nonce length. 12 bytes is the size the GCM spec optimises for. */
const IV_BYTES = 12;

// ─── Key derivation ───────────────────────────────────────────────────────────

/**
 * Derives the AES-GCM-256 key that encrypts note bodies and tx history.
 *
 * Takes the master bytes from `deriveMasterKeyBytes()`, never
 * `bigintTo32Le(spendingKey)`. The scalar is the master reduced mod the curve
 * order, so deriving from it would tie every stored vault to the current
 * modulus — a future field change would leave them all unreadable.
 *
 * @param masterBytes 32-byte pre-modulus key material from `deriveMasterKeyBytes()`.
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
 * Derives the HMAC-SHA-256 key that blinds note identifiers at rest.
 *
 * `HMAC(blindKey, hex)` is deterministic, so equality lookups still work — find
 * a note by commitment or nullifier — while a raw storage dump reveals no
 * on-chain identifier anyone could link to chain activity.
 *
 * Derived from the master bytes rather than a random per-session salt, because
 * the tags must stay stable across reloads and devices; a fresh salt would make
 * every stored note unfindable on the next unlock.
 *
 * @param masterBytes 32-byte pre-modulus key material from `deriveMasterKeyBytes()`.
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
 * Blinded storage key for a commitment, nullifier or assetId, as a
 * `0x`-prefixed HMAC-SHA-256 tag.
 *
 * Lowercased before signing so the same identifier in either case yields one
 * tag — a caller that passed mixed case would otherwise store a note it could
 * never look up again.
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

// ─── Envelope ─────────────────────────────────────────────────────────────────

/**
 * Serialises `payload` to bigint-safe JSON and seals it under AES-GCM.
 *
 * A fresh random IV per call, which GCM requires: reusing one under the same
 * key breaks confidentiality outright, not just for the repeated record.
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
 * Opens an envelope and parses the bigint-safe JSON inside.
 *
 * Throws on authentication failure — a wrong key or a tampered record. Callers
 * treat that as "written under a different key" rather than as corruption,
 * because a rescan recovers the notes either way.
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
