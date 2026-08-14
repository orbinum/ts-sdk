/**
 * Reading back a note you SENT.
 *
 * The amount and the recipient of an outgoing transfer live inside a memo
 * sealed toward someone else, so they were treated as unrecoverable: a sender
 * restoring from a seed got working payment slips, never their own history.
 *
 * That holds for a random ephemeral. It does NOT hold for a payment to a
 * counterparty the wallet already knows, because the pair secret is symmetric:
 *
 *     pairSecret = ECDH(myViewingSk, theirViewingPk) = ECDH(theirViewingSk, myViewingPk)
 *     ephSk_i    = SHA256("orbinum-pairwise-eph-v1" || pairSecret || u32le(i))
 *
 * The sender derived that ephemeral in the first place, so they can derive it
 * again — and with it the memo's shared secret. Nothing extra is published on
 * chain; this reads what was already there.
 *
 * ## Why no counter is needed
 *
 * The index used for a given note is not stored anywhere recoverable, and asking
 * a server "does this ephPk exist" would reveal which notes are ours. Neither is
 * required: the published ephPk travels in the clear in the memo's last 32
 * bytes, so the sender precomputes their OWN window and looks the index up
 * locally. Both facts came from an extrinsic this wallet signed.
 *
 * ## What this is not
 *
 * Not a spendable note. It carries no spending key and no nullifier — the
 * sender does not own the recipient's note, only the memory of having sent it.
 */
import { EncryptedMemo, ENCRYPTED_MEMO_SIZE } from '../memo/EncryptedMemo';
import { derivePairwiseSharedSecret, pairwiseEphWindow } from '../eph/index';
import { isValidLeafIndex } from '../spend/coinSelection';
import { fromHex, isHexOfLength, toHex } from '../../foundation/encoding/hex';
import type { ScanCommitment } from '../types';

/** Indexes swept when the ephPk lookup finds nothing. Matches the scanner's. */
export const SENT_NOTE_WINDOW = 64;

/**
 * What a sender recovers about a note they sent.
 *
 * Deliberately without `spendingKey`, `nullifier` or a spent flag: this is a
 * record of a payment, not a note this wallet can spend.
 */
export type SentNoteFacts = {
    /** 0x-prefixed 32-byte LE commitment hex of the recipient output. */
    commitmentHex: string;
    /** Global Merkle leaf index, when the hint carried a usable one. */
    leafIndex?: number;
    /** Amount sent, in planck. */
    value: bigint;
    assetId: bigint;
    /** The recipient's ONE-TIME stealth owner pk — not their global identity. */
    recipientStealthPk: bigint;
    /** Blinding of the recipient output; with the rest it recomputes the commitment. */
    blinding: bigint;
    /** Counterparty pk stamped in the memo. */
    sourcePk: bigint;
    circuitVersion: number;
    /** Which pairwise index this note used. Lets a caller repair a lost counter. */
    ephIndex: number;
};

export interface RecoverSentNoteParams {
    /** The output as the indexer serves it: commitment, memo, leaf index. */
    hint: ScanCommitment;
    /** This wallet's viewing SECRET key. */
    myViewingSecretKey: Uint8Array;
    /** The recipient's packed viewing public key, from their privacy address. */
    theirViewingPublicKey: Uint8Array;
    /** How many indexes to consider. Default `SENT_NOTE_WINDOW`. */
    windowSize?: number;
}

/**
 * Recover a note this wallet sent to a known counterparty, or null.
 *
 * Null covers every "not this one" case without distinguishing them, because a
 * caller sweeping counterparties cannot act on the difference: a malformed hint,
 * a payment to somebody else, a random ephemeral (first payment to this
 * counterparty), or an index past the window all read the same.
 *
 * Never throws — this runs in a loop over hints and counterparties, where one
 * bad row must not stop the rest.
 */
export function recoverSentNote(params: RecoverSentNoteParams): SentNoteFacts | null {
    const { hint, myViewingSecretKey, theirViewingPublicKey } = params;
    const windowSize = params.windowSize ?? SENT_NOTE_WINDOW;

    // Shape-checked rather than trusted: these come from a server.
    //
    // Every one of these is REDUNDANT for the result — a short memo yields a
    // 31-byte slice that matches no ephPk, non-hex throws into the catch, and a
    // non-positive window produces no entries for `find` to hit. They are kept
    // because failing here names the reason, where failing by accident deeper in
    // would leave "not our note" and "the server sent garbage" indistinguishable.
    if (!isHexOfLength(hint.commitmentHex, 32)) return null;
    if (!isHexOfLength(hint.encryptedMemo, ENCRYPTED_MEMO_SIZE)) return null;
    if (windowSize <= 0) return null;

    try {
        const memoBytes = fromHex(hint.encryptedMemo);
        const commitmentBytes = fromHex(hint.commitmentHex);
        const pairSecret = derivePairwiseSharedSecret(myViewingSecretKey, theirViewingPublicKey);
        const window = pairwiseEphWindow(pairSecret, theirViewingPublicKey, 0, windowSize);

        // The published ephPk is the memo's last 32 bytes. Matching it against
        // the precomputed window costs one string compare per index, where
        // trial-decrypting costs a full AEAD open — and the window carries the
        // shared secret already, so a hit needs no further EC work.
        const publishedEphPk = toHex(memoBytes.subarray(148, 180)).toLowerCase();
        const match = window.find((e) => e.ephPkHex.toLowerCase() === publishedEphPk);
        if (!match) return null;

        const plaintext = EncryptedMemo.decryptWithSharedSecret(
            memoBytes,
            commitmentBytes,
            match.sharedSecret
        );
        // The ephPk matched but the memo did not open: the note belongs to a
        // different payment that happens to share a point, or the hint pairs a
        // memo with someone else's commitment. Either way it is not ours.
        if (!plaintext) return null;

        return {
            commitmentHex: hint.commitmentHex,
            ...(isValidLeafIndex(hint.leafIndex) ? { leafIndex: hint.leafIndex } : {}),
            value: plaintext.value,
            assetId: plaintext.assetId,
            // On an outgoing note the memo's ownerPk IS the recipient's stealth
            // owner — the builder wrote it that way.
            recipientStealthPk: plaintext.ownerPk,
            blinding: plaintext.blinding,
            sourcePk: plaintext.sourcePk,
            circuitVersion: plaintext.circuitVersion,
            ephIndex: match.index,
        };
    } catch {
        return null;
    }
}
