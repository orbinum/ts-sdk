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
import { EncryptedMemo, ENCRYPTED_MEMO_SIZE } from './EncryptedMemo';
import { deriveStealthOwnerPk, deriveStealthSk } from '../../utils/stealth';
import { recoverOwnerPkPoint } from '../../utils/bjj';
import { fromHex, toHex } from '../../utils/hex';
import { bigintTo32Le, bytesToBigintLE } from '../../utils/bytes';
import { type ScanCommitment, type ZkNote } from './types';
export type { ScanCommitment };

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
            ...(Number.isSafeInteger(commitment.leafIndex) &&
            commitment.leafIndex >= 0 &&
            commitment.leafIndex < 2 ** 32
                ? { leafIndex: commitment.leafIndex }
                : {}),
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
