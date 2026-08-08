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
 * No vault, no stores, no I/O, and every value that crosses the boundary is
 * structured-clone friendly, so this runs unchanged on the main thread or
 * inside a worker.
 */
import { tryDecryptNoteVerbose } from '../../../protocol/note/index';
import { getKnownEphWindow } from './ephWindow';
import type { DecryptBatchResult, ScanKeys } from './types';
import type { ScanCommitment } from '../../../protocol/types';

/** ephPk as the indexer serves it: hint field, or the memo's last 32 bytes. */
function hintEphPkHex(hint: ScanCommitment & { ephPkHex?: string | null }): string | null {
    if (hint.ephPkHex) return hint.ephPkHex.toLowerCase();
    const memo = hint.encryptedMemo;
    if (!memo || memo.length < 66) return null;
    return ('0x' + memo.slice(-64)).toLowerCase();
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
export function decryptHintBatch(
    hints: Array<ScanCommitment & { ephPkHex?: string | null }>,
    keys: ScanKeys
): DecryptBatchResult {
    const activation = keys.viewTagActivationLeaf ?? null;
    const knownWindow = getKnownEphWindow(keys);
    let tagFiltered = 0;
    let selfMatched = 0;
    let pairwiseMatched = 0;
    let maxSelfEphIndex: number | null = null;

    const notes = hints.map((hint) => {
        try {
            const known = knownWindow?.byEphPk.get(hintEphPkHex(hint) ?? '');
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
                    } else {
                        pairwiseMatched++;
                    }
                    return result.note;
                }
                // ephPk matched but the note didn't validate (astronomically unlikely
                // point collision, or corrupt memo) — fall through to the normal path.
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
    return { notes, tagFiltered, selfMatched, pairwiseMatched, maxSelfEphIndex };
}
