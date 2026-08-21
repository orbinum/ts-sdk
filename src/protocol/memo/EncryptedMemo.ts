/**
 * EncryptedMemo — TypeScript implementation of Orbinum's encrypted note memo.
 *
 * Native TypeScript implementation — no WASM required. This file IS the
 * normative memo format: the chain treats memos as opaque 180-byte blobs.
 *
 * Layout (180 bytes, ECDH):
 *   nonce(12) || ciphertext+MAC(136) || ephPk_packed(32) = 180
 *
 * View tag: nonce[0] = deriveViewTag(sharedSecret). Layout and size unchanged.
 * Memos written before tags carry a RANDOM byte there, so the filter is only
 * sound at or after the leaf where they were switched on — the scanner passes
 * that boundary as `ScanKeys.viewTagActivationLeaf`.
 *
 * Plaintext layout (120 bytes):
 *   value_lo(8 LE) || value_hi(8 LE) || owner_pk(32) || blinding(32) || asset_id(4 LE) || source_pk(32) || circuit_version(4 LE)
 *
 * value is stored as a 128-bit LE unsigned integer (two uint64 words), supporting
 * amounts up to ~3.4 × 10^38 planck — well above any realistic token supply.
 *
 * Key derivation (ECDH). The "v2" in the memo's own wire format names THIS
 * layout, and is unrelated to the identity version — the v3 identity work
 * changed which branches derive a wallet's keys, not how a memo is sealed:
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
import { packPoint } from '@zk-kit/baby-jubjub';
import { fastMulBase, fastMulPoint } from '../../foundation/crypto/bjj-fast';
import { unpackUsableViewingKey } from '../../foundation/crypto/bjj';
import { bigintTo32Le, bytesToBigintLE } from '../../foundation/encoding/bytes';
import { BABYJUB_SUBORDER } from '../../foundation/crypto/constants';
import { deriveEncryptionKey, deriveViewTag, serializeMemo } from './plaintext';
import type { DecryptedMemo } from '../types';

// ─── Constants ────────────────────────────────────────────────────────────────

const NONCE_SIZE = 12;
const CIPHERTEXT_SIZE = 136; // plaintext(120) + MAC(16)
const EPH_PK_SIZE = 32;

/** Memo size: nonce(12) + ciphertext+MAC(136) + ephPk(32) = 180 */
export const ENCRYPTED_MEMO_SIZE = NONCE_SIZE + CIPHERTEXT_SIZE + EPH_PK_SIZE; // 180

// ─── Internal helpers ─────────────────────────────────────────────────────────

/** Convert 32-byte big-endian buffer to a BABYJUB_SUBORDER-clamped scalar.
 * Exported: selfEph.ts must clamp identically to reproduce published ephPks. */
export function bytesToBjjScalar(bytes: Uint8Array): bigint {
    // Length is checked, not tolerated. The reduction below turns ANY input
    // into a usable scalar — a 16-byte key, or all zeros, silently becomes
    // `1n` — so a truncated or uninitialised buffer would produce a valid
    // scalar some other wallet could also reach. An empty array is worse:
    // `BigInt('0x')` throws from whichever primitive touched it first.
    if (bytes.length !== 32) {
        throw new Error(`bytesToBjjScalar: expected 32 bytes, got ${bytes.length}`);
    }
    const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
    return BigInt('0x' + hex) % BABYJUB_SUBORDER || 1n;
}

/**
 * Decrypt the 120-byte plaintext from nonce+ciphertext bytes and parse fields.
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
        const sourcePk = bytesToBigintLE(plaintext.slice(84, 116));
        const circuitVersion = view.getUint32(116, true);
        return { value, ownerPk, blinding, assetId, sourcePk, circuitVersion };
    } catch {
        return null;
    }
}

// ─── EncryptedMemo ───────────────────────────────────────────────────────────

export const EncryptedMemo = {
    /**
     * Build and encrypt a memo for a note using ECDH (180 bytes).
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
     * @param sourcePk     32-byte counterparty BJJ Ax. Default: all zeros.
     * @param circuitVersion     ZK circuit version the note is spent under. Default: 0.
     * @param ephSkOverride      32-byte ephemeral secret key (stealth coordination). Optional.
     * @returns 180-byte encrypted memo: nonce(12) || ciphertext+MAC(136) || ephPk(32).
     */
    encrypt(
        value: bigint,
        ownerPk: Uint8Array,
        blinding: Uint8Array,
        assetId: number,
        commitment: Uint8Array,
        recipientIvkPacked: Uint8Array,
        sourcePk: Uint8Array = new Uint8Array(32),
        circuitVersion: number = 0,
        ephSkOverride?: Uint8Array
    ): Uint8Array {
        const nonce = randomBytes(NONCE_SIZE);
        const plaintext = serializeMemo(
            value,
            ownerPk,
            blinding,
            assetId,
            sourcePk,
            circuitVersion
        );

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
            const ephPkPoint = fastMulBase(ephSkScalar);
            ephPkPackedBytes = bigintTo32Le(packPoint(ephPkPoint) as bigint);

            // Low-order keys refused here, not just malformed ones. BabyJubJub
            // has cofactor 8, so a key from the small subgroup makes
            // `[ephSk]·ivk` take at most 8 values, so the memo opens by trying
            // them: value, blinding and sourcePk, with no secret at all.
            //
            // `NoteBuilder` already refuses it, but this primitive is exported,
            // so a direct caller reached the same hole around it. The zero-key
            // branch above is untouched: a public memo is a deliberate feature
            // and never claimed confidentiality.
            const ivkPackedBigint = bytesToBigintLE(recipientIvkPacked);
            const ivkPoint = unpackUsableViewingKey(ivkPackedBigint);
            if (!ivkPoint)
                throw new Error('EncryptedMemo.encrypt: invalid recipient viewing public key');

            const sharedPoint = fastMulPoint(ivkPoint, ephSkScalar);
            sharedSecret = bigintTo32Le(sharedPoint[0]);
        }

        // View tag as nonce[0]. Flipping it does not silently hide a note: the
        // nonce keys Poly1305's one-time key, so a changed tag makes the MAC
        // check fail outright rather than the memo decrypt to something else.
        nonce[0] = deriveViewTag(sharedSecret);

        const encKey = deriveEncryptionKey(sharedSecret, commitment);
        const cipher = chacha20poly1305(encKey, nonce);
        const ciphertext = cipher.encrypt(plaintext); // 136 bytes (120 + 16 MAC)

        // Layout: nonce(12) || ciphertext+MAC(136) || ephPk(32) = 180 bytes
        const result = new Uint8Array(ENCRYPTED_MEMO_SIZE);
        result.set(nonce, 0);
        result.set(ciphertext, NONCE_SIZE);
        result.set(ephPkPackedBytes, NONCE_SIZE + CIPHERTEXT_SIZE);
        return result;
    },

    /**
     * Returns a 180-byte public memo encrypted with a zero viewing key.
     * Decryptable by anyone with `decrypt(memo, commitment, new Uint8Array(32))`.
     * Convenience alias for `encrypt(..., new Uint8Array(32))`.
     */
    encryptPublic(
        value: bigint,
        ownerPk: Uint8Array,
        blinding: Uint8Array,
        assetId: number,
        commitment: Uint8Array,
        circuitVersion: number = 0
    ): Uint8Array {
        return EncryptedMemo.encrypt(
            value,
            ownerPk,
            blinding,
            assetId,
            commitment,
            new Uint8Array(32),
            new Uint8Array(32),
            circuitVersion
        );
    },

    /**
     * Returns a 180-byte zeroed dummy memo (no information, always valid on-chain).
     */
    dummy(): Uint8Array {
        return new Uint8Array(ENCRYPTED_MEMO_SIZE);
    },

    /**
     * Validates that `bytes` is a properly-sized encrypted memo.
     * Throws an Error if the length is not ENCRYPTED_MEMO_SIZE (180 bytes).
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
     * @param memoBytes        180-byte encrypted memo.
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
     * without re-running the full decrypt path. Safe to call on any 180-byte memo.
     *
     * Returns `new Uint8Array(32)` (all zeros) for public/dummy memos (zero ephPk).
     * Returns `null` if the memo is malformed or the ephPk is not a valid BJJ point.
     * Never throws; safe for scan loops.
     *
     * @param memoBytes        180-byte encrypted memo.
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
        // `unpackUsableViewingKey`, not a bare `unpackPoint`: the sender chose
        // this ephPk and it reaches us through an untrusted feed. A cofactor-8
        // point makes `[ivsk]·ephPk` take at most 8 values, so the "shared"
        // secret is one anyone can enumerate. The sealing side already refuses
        // such keys; this is the same gate on the way back in.
        const ephPkPoint = unpackUsableViewingKey(ephPkPackedBigint);
        if (!ephPkPoint) return null;
        const ivskScalar = bytesToBjjScalar(viewingSecretKey);
        const sharedPoint = fastMulPoint(ephPkPoint, ivskScalar);
        return bigintTo32Le(sharedPoint[0]);
    },

    /**
     * Cheap view-tag check: does memo nonce[0] match the tag derived from
     * `sharedSecret`? One SHA256 + one byte compare — no AEAD work.
     *
     * Only meaningful for memos that carry a tag — at or after
     * `ScanKeys.viewTagActivationLeaf`. An older memo has a random byte there
     * and would false-negative 255/256 of the time.
     */
    checkViewTag(memoBytes: Uint8Array, sharedSecret: Uint8Array): boolean {
        if (memoBytes.length !== ENCRYPTED_MEMO_SIZE) return false;
        return memoBytes[0] === deriveViewTag(sharedSecret);
    },

    /**
     * Decrypt with an already-computed shared secret (from
     * extractSharedSecret), skipping the ECDH. Pair with checkViewTag for the
     * fast scan path: ECDH once → tag check → decrypt only on match.
     */
    decryptWithSharedSecret(
        memoBytes: Uint8Array,
        commitment: Uint8Array,
        sharedSecret: Uint8Array
    ): DecryptedMemo | null {
        if (memoBytes.length !== ENCRYPTED_MEMO_SIZE) return null;
        const nonce = memoBytes.slice(0, NONCE_SIZE);
        const ciphertextWithMac = memoBytes.slice(NONCE_SIZE, NONCE_SIZE + CIPHERTEXT_SIZE);
        const encKey = deriveEncryptionKey(sharedSecret, commitment);
        return parsePlaintext(nonce, ciphertextWithMac, encKey);
    },

    /** @internal */
    _decrypt(
        memoBytes: Uint8Array,
        commitment: Uint8Array,
        viewingSecretKey: Uint8Array
    ): DecryptedMemo | null {
        const sharedSecret = EncryptedMemo.extractSharedSecret(memoBytes, viewingSecretKey);
        if (!sharedSecret) return null;
        return EncryptedMemo.decryptWithSharedSecret(memoBytes, commitment, sharedSecret);
    },
};
