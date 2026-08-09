/**
 * OutgoingBlob — the OVK "wrap-the-key" primitive.
 *
 * When a wallet sends a private_transfer, the recipient's memo is encrypted ECDH
 * toward the RECIPIENT's ivk; the sender cannot reopen it, so a cold restore
 * loses the outgoing history (who/how much). This blob fixes that: it wraps the
 * memo's 32-byte `sharedSecret` under a key derived from the SENDER's ovk. On
 * restore the sender unwraps the sharedSecret and feeds it to the SAME memo
 * decryption path the recipient uses — one decryption routine in the whole
 * system (OVK plan requirement #7).
 *
 * This is Zcash Sapling's `outCiphertext` / Penumbra's `OvkWrappedKey`, adapted
 * to a shared secret that is a field element (32 bytes), not a group point — so
 * the blob contains no group element to decode, sidestepping Zcash's canonical-
 * encoding class of bugs.
 *
 * Layout (56 bytes): nonce_suffix(8) || ciphertext(32) || MAC(16).
 * Cipher: ChaCha20-Poly1305 (IETF), same primitive as EncryptedMemo.
 *
 * The outgoing cipher key binds every unique-per-output public value:
 *   ock = HKDF(ikm=ovk, salt=commitment_bytes||ephPk_bytes, info=OCK_DOMAIN)
 * so each ock encrypts exactly one message. Uniqueness comes from the COMMITMENT
 * (Poseidon4 with random blinding, consensus rejects duplicates); the ephPk adds
 * the on-chain binding, not the uniqueness — two self-notes can share an ephPk
 * but never a commitment, so their ock still differs.
 *
 * SALT IS RAW ON-CHAIN BYTES. `commitment_bytes` and `ephPk_bytes` must be the
 * exact bytes that are/go on chain, never a re-serialization of a decoded point:
 * two encodings of "the same point" produce different ock and the AEAD fails —
 * no ambiguity to exploit.
 */

import { chacha20poly1305 } from '@noble/ciphers/chacha.js';
import { randomBytes } from '@noble/ciphers/utils.js';
import { hkdf } from '@noble/hashes/hkdf.js';
import { sha256 } from '@noble/hashes/sha2.js';

// ─── Frozen format constants (OVK plan Fase 0) ───────────────────────────────
// Do NOT change after launch without versioning — the golden vector fixes them,
// and outgoing history, unlike notes, cannot be re-derived from anywhere else.

/** HKDF info for the outgoing cipher key. */
const OCK_DOMAIN = new TextEncoder().encode('orbinum-outgoing-cipher-v1');
/** 4-byte constant nonce prefix, not transmitted — domain separation at the nonce level. */
const NONCE_PREFIX = new TextEncoder().encode('OVK1'); // 0x4F 0x56 0x4B 0x31
const NONCE_SUFFIX_SIZE = 8;
const SHARED_SECRET_SIZE = 32;
const MAC_SIZE = 16;

/** Total on-chain blob size: nonce_suffix(8) || ciphertext(32) || MAC(16). */
export const OVK_BLOB_SIZE = NONCE_SUFFIX_SIZE + SHARED_SECRET_SIZE + MAC_SIZE; // 56

/**
 * Derive the 32-byte outgoing cipher key.
 *   ock = HKDF-SHA256(ikm=ovk, salt=commitmentBytes||ephPkBytes, info=OCK_DOMAIN)
 *
 * Both salt parts must be the raw 32-byte on-chain values (see file header).
 * Throws if either is not exactly 32 bytes — a wrong length here would silently
 * change the key and make recovery fail far from the cause.
 */
export function deriveOutgoingCipherKey(
    ovk: Uint8Array,
    commitmentBytes: Uint8Array,
    ephPkBytes: Uint8Array
): Uint8Array {
    if (commitmentBytes.length !== 32) {
        throw new Error(
            `OutgoingBlob: commitmentBytes must be 32 bytes, got ${commitmentBytes.length}`
        );
    }
    if (ephPkBytes.length !== 32) {
        throw new Error(`OutgoingBlob: ephPkBytes must be 32 bytes, got ${ephPkBytes.length}`);
    }
    const salt = new Uint8Array(64);
    salt.set(commitmentBytes, 0);
    salt.set(ephPkBytes, 32);
    return hkdf(sha256, ovk, salt, OCK_DOMAIN, 32);
}

/** Build the 12-byte nonce: "OVK1" || suffix(8). Prefix is constant, not stored. */
function buildNonce(suffix: Uint8Array): Uint8Array {
    const nonce = new Uint8Array(12);
    nonce.set(NONCE_PREFIX, 0);
    nonce.set(suffix, 4);
    return nonce;
}

/**
 * Seal a sharedSecret into a 56-byte outgoing blob under the sender's ovk.
 *
 * @param ovk             sender's 32-byte outgoing viewing key
 * @param sharedSecret    the memo's 32-byte ECDH shared secret (what we wrap)
 * @param commitmentBytes raw 32-byte on-chain commitment of the recipient output
 * @param ephPkBytes      raw 32-byte ephemeral public key (from the memo, not recomputed)
 * @returns 56 bytes: nonce_suffix(8) || ciphertext(32) || MAC(16)
 */
export function sealOutgoingBlob(
    ovk: Uint8Array,
    sharedSecret: Uint8Array,
    commitmentBytes: Uint8Array,
    ephPkBytes: Uint8Array
): Uint8Array {
    if (sharedSecret.length !== SHARED_SECRET_SIZE) {
        throw new Error(`OutgoingBlob: sharedSecret must be 32 bytes, got ${sharedSecret.length}`);
    }
    const ock = deriveOutgoingCipherKey(ovk, commitmentBytes, ephPkBytes);
    const suffix = randomBytes(NONCE_SUFFIX_SIZE);
    const cipher = chacha20poly1305(ock, buildNonce(suffix));
    const sealed = cipher.encrypt(sharedSecret); // ciphertext(32) || MAC(16)

    const blob = new Uint8Array(OVK_BLOB_SIZE);
    blob.set(suffix, 0);
    blob.set(sealed, NONCE_SUFFIX_SIZE);
    return blob;
}

/**
 * Open an outgoing blob, returning the wrapped sharedSecret or null.
 *
 * Never throws — this runs in recovery loops over hints that may be foreign,
 * pre-OVK, or ovk=⊥ random. A wrong ovk, wrong commitment, wrong ephPk, or any
 * corrupted byte fails the MAC and returns null.
 */
export function openOutgoingBlob(
    ovk: Uint8Array,
    blob: Uint8Array,
    commitmentBytes: Uint8Array,
    ephPkBytes: Uint8Array
): Uint8Array | null {
    if (blob.length !== OVK_BLOB_SIZE) return null;
    if (commitmentBytes.length !== 32 || ephPkBytes.length !== 32) return null;
    try {
        const ock = deriveOutgoingCipherKey(ovk, commitmentBytes, ephPkBytes);
        const suffix = blob.subarray(0, NONCE_SUFFIX_SIZE);
        const sealed = blob.subarray(NONCE_SUFFIX_SIZE);
        const cipher = chacha20poly1305(ock, buildNonce(suffix));
        return cipher.decrypt(sealed); // throws on MAC failure
    } catch {
        return null;
    }
}

/**
 * A 56-byte random blob for the ovk=⊥ case (sender opts out of recoverability).
 *
 * Indistinguishable on-chain from a real blob: a real one is a random 8-byte
 * suffix plus ChaCha20/Poly1305 output, both uniform without the key. This is
 * the ONLY path for ⊥ — never zeros (distinguishable), never omission (a length
 * or SCALE-tag difference is a permanent, retroactive privacy label).
 */
export function randomOutgoingBlob(): Uint8Array {
    return randomBytes(OVK_BLOB_SIZE);
}
