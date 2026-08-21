/**
 * The trial-decryption loop: hints in, order-aligned notes out.
 *
 * This is where a wallet scan spends its time — one elliptic-curve
 * multiplication per note in the pool, with the answer "not mine" for
 * essentially all of them. Three routes, orders of magnitude apart:
 *
 *   1. a known ephemeral (own note, or one from a registered counterparty),
 *      matched by hash lookup against the precomputed window — no EC work
 *   2. the view-tag filter — one ECDH, then a byte rejects the note
 *   3. full trial decryption — the case that sets the cost
 *
 * A fourth route runs alongside them and produces no notes: a hint whose ephPk
 * falls in the OUTGOING window is a payment this wallet made. It is reported
 * separately, because the sender does not own it.
 *
 * No vault, no stores, no I/O, and every value that crosses the boundary is
 * structured-clone friendly, so this runs unchanged on the main thread or
 * inside a worker.
 */
import { tryDecryptNoteVerbose } from '../../../protocol/note/index';
import { recoverSentNote, openRecipientBookEntry } from '../../../protocol/note/index';

import { getKnownEphWindow } from './ephWindow';
import { toHex } from '../../../foundation/encoding/hex';
import type { DecryptBatchResult, ScanKeys, SentNoteMatch, UnmatchedSentHint } from './types';
import type { ScanCommitment, ZkNote } from '../../../protocol/types';

/**
 * The hint's ephPk: ALWAYS the memo's last 32 bytes.
 *
 * A feed may serve an `ephPkHex` of its own, but that field is derived data and
 * the memo is the source — it travels on chain and is already here. Preferring
 * the field handed the feed the power to switch off own-payment recognition in
 * silence: a wrong offset serves 32 well-formed bytes that match nothing, and
 * the scan returns `sentNotes: []` without a single error.
 *
 * Deriving it costs one slice per hint against the ECDH that follows.
 */
function hintEphPkHex(hint: ScanCommitment): string | null {
    const memo = hint.encryptedMemo;
    if (!memo || memo.length < 66) return null;
    return ('0x' + memo.slice(-64)).toLowerCase();
}

/**
 * The sealed book entry a self note carries, if it carries one.
 *
 * Returned unopened, because the key that opens it is the PAYMENT's commitment
 * and this note is the change beside it — a pairing nothing here knows yet.
 * Resolving it is left to the point where a payment is actually in hand.
 *
 * Every self note reaches here: a shield and a change note are the same shape,
 * so a plain `sourcePk` is indistinguishable from a book entry. Both are
 * carried forward and the payment memo's MAC decides, which is the only check
 * that proves a value is really a viewing key.
 */
function sealedBookEntry(note: ZkNote): bigint | null {
    if (note.sourcePk === undefined || note.sourcePk === 0n) return null;
    return note.sourcePk;
}

/**
 * Trial-decrypts every hint against the wallet's keys. Returns one entry per
 * hint, aligned with the input order: the recovered note, or null when the
 * hint isn't ours (MAC failure, view-tag mismatch) or is malformed — a single
 * bad hint must not kill the batch, the scan just counts it as failed.
 *
 * Order per hint: self-note window match (hash lookup, no EC) → view-tag
 * fast path (one ECDH, one byte) → full trial-decrypt.
 */
export function decryptHintBatch(hints: ScanCommitment[], keys: ScanKeys): DecryptBatchResult {
    const activation = keys.viewTagActivationLeaf ?? null;
    const knownWindow = getKnownEphWindow(keys);
    const sentNotes: SentNoteMatch[] = [];
    const learnedRecipients = new Set<string>();
    let tagFiltered = 0;
    let selfMatched = 0;
    let pairwiseMatched = 0;
    let maxSelfEphIndex: number | null = null;
    let maxOutgoingEphIndex: number | null = null;

    /**
     * Sealed book entries seen in this batch, still in ciphertext.
     *
     * They cannot be opened until a payment is in hand — its commitment is the
     * key — so they are collected raw and resolved in the second pass below.
     */
    const sealedEntries: bigint[] = [];
    /** Payments recognised by ephPk, held back until the batch's book is complete. */
    const pendingSent: UnmatchedSentHint[] = [];
    /** Commitments already queued, so a repeated hint cannot enter twice. */
    const seenSent = new Set<string>();
    /** Those still unopened at the end — their book entry is in another batch. */
    const unmatchedSent: UnmatchedSentHint[] = [];

    const notes = hints.map((hint) => {
        try {
            const ephPkHex = hintEphPkHex(hint) ?? '';
            const known = knownWindow?.byEphPk.get(ephPkHex);
            if (known) {
                const result = tryDecryptNoteVerbose(
                    hint,
                    keys.viewingKey,
                    keys.spendingKey,
                    keys.ownerPk,
                    { sharedSecret: known.sharedSecret }
                );
                if (result.note) {
                    if (known.source === 'self') {
                        selfMatched++;
                        // Only self indexes advance the vault counter: it tracks ephemerals
                        // this wallet PUBLISHED, and a pairwise index belongs to the sender's
                        // sequence. Mixing them would skip indexes and waste window slots.
                        if (maxSelfEphIndex === null || known.index > maxSelfEphIndex) {
                            maxSelfEphIndex = known.index;
                        }
                        // A self note may be the change of a transfer, carrying
                        // the recipient book entry for the payment beside it.
                        const sealed = sealedBookEntry(result.note);
                        if (sealed !== null) sealedEntries.push(sealed);
                    } else {
                        pairwiseMatched++;
                    }
                    return result.note;
                }
                // ephPk matched but the note didn't validate (astronomically unlikely
                // point collision, or corrupt memo) — fall through to the normal path.
            }

            // A payment this wallet MADE. Recognised without knowing the amount
            // or the recipient, because the outgoing ephPk depends on neither.
            //
            // Never returned as a note: the sender does not own it, and adding
            // it to the vault would show a payment they made as balance held.
            const outgoingIndex = knownWindow?.outgoingByEphPk.get(ephPkHex);
            if (outgoingIndex !== undefined) {
                // Tracked even if the memo never opens: a matched ephPk already
                // proves this wallet published that index, which is all the
                // counter repair needs.
                if (maxOutgoingEphIndex === null || outgoingIndex > maxOutgoingEphIndex) {
                    maxOutgoingEphIndex = outgoingIndex;
                }
                // Deduped HERE, not after opening — both reasons are about a
                // feed serving one commitment twice (pagination overlap, a
                // re-org, a replay aimed at this wallet):
                //
                //   - the copies differ only in `leafIndex`, and the survivor is
                //     baked into a re-issued slip. A wrong leaf is
                //     AUTHENTICATED, looks valid, then dies at Merkle-proof time
                //     on the recipient's device with nothing to explain it;
                //   - deduping on success alone leaves the FAILURE path
                //     unbounded, and a payment's ephPk is public in its memo.
                //
                // Deferred, not opened now: a transfer publishes the payment as
                // output 0 and the change as output 1, so the entry that opens
                // this note is always at a higher leaf index.
                const key = hint.commitmentHex.toLowerCase();
                if (!seenSent.has(key)) {
                    seenSent.add(key);
                    pendingSent.push({ hint, ephIndex: outgoingIndex });
                }
                return null;
            }

            const viewTag = activation !== null && hint.leafIndex >= activation;
            const result = tryDecryptNoteVerbose(
                hint,
                keys.viewingKey,
                keys.spendingKey,
                keys.ownerPk,
                { viewTag }
            );
            if (result.reason === 'view_tag_mismatch') tagFiltered++;
            return result.note;
        } catch {
            // Malformed hint (bad hex/length). No per-item logging: hint identifiers
            // must not leak to the console. The scan reports one aggregate count.
            return null;
        }
    });
    // Now that every change note in the batch has been read, open the payments
    // held back above. Running this as a second pass is what makes the common
    // case work at all: a transfer's payment is output 0 and its change output
    // 1, so the key that opens a payment is never available when the payment
    // itself is reached.
    //
    // One retry, not a loop: a book entry opens the payment it was sealed for
    // and no other, so learning more keys here cannot unlock anything already
    // tried. Whatever stays closed belongs to a change note in a later batch,
    // and `learnedRecipients` carries the keys forward for it.
    const carried = keys.recipientCandidates ?? [];
    for (const { hint, ephIndex } of pendingSent) {
        // Each sealed entry is opened against THIS payment's commitment, which
        // is the key it was sealed under. An entry belonging to a different
        // payment yields 32 unrelated bytes, and the memo's MAC rejects it —
        // the same check that rejects a wrong candidate from an earlier batch.
        const candidates = [
            ...sealedEntries.map((e) =>
                openRecipientBookEntry(e, keys.outgoingViewingKey!, hint.commitmentHex)
            ),
            ...carried,
        ];
        const sent = recoverSentNote({
            hint,
            outgoingViewingKey: keys.outgoingViewingKey!,
            ephIndex,
            recipientCandidates: candidates,
        });
        if (!sent) {
            unmatchedSent.push({ hint, ephIndex });
            continue;
        }
        const { recipientIvk, ...facts } = sent;
        learnedRecipients.add(toHex(recipientIvk));
        sentNotes.push({
            ...facts,
            counterpartyIvkHex: toHex(recipientIvk),
            encryptedMemo: hint.encryptedMemo ?? '',
        });
    }

    return {
        notes,
        tagFiltered,
        selfMatched,
        pairwiseMatched,
        maxSelfEphIndex,
        maxOutgoingEphIndex,
        sentNotes,
        learnedRecipients: [...learnedRecipients],
        unmatchedSent,
        sealedBookEntries: sealedEntries.map((e) => e.toString()),
    };
}
