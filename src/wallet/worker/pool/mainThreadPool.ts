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
import { DECRYPT_YIELD_EVERY, type DecryptPool } from './types';
import type { ZkNote } from '../../../protocol/types';

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

            for (let i = 0; i < hints.length; i += DECRYPT_YIELD_EVERY) {
                // Yield between bursts and re-check abort: the user may have cancelled
                // while we were parked.
                if (i > 0) {
                    await yieldToBrowser();
                    if (signal?.aborted) throw scanAbortError();
                }
                const burst = decryptHintBatch(hints.slice(i, i + DECRYPT_YIELD_EVERY), keys);
                notes.push(...burst.notes);
                tagFiltered += burst.tagFiltered;
                selfMatched += burst.selfMatched;
                pairwiseMatched += burst.pairwiseMatched;
                if (burst.maxSelfEphIndex !== null) {
                    maxSelfEphIndex = Math.max(maxSelfEphIndex ?? -1, burst.maxSelfEphIndex);
                }
            }
            return { notes, tagFiltered, selfMatched, pairwiseMatched, maxSelfEphIndex };
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
