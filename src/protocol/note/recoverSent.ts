/**
 * Reading back a note you SENT.
 *
 * The amount and the recipient of an outgoing transfer live inside a memo
 * sealed toward someone else, so a sender restoring from a seed used to get
 * working payment slips and no history of their own payments.
 *
 * Two derivations close that, and both come from the seed:
 *
 *   - the ephemeral is `deriveOutgoingEphSk(ovk, i)`, so the sender can
 *     predict every ephPk they published and spot their payments in the pool;
 *   - the recipient's viewing key rides in the CHANGE note's `sourcePk`, sealed
 *     under the ovk, so the address book comes back with the notes.
 *
 * Nothing extra is published on chain. This reads what was already there.
 *
 * ## Why matching is by ephPk and not by commitment
 *
 * Recomputing the commitment looks tempting — the sender chose every input to
 * `Poseidon4(value, assetId, ownerPk, blinding)` — but it needs the VALUE, and
 * the value is the thing being recovered. The ephPk depends on neither the
 * value nor the blinding, which is exactly what makes it usable: the sender
 * recognises a payment without knowing what they are looking for.
 *
 * ## What this is not
 *
 * Not a spendable note. It carries no spending key and no nullifier — the
 * sender does not own the recipient's note, only the memory of having sent it.
 */
import { EncryptedMemo, ENCRYPTED_MEMO_SIZE } from '../memo/EncryptedMemo';
import { deriveOutgoingSharedSecret } from '../eph/outgoingEph';
import { isValidLeafIndex } from '../spend/coinSelection';
import { fromHex, isHexOfLength } from '../../foundation/encoding/hex';
import type { ScanCommitment } from '../types';

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
    /** Which outgoing index this note used. Lets a caller repair a lost counter. */
    ephIndex: number;
};

interface RecoverSentNoteParams {
    /** The output as the indexer serves it: commitment, memo, leaf index. */
    hint: ScanCommitment;
    /** This wallet's OUTGOING viewing key — the root of the outgoing sequence. */
    outgoingViewingKey: Uint8Array;
    /**
     * The outgoing index this hint's ephPk matched.
     *
     * Callers hold it already: they found the hint by looking its ephPk up in a
     * precomputed window, and that lookup names the index.
     */
    ephIndex: number;
    /**
     * Candidate recipients, as packed viewing keys — normally the book rebuilt
     * from change notes. Each is tried until one opens the memo; the memo's own
     * MAC is what decides, so a wrong candidate cannot yield a wrong amount.
     */
    recipientCandidates: readonly Uint8Array[];
}

/**
 * The facts of a sent note, from a shared secret the caller already derived.
 *
 * Split out because a caller sweeping candidates derives the secret itself and
 * would otherwise pay for it twice.
 *
 * Never throws — this runs in loops over hints and candidates.
 */
export function recoverSentFromSharedSecret(
    hint: ScanCommitment,
    outgoingSharedSecret: Uint8Array,
    ephIndex: number
): SentNoteFacts | null {
    if (!isHexOfLength(hint.commitmentHex, 32)) return null;
    if (!isHexOfLength(hint.encryptedMemo, ENCRYPTED_MEMO_SIZE)) return null;

    try {
        const plaintext = EncryptedMemo.decryptWithSharedSecret(
            fromHex(hint.encryptedMemo),
            fromHex(hint.commitmentHex),
            outgoingSharedSecret
        );
        // The ephPk matched but the memo did not open: a candidate that is not
        // this payment's recipient, or a hint pairing a memo with someone
        // else's commitment. Either way it is not the one.
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
            ephIndex,
        };
    } catch {
        return null;
    }
}

/**
 * Recover a note this wallet sent, trying each candidate recipient.
 *
 * Returns the facts plus WHICH candidate opened it — the caller needs that to
 * re-seal a payment slip, which is sealed toward the recipient's viewing key.
 *
 * Null covers every "not this one" case without distinguishing them: a
 * malformed hint, a payment whose recipient is not among the candidates, or a
 * note this wallet did not send all read the same, and no caller can act on the
 * difference.
 *
 * Never throws — this runs in a loop over hints.
 */
export function recoverSentNote(
    params: RecoverSentNoteParams
): (SentNoteFacts & { recipientIvk: Uint8Array }) | null {
    const { hint, outgoingViewingKey, ephIndex, recipientCandidates } = params;

    // Shape-checked rather than trusted: these come from a server. Checking
    // here names the reason, where failing deeper would leave "not our note"
    // and "the server sent garbage" indistinguishable.
    if (!isHexOfLength(hint.commitmentHex, 32)) return null;
    if (!isHexOfLength(hint.encryptedMemo, ENCRYPTED_MEMO_SIZE)) return null;

    for (const candidate of recipientCandidates) {
        let sharedSecret: Uint8Array;
        try {
            sharedSecret = deriveOutgoingSharedSecret(outgoingViewingKey, ephIndex, candidate);
        } catch {
            // Not a curve point — a corrupt book entry, which is expected: they
            // are unauthenticated by design and verified by use, right here.
            continue;
        }
        const facts = recoverSentFromSharedSecret(hint, sharedSecret, ephIndex);
        if (facts) return { ...facts, recipientIvk: candidate };
    }
    return null;
}
