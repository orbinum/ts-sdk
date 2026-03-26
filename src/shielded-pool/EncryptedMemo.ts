/**
 * EncryptedMemo — TypeScript implementation of Orbinum's encrypted note memo.
 *
 * Mirrors primitives/encrypted-memo in the node repository; no WASM required.
 *
 * Layout (104 bytes):
 *   nonce(12) || ciphertext(76 + 16 MAC) = 104
 *
 * Plaintext layout (76 bytes):
 *   value(8 LE) || owner_pk(32) || blinding(32) || asset_id(4 LE)
 *
 * Key derivation:
 *   key = SHA256(viewing_key || commitment || "orbinum-note-encryption-v1")
 *
 * Cipher: ChaCha20-Poly1305 (IETF, 96-bit nonce)
 */

import { sha256 } from '@noble/hashes/sha2.js';
import { chacha20poly1305 } from '@noble/ciphers/chacha.js';
import { randomBytes } from '@noble/ciphers/utils.js';
import { bytesToBigintLE } from '../utils/bytes';

// ─── Decrypted memo type ──────────────────────────────────────────────────────

/** Fields recovered from a successfully decrypted EncryptedMemo. */
export type DecryptedMemo = {
    value: bigint;
    ownerPk: bigint;
    blinding: bigint;
    assetId: bigint;
};

// ─── Constants (mirror constants.rs) ─────────────────────────────────────────

const KEY_DOMAIN = new TextEncoder().encode('orbinum-note-encryption-v1');
const NONCE_SIZE = 12;
const MEMO_PLAINTEXT_SIZE = 76;
/** Full encrypted memo: nonce(12) + plaintext(76) + MAC(16) = 104 bytes */
export const ENCRYPTED_MEMO_SIZE = 104;

// ─── Plaintext serialization ──────────────────────────────────────────────────

/**
 * Serialize memo plaintext to 76 bytes.
 * Layout: value(8 LE) || owner_pk(32) || blinding(32) || asset_id(4 LE)
 */
function serializeMemo(
    value: bigint,
    ownerPk: Uint8Array,
    blinding: Uint8Array,
    assetId: number
): Uint8Array {
    const buf = new Uint8Array(MEMO_PLAINTEXT_SIZE);
    const view = new DataView(buf.buffer);
    // value as u64 LE (bigint — clamp to 8 bytes)
    view.setBigUint64(0, value & 0xffff_ffff_ffff_ffffn, true);
    buf.set(ownerPk.slice(0, 32), 8);
    buf.set(blinding.slice(0, 32), 40);
    view.setUint32(72, assetId >>> 0, true);
    return buf;
}

// ─── Key derivation ───────────────────────────────────────────────────────────

/**
 * Derive the per-note encryption key.
 * key = SHA256(viewing_key || commitment || KEY_DOMAIN)
 */
function deriveEncryptionKey(viewingKey: Uint8Array, commitment: Uint8Array): Uint8Array {
    const h = sha256.create();
    h.update(viewingKey);
    h.update(commitment);
    h.update(KEY_DOMAIN);
    return h.digest();
}

// ─── EncryptedMemo ───────────────────────────────────────────────────────────

export const EncryptedMemo = {
    /**
     * Build and encrypt a memo for a note.
     *
     * @param value       Note value in planck.
     * @param ownerPk     32-byte owner public key (little-endian).
     * @param blinding    32-byte blinding scalar (little-endian).
     * @param assetId     Asset identifier.
     * @param commitment  32-byte commitment bytes (little-endian).
     * @param recipientVk 32-byte recipient viewing key — pass `new Uint8Array(32)`
     *                    for a publicly-readable (dummy) memo.
     * @returns 104-byte encrypted memo (nonce || ciphertext).
     */
    encrypt(
        value: bigint,
        ownerPk: Uint8Array,
        blinding: Uint8Array,
        assetId: number,
        commitment: Uint8Array,
        recipientVk: Uint8Array
    ): Uint8Array {
        const nonce = randomBytes(NONCE_SIZE);
        const key = deriveEncryptionKey(recipientVk, commitment);
        const plaintext = serializeMemo(value, ownerPk, blinding, assetId);

        const cipher = chacha20poly1305(key, nonce);
        const ciphertext = cipher.encrypt(plaintext);

        const result = new Uint8Array(NONCE_SIZE + ciphertext.length);
        result.set(nonce, 0);
        result.set(ciphertext, NONCE_SIZE);
        return result;
    },

    /**
     * Returns a 104-byte public memo with a zero recipient viewing key.
     * The memo is still readable by anyone who holds the viewing key (zeros).
     */
    encryptPublic(
        value: bigint,
        ownerPk: Uint8Array,
        blinding: Uint8Array,
        assetId: number,
        commitment: Uint8Array
    ): Uint8Array {
        return EncryptedMemo.encrypt(
            value,
            ownerPk,
            blinding,
            assetId,
            commitment,
            new Uint8Array(32)
        );
    },

    /**
     * Returns a 104-byte zeroed dummy memo (no information, always valid on-chain).
     */
    dummy(): Uint8Array {
        return new Uint8Array(ENCRYPTED_MEMO_SIZE);
    },

    /**
     * Decrypt an on-chain EncryptedMemo.
     *
     * Returns `null` if decryption fails — wrong key, bad MAC, or malformed memo.
     * Never throws; safe for scan loops.
     *
     * @param memoBytes   104-byte encrypted memo.
     * @param commitment  32-byte note commitment (little-endian).
     * @param recipientVk 32-byte recipient viewing key.
     */
    decrypt(
        memoBytes: Uint8Array,
        commitment: Uint8Array,
        recipientVk: Uint8Array
    ): DecryptedMemo | null {
        if (memoBytes.length !== ENCRYPTED_MEMO_SIZE) return null;
        try {
            const nonce = memoBytes.slice(0, NONCE_SIZE);
            const ciphertext = memoBytes.slice(NONCE_SIZE);
            const key = deriveEncryptionKey(recipientVk, commitment);
            const cipher = chacha20poly1305(key, nonce);
            const plaintext = cipher.decrypt(ciphertext);

            const view = new DataView(plaintext.buffer, plaintext.byteOffset, plaintext.byteLength);
            const value = view.getBigUint64(0, true);
            const ownerPk = bytesToBigintLE(plaintext.slice(8, 40));
            const blinding = bytesToBigintLE(plaintext.slice(40, 72));
            const assetId = BigInt(view.getUint32(72, true));

            return { value, ownerPk, blinding, assetId };
        } catch {
            return null;
        }
    },
};
