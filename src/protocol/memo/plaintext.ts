/**
 * The memo's plaintext: its byte layout, and the two keys derived alongside it.
 *
 * A FROZEN WIRE CONTRACT. These 120 bytes are what every memo already on chain
 * holds, so the offsets cannot move — any change needs a new version scheme,
 * not an edit here. A golden vector pins them.
 *
 * Two derivations live beside the layout because both bind to the note:
 *   - the encryption key mixes in the COMMITMENT, so a memo lifted onto a
 *     different note fails to open rather than decrypting to the wrong values;
 *   - the view tag is one byte of `nonce[0]`, letting a scan reject ~255/256 of
 *     foreign notes without any AEAD work.
 */
import { sha256 } from '@noble/hashes/sha2.js';

const KEY_DOMAIN = new TextEncoder().encode('orbinum-note-encryption-v1');
const VIEW_TAG_DOMAIN = new TextEncoder().encode('orbinum-view-tag-v1');

/**
 * Plaintext layout (120 bytes):
 *   value_lo(8 LE) || value_hi(8 LE) || owner_pk(32) || blinding(32) || asset_id(4 LE) || source_pk(32) || circuit_version(4 LE)
 *
 * value is stored as a 128-bit LE unsigned integer split into two uint64 words.
 * This supports values up to ~3.4 × 10^38, well above any realistic token supply.
 * circuit_version (u32 LE) is the ZK circuit version the note is spent under — carried in the
 * note so a scan-recovered note keeps its version without an indexer lookup. This layout is
 * the wire contract for every memo already on chain — any change needs a new version scheme.
 */
export const MEMO_PLAINTEXT_SIZE = 120;

/**
 * Serialises the 120-byte memo plaintext.
 *
 * The BYTE OFFSETS are the frozen contract, not the parameter names — a golden
 * vector pins them, and any other implementation has to agree with those
 * offsets to interoperate. `sourcePk` occupies [84,116); older material calls
 * that field `counterparty_pk`, which is the same 32 bytes under a name that
 * wrongly suggested it identifies the sender.
 */
export function serializeMemo(
    value: bigint,
    ownerPk: Uint8Array,
    blinding: Uint8Array,
    assetId: number,
    sourcePk: Uint8Array,
    circuitVersion: number
): Uint8Array {
    // Out-of-range values are REFUSED, never masked. The commitment is computed
    // from the full bigint while these fields are fixed-width, so a value that
    // does not fit produces a memo describing a different note than the one
    // committed. The recipient's `tryDecryptNote` recomputes the commitment,
    // sees the mismatch, and treats the note as not theirs — it is not a
    // corrupted amount, it is a note nobody can ever open or spend.
    //
    // So the range is enforced HERE rather than left to wrap: `value = 2^128`,
    // a negative value or `assetId = 2^32 + 5` used to serialise cleanly and
    // only surface as `commitment_mismatch` on the recipient's device.
    if (value < 0n || value >> 128n !== 0n) {
        throw new Error(`serializeMemo: value must fit in 128 unsigned bits, got ${value}`);
    }
    if (!Number.isInteger(assetId) || assetId < 0 || assetId > 0xffff_ffff) {
        throw new Error(`serializeMemo: assetId must be a u32, got ${assetId}`);
    }
    if (!Number.isInteger(circuitVersion) || circuitVersion < 0 || circuitVersion > 0xffff_ffff) {
        throw new Error(`serializeMemo: circuitVersion must be a u32, got ${circuitVersion}`);
    }
    const buf = new Uint8Array(MEMO_PLAINTEXT_SIZE);
    const view = new DataView(buf.buffer);
    // Store value as 128-bit LE (two uint64 words: lo + hi)
    view.setBigUint64(0, value & 0xffff_ffff_ffff_ffffn, true);
    view.setBigUint64(8, (value >> 64n) & 0xffff_ffff_ffff_ffffn, true);
    buf.set(ownerPk.slice(0, 32), 16);
    buf.set(blinding.slice(0, 32), 48);
    view.setUint32(80, assetId >>> 0, true);
    buf.set(sourcePk.slice(0, 32), 84);
    view.setUint32(116, circuitVersion >>> 0, true);
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

/**
 * Derive the 1-byte view tag (Monero-style fast-scan filter) from the ECDH
 * shared secret:
 *   view_tag = SHA256("orbinum-view-tag-v1" || sharedSecret)[0]
 *
 * The sender embeds it as the memo's first nonce byte (nonce[0]); a scanner
 * that has computed the shared secret compares one byte and skips the AEAD
 * decrypt on mismatch — 255/256 of foreign notes. Safe to publish: without
 * the viewing key the shared secret is unknowable, so the byte reads as
 * uniform noise to any observer.
 *
 * Nonce safety: the encryption key is unique per note (see
 * deriveEncryptionKey), so each key encrypts exactly one message and the
 * remaining 11 random nonce bytes are more than enough.
 */
export function deriveViewTag(sharedSecret: Uint8Array): number {
    const h = sha256.create();
    h.update(VIEW_TAG_DOMAIN);
    h.update(sharedSecret);
    return h.digest()[0]!;
}
