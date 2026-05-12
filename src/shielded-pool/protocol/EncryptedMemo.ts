/**
 * EncryptedMemo — TypeScript implementation of Orbinum's encrypted note memo.
 *
 * Mirrors primitives/encrypted-memo in the node repository; no WASM required.
 *
 * Layout (176 bytes, ECDH):
 *   nonce(12) || ciphertext+MAC(132) || ephPk_packed(32) = 176
 *
 * Plaintext layout (116 bytes):
 *   value_lo(8 LE) || value_hi(8 LE) || owner_pk(32) || blinding(32) || asset_id(4 LE) || counterparty_pk(32)
 *
 * value is stored as a 128-bit LE unsigned integer (two uint64 words), supporting
 * amounts up to ~3.4 × 10^38 planck — well above any realistic token supply.
 *
 * v2 key derivation (ECDH):
 *   ephSk        = random scalar in [1, BABYJUB_SUBORDER)
 *   ephPk        = mulPointEscalar(Base8, ephSk)
 *   sharedPoint  = mulPointEscalar(recipientIvk, ephSk)  ← or mulPointEscalar(ephPk, ivsk)
 *   sharedSecret = bigintTo32Le(sharedPoint[0])          ← Ax coordinate, 32 bytes LE
 *   key          = SHA256(sharedSecret || commitment || "orbinum-note-encryption-v1")
 *
 * Cipher: ChaCha20-Poly1305 (IETF, 96-bit nonce)
 */

import { chacha20poly1305 } from '@noble/ciphers/chacha.js';
import { randomBytes } from '@noble/ciphers/utils.js';
import { mulPointEscalar, Base8, packPoint, unpackPoint } from '@zk-kit/baby-jubjub';
import { bigintTo32Le, bytesToBigintLE } from '../../utils/bytes';
import { BABYJUB_SUBORDER } from '../../utils/crypto-constants';
import { deriveEncryptionKey, serializeMemo } from './memo';
import type { DecryptedMemo } from './types';

// ─── Constants ────────────────────────────────────────────────────────────────

const NONCE_SIZE = 12;
const CIPHERTEXT_SIZE = 132; // plaintext(116) + MAC(16)
const EPH_PK_SIZE = 32;

/** Memo size: nonce(12) + ciphertext+MAC(132) + ephPk(32) = 176 */
export const ENCRYPTED_MEMO_SIZE = NONCE_SIZE + CIPHERTEXT_SIZE + EPH_PK_SIZE; // 176

// ─── Internal helpers ─────────────────────────────────────────────────────────

/** Convert 32-byte big-endian buffer to a BABYJUB_SUBORDER-clamped scalar. */
function bytesToBjjScalar(bytes: Uint8Array): bigint {
    const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
    return BigInt('0x' + hex) % BABYJUB_SUBORDER || 1n;
}

/**
 * Decrypt the 108-byte plaintext from nonce+ciphertext bytes and parse fields.
 * Returns null if decryption fails (wrong key, bad MAC).
 */
function parsePlaintext(
    nonce: Uint8Array,
    ciphertextWithMac: Uint8Array,
    encKey: Uint8Array
): DecryptedMemo | null {
    try {
        const cipher = chacha20poly1305(encKey, nonce);
        const plaintext = cipher.decrypt(ciphertextWithMac);
        const view = new DataView(plaintext.buffer, plaintext.byteOffset, plaintext.byteLength);
        // value: 128-bit LE (two uint64 words at offsets 0 and 8)
        const valueLo = view.getBigUint64(0, true);
        const valueHi = view.getBigUint64(8, true);
        const value = valueLo | (valueHi << 64n);
        const ownerPk = bytesToBigintLE(plaintext.slice(16, 48));
        const blinding = bytesToBigintLE(plaintext.slice(48, 80));
        const assetId = BigInt(view.getUint32(80, true));
        const counterpartyPk = bytesToBigintLE(plaintext.slice(84, 116));
        return { value, ownerPk, blinding, assetId, counterpartyPk };
    } catch {
        return null;
    }
}

// ─── EncryptedMemo ───────────────────────────────────────────────────────────

export const EncryptedMemo = {
    /**
     * Build and encrypt a memo for a note using ECDH (v2, 168 bytes).
     *
     * @param value              Note value in planck.
     * @param ownerPk            32-byte owner public key (LE).
     * @param blinding           32-byte blinding scalar (LE).
     * @param assetId            Asset identifier.
     * @param commitment         32-byte commitment bytes (LE).
     * @param recipientIvkPacked 32-byte LE-encoded packed BJJ viewing public key
     *                           (from PrivacyKeyManager.getViewingPublicKeyPacked() or
     *                           decoded from a privacy address).
     *                           Pass `new Uint8Array(32)` (all zeros) for a publicly-readable memo.
     * @param counterpartyPk     32-byte counterparty BJJ Ax. Default: all zeros.
     * @returns 168-byte encrypted memo: nonce(12) || ciphertext+MAC(124) || ephPk(32).
     */
    encrypt(
        value: bigint,
        ownerPk: Uint8Array,
        blinding: Uint8Array,
        assetId: number,
        commitment: Uint8Array,
        recipientIvkPacked: Uint8Array,
        counterpartyPk: Uint8Array = new Uint8Array(32),
        ephSkOverride?: Uint8Array
    ): Uint8Array {
        const nonce = randomBytes(NONCE_SIZE);
        const plaintext = serializeMemo(value, ownerPk, blinding, assetId, counterpartyPk);

        // Determine shared secret via ECDH or zero for public notes.
        const isZeroKey = recipientIvkPacked.every((b) => b === 0);

        let sharedSecret: Uint8Array;
        let ephPkPackedBytes: Uint8Array;

        if (isZeroKey) {
            // Public note: zero shared secret, zero ephPk — deterministic, key = SHA256(zeros||commitment||domain).
            sharedSecret = new Uint8Array(32);
            ephPkPackedBytes = new Uint8Array(EPH_PK_SIZE);
        } else {
            // ECDH: use provided ephSk (for stealth coordination) or generate a fresh one.
            const ephSkBytes = ephSkOverride ?? randomBytes(32);
            if (ephSkBytes.length !== 32)
                throw new Error('EncryptedMemo.encrypt: ephSkOverride must be 32 bytes');
            const ephSkScalar = bytesToBjjScalar(ephSkBytes);
            const ephPkPoint = mulPointEscalar(Base8, ephSkScalar);
            ephPkPackedBytes = bigintTo32Le(packPoint(ephPkPoint) as bigint);

            const ivkPackedBigint = bytesToBigintLE(recipientIvkPacked);
            const ivkPoint = unpackPoint(ivkPackedBigint);
            if (!ivkPoint)
                throw new Error('EncryptedMemo.encrypt: invalid recipient viewing public key');

            const sharedPoint = mulPointEscalar(ivkPoint, ephSkScalar);
            sharedSecret = bigintTo32Le(sharedPoint[0]);
        }

        const encKey = deriveEncryptionKey(sharedSecret, commitment);
        const cipher = chacha20poly1305(encKey, nonce);
        const ciphertext = cipher.encrypt(plaintext); // 124 bytes (108 + 16 MAC)

        // Layout: nonce(12) || ciphertext+MAC(124) || ephPk(32) = 168 bytes
        const result = new Uint8Array(ENCRYPTED_MEMO_SIZE);
        result.set(nonce, 0);
        result.set(ciphertext, NONCE_SIZE);
        result.set(ephPkPackedBytes, NONCE_SIZE + CIPHERTEXT_SIZE);
        return result;
    },

    /**
     * Returns a 168-byte public memo encrypted with a zero viewing key.
     * Decryptable by anyone with `decrypt(memo, commitment, new Uint8Array(32))`.
     * Convenience alias for `encrypt(..., new Uint8Array(32))`.
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
     * Returns a 168-byte zeroed dummy memo (no information, always valid on-chain).
     */
    dummy(): Uint8Array {
        return new Uint8Array(ENCRYPTED_MEMO_SIZE);
    },

    /**
     * Validates that `bytes` is a properly-sized encrypted memo.
     * Throws an Error if the length is not ENCRYPTED_MEMO_SIZE (168 bytes).
     *
     * Call this at system boundaries (extrinsic builders, precompile encoders)
     * to catch malformed memos before they reach the chain and fail on-chain.
     *
     * @param bytes   The memo bytes to validate.
     * @param context Optional context string included in the error (e.g. 'shield', 'output[0]').
     */
    validate(bytes: Uint8Array, context?: string): void {
        if (bytes.length !== ENCRYPTED_MEMO_SIZE) {
            const ctx = context ? ` (${context})` : '';
            throw new Error(
                `EncryptedMemo: invalid size${ctx} — expected ${ENCRYPTED_MEMO_SIZE} bytes, got ${bytes.length}`
            );
        }
    },

    /**
     * Decrypt an on-chain EncryptedMemo using the recipient's viewing secret key.
     * Returns null if decryption fails — wrong key, bad MAC, or malformed memo.
     * Never throws; safe for scan loops.
     *
     * @param memoBytes        168-byte encrypted memo.
     * @param commitment       32-byte note commitment (LE).
     * @param viewingSecretKey 32-byte HKDF viewing secret key from deriveViewingSecretKey().
     */
    decrypt(
        memoBytes: Uint8Array,
        commitment: Uint8Array,
        viewingSecretKey: Uint8Array
    ): DecryptedMemo | null {
        if (memoBytes.length !== ENCRYPTED_MEMO_SIZE) return null;
        return EncryptedMemo._decrypt(memoBytes, commitment, viewingSecretKey);
    },

    /**
     * Extract the ECDH shared secret from an encrypted memo using the recipient's viewing secret key.
     *
     * Used by NoteDecryptor to obtain the shared secret needed for stealth address derivation
     * without re-running the full decrypt path. Safe to call on any 168-byte memo.
     *
     * Returns `new Uint8Array(32)` (all zeros) for public/dummy memos (zero ephPk).
     * Returns `null` if the memo is malformed or the ephPk is not a valid BJJ point.
     * Never throws; safe for scan loops.
     *
     * @param memoBytes        168-byte encrypted memo.
     * @param viewingSecretKey 32-byte HKDF viewing secret key from deriveViewingSecretKey().
     */
    extractSharedSecret(memoBytes: Uint8Array, viewingSecretKey: Uint8Array): Uint8Array | null {
        if (memoBytes.length !== ENCRYPTED_MEMO_SIZE) return null;
        const ephPkPackedBytes = memoBytes.slice(NONCE_SIZE + CIPHERTEXT_SIZE);
        const ephPkPackedBigint = bytesToBigintLE(ephPkPackedBytes);
        if (ephPkPackedBigint === 0n) {
            // Public / dummy memo — shared secret is zero by convention.
            return new Uint8Array(32);
        }
        const ephPkPoint = unpackPoint(ephPkPackedBigint);
        if (!ephPkPoint) return null;
        const ivskScalar = bytesToBjjScalar(viewingSecretKey);
        const sharedPoint = mulPointEscalar(ephPkPoint, ivskScalar);
        return bigintTo32Le(sharedPoint[0]);
    },

    /** @internal */
    _decrypt(
        memoBytes: Uint8Array,
        commitment: Uint8Array,
        viewingSecretKey: Uint8Array
    ): DecryptedMemo | null {
        const nonce = memoBytes.slice(0, NONCE_SIZE);
        const ciphertextWithMac = memoBytes.slice(NONCE_SIZE, NONCE_SIZE + CIPHERTEXT_SIZE);
        const ephPkPackedBytes = memoBytes.slice(NONCE_SIZE + CIPHERTEXT_SIZE);

        const ephPkPackedBigint = bytesToBigintLE(ephPkPackedBytes);

        let sharedSecret: Uint8Array;
        if (ephPkPackedBigint === 0n) {
            // Public note (zero ephPk → zero shared secret).
            sharedSecret = new Uint8Array(32);
        } else {
            const ephPkPoint = unpackPoint(ephPkPackedBigint);
            if (!ephPkPoint) return null;
            const ivskScalar = bytesToBjjScalar(viewingSecretKey);
            const sharedPoint = mulPointEscalar(ephPkPoint, ivskScalar);
            sharedSecret = bigintTo32Le(sharedPoint[0]);
        }

        const encKey = deriveEncryptionKey(sharedSecret, commitment);
        return parsePlaintext(nonce, ciphertextWithMac, encKey);
    },
};
