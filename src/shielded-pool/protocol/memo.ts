import { sha256 } from '@noble/hashes/sha2.js';

const KEY_DOMAIN = new TextEncoder().encode('orbinum-note-encryption-v1');

/**
 * Plaintext layout (116 bytes):
 *   value_lo(8 LE) || value_hi(8 LE) || owner_pk(32) || blinding(32) || asset_id(4 LE) || counterparty_pk(32)
 *
 * value is stored as a 128-bit LE unsigned integer split into two uint64 words.
 * This supports values up to ~3.4 × 10^38, well above any realistic token supply.
 */
export const MEMO_PLAINTEXT_SIZE = 116;

export function serializeMemo(
    value: bigint,
    ownerPk: Uint8Array,
    blinding: Uint8Array,
    assetId: number,
    counterpartyPk: Uint8Array
): Uint8Array {
    const buf = new Uint8Array(MEMO_PLAINTEXT_SIZE);
    const view = new DataView(buf.buffer);
    // Store value as 128-bit LE (two uint64 words: lo + hi)
    view.setBigUint64(0, value & 0xffff_ffff_ffff_ffffn, true);
    view.setBigUint64(8, (value >> 64n) & 0xffff_ffff_ffff_ffffn, true);
    buf.set(ownerPk.slice(0, 32), 16);
    buf.set(blinding.slice(0, 32), 48);
    view.setUint32(80, assetId >>> 0, true);
    buf.set(counterpartyPk.slice(0, 32), 84);
    return buf;
}

/**
 * Derive a 32-byte ChaCha20-Poly1305 encryption key from a shared secret and commitment.
 *
 * sharedSecret = ECDH(ephSk, ivk)[x-coordinate] — 32 bytes LE, computed by EncryptedMemo.encrypt/decrypt.
 * The commitment binds the key to a specific note, preventing memo reuse across commitments.
 */
export function deriveEncryptionKey(sharedSecret: Uint8Array, commitment: Uint8Array): Uint8Array {
    const h = sha256.create();
    h.update(sharedSecret);
    h.update(commitment);
    h.update(KEY_DOMAIN);
    return h.digest();
}
