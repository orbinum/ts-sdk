/**
 * Decrypting on the calling thread, in bursts.
 *
 * The only option outside a browser, and the fallback when a worker dies. In a
 * tab it would freeze the page, so the loop hands control back every
 * `DECRYPT_YIELD_EVERY` hints and re-checks the abort signal on the way through
 * — a scan the user cancelled must stop at the next burst, not at the end.
 */
import { decryptHintBatch } from '../kernel/decryptBatch';
import { clearKnownEphWindow } from '../kernel/ephWindow';
import { scanAbortError } from '../../../foundation/errors/abort';
import { toHex, fromHex } from '../../../foundation/encoding/hex';
import { DECRYPT_YIELD_EVERY, type DecryptPool } from './types';
import type { ZkNote } from '../../../protocol/types';
import type { SentNoteMatch, UnmatchedSentHint } from '../kernel/types';

/**
 * Hand the main thread back to the browser so it can paint. `scheduler.yield`
 * resumes with priority (no starvation); `setTimeout(0)` is the fallback — both
 * are MACROtasks, unlike `Promise.resolve()`, which drains before the next paint
 * and so wouldn't unfreeze the tab.
 */
function yieldToBrowser(): Promise<void> {
    const scheduler = (globalThis as { scheduler?: { yield?: () => Promise<void> } }).scheduler;
    if (scheduler?.yield) return scheduler.yield();
    return new Promise((resolve) => setTimeout(resolve, 0));
}

export function createMainThreadPool(): DecryptPool {
    return {
        async decryptBatch(hints, keys, signal) {
            const notes: Array<ZkNote | null> = [];
            let tagFiltered = 0;
            let selfMatched = 0;
            let pairwiseMatched = 0;
            let maxSelfEphIndex: number | null = null;
            let maxOutgoingEphIndex: number | null = null;
            const sentNotes: SentNoteMatch[] = [];
            const unmatchedSent: UnmatchedSentHint[] = [];
            const sealedBookEntries = new Set<string>();
            const learnedRecipients = new Set<string>(
                (keys.recipientCandidates ?? []).map((c) => toHex(c))
            );

            for (let i = 0; i < hints.length; i += DECRYPT_YIELD_EVERY) {
                // Yield between bursts and re-check abort: the user may have cancelled
                // while we were parked.
                if (i > 0) {
                    await yieldToBrowser();
                    if (signal?.aborted) throw scanAbortError();
                }
                // Recipients learned so far are fed forward: bursts run in
                // order, so a change note in an earlier one can open the payment
                // that follows it without waiting for another pass.
                const burst = decryptHintBatch(hints.slice(i, i + DECRYPT_YIELD_EVERY), {
                    ...keys,
                    recipientCandidates: [...learnedRecipients].map((h) => fromHex(h)),
                });
                notes.push(...burst.notes);
                tagFiltered += burst.tagFiltered;
                selfMatched += burst.selfMatched;
                pairwiseMatched += burst.pairwiseMatched;
                sentNotes.push(...(burst.sentNotes ?? []));
                unmatchedSent.push(...(burst.unmatchedSent ?? []));
                for (const e of burst.sealedBookEntries ?? []) sealedBookEntries.add(e);
                for (const r of burst.learnedRecipients ?? []) learnedRecipients.add(r);
                if (burst.maxSelfEphIndex !== null) {
                    maxSelfEphIndex = Math.max(maxSelfEphIndex ?? -1, burst.maxSelfEphIndex);
                }
                if (burst.maxOutgoingEphIndex != null) {
                    maxOutgoingEphIndex = Math.max(
                        maxOutgoingEphIndex ?? -1,
                        burst.maxOutgoingEphIndex
                    );
                }
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
                sealedBookEntries: [...sealedBookEntries],
            };
        },
        terminate() {
            // No worker to kill, but the kernel's discovery window is still
            // here — and on this pool "here" is the page's own heap. It holds
            // one ECDH shared secret per index, derived from the viewing key,
            // so dropping it is the whole point of terminating.
            clearKnownEphWindow();
        },
    };
}
