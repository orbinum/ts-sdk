/**
 * NoteDecryptor
 *
 * Core logic for decrypting on-chain commitments during a shielded pool scan.
 * For each commitment, attempts to decrypt the encryptedMemo with the viewer's
 * viewing key, then verifies the recomputed commitment matches the on-chain value.
 *
 * This is protocol-level logic — independent of indexer, storage, or UI.
 * Consume via scan loops in application code.
 *
 * Hash scheme (Poseidon BN254, poseidon-lite):
 *   commitment = Poseidon4(value, assetId, ownerPk, blinding)
 *   nullifier  = Poseidon2(commitment, spendingKey)
 */

import { poseidon2, poseidon4 } from 'poseidon-lite';
import { EncryptedMemo, ENCRYPTED_MEMO_SIZE } from '../memo/EncryptedMemo';
import { openOutgoingBlob, OVK_BLOB_SIZE } from '../memo/OutgoingBlob';
import { isValidLeafIndex } from '../spend/coinSelection';
import { deriveStealthOwnerPk, deriveStealthSk } from '../../foundation/crypto/stealth';
import { recoverOwnerPkPoint } from '../../foundation/crypto/bjj';
import { fromHex, toHex } from '../../foundation/encoding/hex';
import { bigintTo32Le, bytesToBigintLE } from '../../foundation/encoding/bytes';
import {
    type ScanCommitment,
    type ZkNote,
    type DecryptedMemo,
    type OutgoingNoteRecord,
} from '../types';
export type { ScanCommitment };

/**
 * Shared decrypt-and-verify step, used by BOTH the recipient path
 * (`tryDecryptNoteVerbose`) and the sender path (`tryRecoverOutgoing`) — the OVK
 * plan's requirement #7: one note-decryption routine in the whole system.
 *
 * Decrypts the memo with an already-known shared secret, then binds the result
 * to the tree: `poseidon4(value, assetId, effectiveOwnerPk, blinding)` must equal
 * the on-chain commitment. A plaintext that is "plausible but lying" fails here
 * because it would have to be a Poseidon preimage of a real commitment.
 *
 * `effectiveOwnerPk` is the owner the caller expects in the commitment: the
 * recipient path passes the stealthOwnerPk it derived; the sender path passes
 * `null`, meaning "use the decrypted memo's own ownerPk" (it is already the
 * recipient's stealth owner on an outgoing note).
 */
function decryptAndVerifyPlaintext(
    memoBytes: Uint8Array,
    commitmentBytes: Uint8Array,
    sharedSecret: Uint8Array,
    effectiveOwnerPk: bigint | null
): DecryptedMemo | null {
    const plaintext = EncryptedMemo.decryptWithSharedSecret(
        memoBytes,
        commitmentBytes,
        sharedSecret
    );
    if (!plaintext) return null;
    const ownerPk = effectiveOwnerPk ?? plaintext.ownerPk;
    const recomputed = poseidon4([plaintext.value, plaintext.assetId, ownerPk, plaintext.blinding]);
    if (recomputed !== bytesToBigintLE(commitmentBytes)) return null;
    return plaintext;
}

// ─── Exported helpers ─────────────────────────────────────────────────────────

/**
 * Computes the nullifier for a note.
 *   nullifier = Poseidon2(commitment, spendingKey)
 *
 * spendingKey must already be in [1, BABYJUB_SUBORDER) as returned by
 * deriveSpendingKeyFromSignature.
 */
export function computeNullifier(commitment: bigint, spendingKey: bigint): bigint {
    return poseidon2([commitment, spendingKey]);
}

/**
 * The on-chain hex form of a commitment.
 *
 * A commitment is a field element, but everything that INDEXES one — scan
 * hints, vault records, `ZkNote.commitmentHex` — uses its 32-byte LITTLE-ENDIAN
 * hex. Composing `toHex(bigintTo32Le(x))` at each call site works until someone
 * reaches for the big-endian variant, and then the comparison silently never
 * matches: a lookup finds nothing, an ownership check answers "not mine" for
 * every note, and nothing throws.
 *
 * One function so the encoding is stated once.
 */
export function commitmentHexOf(commitment: bigint): string {
    return toHex(bigintTo32Le(commitment));
}

/**
 * Computes a note commitment.
 *   commitment = Poseidon4(value, assetId, ownerPk, blinding)
 *
 * Mirrors NoteCommitment in note.circom — use it to verify a stored note
 * against its on-chain commitment before spending it.
 */
export function computeNoteCommitment(
    value: bigint,
    assetId: bigint,
    ownerPk: bigint,
    blinding: bigint
): bigint {
    return poseidon4([value, assetId, ownerPk, blinding]);
}

// ─── Public API ───────────────────────────────────────────────────────────────

export interface TryDecryptOptions {
    /**
     * View-tag fast path: compute the ECDH shared secret once, compare the
     * 1-byte tag in memo nonce[0], and skip the AEAD decrypt on mismatch
     * (255/256 of foreign notes; `reason: 'view_tag_mismatch'`).
     *
     * Only enable for commitments at/after the wallet's tagActivationLeaf —
     * legacy memos carry a random byte there and would be silently dropped.
     */
    viewTag?: boolean;
    /**
     * Precomputed ECDH shared secret (self-note discovery: the caller matched
     * the hint's ephPk against a selfEphWindow and already holds the secret).
     * Skips the ECDH and the view-tag gate entirely; the decrypt + commitment
     * check still validate the note as usual.
     */
    sharedSecret?: Uint8Array;
}

/**
 * Attempt to decrypt an on-chain commitment using the recipient's viewing secret key.
 *
 * Returns a fully populated ZkNote if the memo decrypts correctly and the
 * recomputed commitment matches the on-chain value.
 * Returns null when the note does not belong to this viewer (wrong key, no memo,
 * or commitment mismatch).
 *
 * @param commitment       On-chain commitment record from the indexer.
 * @param viewingSecretKey 32-byte viewing secret key (from deriveViewingSecretKey / getViewingSecretKey).
 * @param spendingKey      Spending key bigint (for nullifier computation).
 * @param ownOwnerPk       The viewer's global BabyJubJub Ax (ownerPk). Required for stealth detection.
 *                         Pass 0n to disable stealth detection (legacy/own-note-only scanning).
 * @param opts             See TryDecryptOptions (view-tag fast path).
 */
export function tryDecryptNote(
    commitment: ScanCommitment,
    viewingSecretKey: Uint8Array,
    spendingKey: bigint,
    ownOwnerPk: bigint = 0n,
    opts?: TryDecryptOptions
): ZkNote | null {
    return tryDecryptNoteVerbose(commitment, viewingSecretKey, spendingKey, ownOwnerPk, opts).note;
}

/**
 * Like tryDecryptNote but also returns a human-readable reason for failure.
 * Useful for debugging scan issues (wrong key, corrupted memo, commitment mismatch).
 */
export function tryDecryptNoteVerbose(
    commitment: ScanCommitment,
    viewingSecretKey: Uint8Array,
    spendingKey: bigint,
    ownOwnerPk: bigint = 0n,
    opts?: TryDecryptOptions
): { note: ZkNote | null; reason?: string } {
    if (!commitment.encryptedMemo) return { note: null, reason: 'no_memo' };

    let commitmentBytes: Uint8Array;
    let memoBytes: Uint8Array;
    try {
        commitmentBytes = fromHex(commitment.commitmentHex);
        memoBytes = fromHex(commitment.encryptedMemo);
    } catch {
        return { note: null, reason: 'hex_parse_error' };
    }

    if (memoBytes.length !== ENCRYPTED_MEMO_SIZE) {
        return {
            note: null,
            reason: `memo_size_mismatch:got_${memoBytes.length}_expected_${ENCRYPTED_MEMO_SIZE}`,
        };
    }

    // View-tag fast path: ECDH once, compare one byte, decrypt only on match.
    // The extracted secret is reused by the stealth branch (no second ECDH).
    // A caller-supplied secret (self-note discovery) skips both the ECDH and
    // the tag gate.
    let sharedSecret: Uint8Array | null = opts?.sharedSecret ?? null;
    if (!sharedSecret && opts?.viewTag) {
        sharedSecret = EncryptedMemo.extractSharedSecret(memoBytes, viewingSecretKey);
        if (!sharedSecret) return { note: null, reason: 'stealth_shared_secret_failed' };
        if (!EncryptedMemo.checkViewTag(memoBytes, sharedSecret)) {
            return { note: null, reason: 'view_tag_mismatch' };
        }
    }

    const plaintext = sharedSecret
        ? EncryptedMemo.decryptWithSharedSecret(memoBytes, commitmentBytes, sharedSecret)
        : EncryptedMemo.decrypt(memoBytes, commitmentBytes, viewingSecretKey);
    if (!plaintext) return { note: null, reason: 'decrypt_failed:wrong_key_or_corrupt_mac' };

    // Stealth detection: if the decrypted ownerPk differs from our global ownerPk, this is
    // a stealth note — the sender used our viewing key to compute a one-time stealthOwnerPk.
    // We must derive the matching stealthSk to compute the correct nullifier.
    let effectiveOwnerPk = plaintext.ownerPk;
    let effectiveSpendingKey = spendingKey;

    if (ownOwnerPk !== 0n && plaintext.ownerPk !== ownOwnerPk) {
        // Shared secret: reuse the fast-path one, or extract it now.
        const ss = sharedSecret ?? EncryptedMemo.extractSharedSecret(memoBytes, viewingSecretKey);
        if (!ss) return { note: null, reason: 'stealth_shared_secret_failed' };

        // Recover the full BJJ point [Ax, Ay] from our ownerPk (Ax only).
        const ownPkPoint = recoverOwnerPkPoint(ownOwnerPk);
        if (!ownPkPoint) return { note: null, reason: 'stealth_invalid_own_owner_pk' };

        // Derive the expected stealthOwnerPk and verify it matches the decrypted plaintext.
        const stealthOwnerPk = deriveStealthOwnerPk(ss, ownOwnerPk, ownPkPoint);
        if (stealthOwnerPk !== plaintext.ownerPk) {
            return { note: null, reason: 'commitment_mismatch' };
        }

        effectiveOwnerPk = stealthOwnerPk;
        effectiveSpendingKey = deriveStealthSk(ss, ownOwnerPk, spendingKey);
    }

    // Verify: recompute commitment and assert it matches the on-chain value.
    const recomputed = poseidon4([
        plaintext.value,
        plaintext.assetId,
        effectiveOwnerPk,
        plaintext.blinding,
    ]);
    if (recomputed !== bytesToBigintLE(commitmentBytes)) {
        return { note: null, reason: 'commitment_mismatch' };
    }

    const nullifier = poseidon2([recomputed, effectiveSpendingKey]);

    return {
        note: {
            value: plaintext.value,
            assetId: plaintext.assetId,
            ownerPk: effectiveOwnerPk,
            blinding: plaintext.blinding,
            spendingKey: effectiveSpendingKey,
            circuitVersion: plaintext.circuitVersion,
            ...(isValidLeafIndex(commitment.leafIndex) ? { leafIndex: commitment.leafIndex } : {}),
            spent: false,
            spentAt: null,
            commitment: recomputed,
            nullifier,
            commitmentHex: toHex(bigintTo32Le(recomputed)),
            nullifierHex: toHex(bigintTo32Le(nullifier)),
            memo: Array.from(memoBytes),
            counterpartyPk: plaintext.counterpartyPk,
        },
    };
}

// ─── Outgoing recovery (OVK) ───────────────────────────────────────────────────

/** A scan hint plus the per-transaction OVK blob the indexer serves alongside it. */
export type OutgoingHint = ScanCommitment & { ovkBlob?: string | null };

/**
 * Recover a note the caller SENT, using their outgoing viewing key (ovk).
 *
 * The sender's memo was encrypted toward the RECIPIENT, so they cannot reopen it
 * directly. Instead the ovk blob wraps the memo's shared secret; unwrapping it
 * gives the same secret the recipient gets via ECDH, and feeding it to the shared
 * decrypt-and-verify step rebuilds the sent note's public facts.
 *
 * Returns an OutgoingNoteRecord (value, recipient stealth pk, counterparty,
 * circuit version) — NEVER a spendable note: no spendingKey, no nullifier. The
 * sender does not own this note. Never throws (runs in recovery loops).
 *
 * Security (OVK plan §3.4), in three non-algebraic but sound layers:
 *  1. The blob MAC (openOutgoingBlob) proves whoever wrote it knew the ovk, and
 *     the ock binds it to THIS (commitment, ephPk) — blobs are not transplantable.
 *  2. The memo MAC (inside decryptAndVerifyPlaintext) proves this shared secret
 *     is the one that encrypted this memo — the same secret the recipient derives.
 *  3. The commitment check ties the recovered fields to the note in the tree.
 * Not verifiable by the sender: that `sharedSecret` corresponds to `ephPk` — that
 * needs the recipient's ivsk. Residual: a leaked ovk lets an attacker fabricate a
 * self-consistent (commitment, memo, blob) and plant false outgoing history. It
 * moves no funds; Zcash accepts the same residual. Mitigated in the app by only
 * running this over commitments from extrinsics that spent our own nullifiers.
 *
 * @param hint  scan hint with commitmentHex, encryptedMemo, and ovkBlob.
 * @param ovk   the sender's 32-byte outgoing viewing key.
 * @param opts  viewTagActivationLeaf gates the view-tag check for legacy memos.
 */
export function tryRecoverOutgoing(
    hint: OutgoingHint,
    ovk: Uint8Array,
    opts?: { viewTagActivationLeaf?: number }
): OutgoingNoteRecord | null {
    // 1. Blob present and well-formed?
    if (!hint.ovkBlob || !hint.encryptedMemo) return null;

    let commitmentBytes: Uint8Array;
    let memoBytes: Uint8Array;
    let blobBytes: Uint8Array;
    try {
        commitmentBytes = fromHex(hint.commitmentHex);
        memoBytes = fromHex(hint.encryptedMemo);
        blobBytes = fromHex(hint.ovkBlob);
    } catch {
        return null;
    }
    if (memoBytes.length !== ENCRYPTED_MEMO_SIZE) return null;
    if (blobBytes.length !== OVK_BLOB_SIZE) return null;

    // 2. ephPk = raw bytes 148..180 of the memo (never recomputed — §2.2).
    const ephPkBytes = memoBytes.subarray(148, 180);

    // 3. Unwrap the shared secret. MAC failure → not ours / ⊥ / corrupt.
    const sharedSecret = openOutgoingBlob(ovk, blobBytes, commitmentBytes, ephPkBytes);
    if (!sharedSecret) return null;
    // From here the blob MAC has proven the writer knew our ovk.

    // 4. View-tag gate, mirroring the recipient path: only enforced at/after the
    //    activation leaf, since legacy memos carry a random byte there.
    const activation = opts?.viewTagActivationLeaf;
    if (
        activation !== undefined &&
        isValidLeafIndex(hint.leafIndex) &&
        hint.leafIndex >= activation &&
        !EncryptedMemo.checkViewTag(memoBytes, sharedSecret)
    ) {
        return null;
    }

    // 5. Decrypt + verify commitment via the SHARED routine (requirement #7).
    //    On an outgoing note the memo's ownerPk is already the recipient's stealth
    //    owner pk, so the verifier binds against plaintext.ownerPk itself — passing
    //    `null` tells the helper to use the decrypted owner as the expected owner.
    const plaintext = decryptAndVerifyPlaintext(memoBytes, commitmentBytes, sharedSecret, null);
    if (!plaintext) return null;

    return {
        commitmentHex: hint.commitmentHex,
        ...(isValidLeafIndex(hint.leafIndex) ? { leafIndex: hint.leafIndex } : {}),
        value: plaintext.value,
        assetId: plaintext.assetId,
        recipientStealthPk: plaintext.ownerPk,
        blinding: plaintext.blinding,
        counterpartyPk: plaintext.counterpartyPk,
        circuitVersion: plaintext.circuitVersion,
    };
}
