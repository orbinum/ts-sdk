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

import { chacha20poly1305 } from '@noble/ciphers/chacha.js';
import { randomBytes } from '@noble/ciphers/utils.js';
import { bytesToBigintLE } from '../utils/bytes';
import { deriveEncryptionKey, serializeMemo } from './helpers';
import type { DecryptedMemo } from './types';

// ─── Constants (mirror constants.rs) ─────────────────────────────────────────

const NONCE_SIZE = 12;
/** Full encrypted memo: nonce(12) + plaintext(76) + MAC(16) = 104 bytes */
export const ENCRYPTED_MEMO_SIZE = 104;

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
