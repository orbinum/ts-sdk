/**
 * One request/response exchange with a single worker.
 *
 * A worker has no request IDs — it answers whatever it was last posted — so the
 * pool keeps exactly one batch in flight per worker and this function owns that
 * invariant. Handlers are cleared on every exit path, including abort, because
 * a stale `onmessage` would resolve the NEXT batch with the previous one's
 * result.
 */
import { scanAbortError } from '../../../foundation/errors/abort';
import type { SentNoteMatch, UnmatchedSentHint } from '../kernel/types';
import { WORKER_CRASHED, type DecryptRequest, type WorkerLike } from './types';
import type { DecryptBatchResult } from '../kernel/types';
import type { ZkNote } from '../../../protocol/types';

/** What a worker posts back. Every field optional — the shim is host-written. */
interface WorkerReply {
    notes?: Array<ZkNote | null>;
    tagFiltered?: number;
    selfMatched?: number;
    pairwiseMatched?: number;
    maxSelfEphIndex?: number | null;
    maxOutgoingEphIndex?: number | null;
    sentNotes?: SentNoteMatch[];
    learnedRecipients?: string[];
    unmatchedSent?: UnmatchedSentHint[];
    sealedBookEntries?: string[];
    error?: string;
}

export function runOnWorker(
    worker: WorkerLike,
    payload: DecryptRequest,
    signal?: AbortSignal
): Promise<DecryptBatchResult> {
    return new Promise((resolve, reject) => {
        const onAbort = () => {
            cleanup();
            reject(scanAbortError());
        };
        const cleanup = () => {
            worker.onmessage = null;
            worker.onerror = null;
            signal?.removeEventListener('abort', onAbort);
        };

        // Event type inferred from `WorkerLike`, never annotated as
        // `MessageEvent`: that name is `lib.dom`, and naming it here would put
        // it back into the root entry's published types.
        worker.onmessage = (event) => {
            cleanup();
            const data = event.data as WorkerReply;
            if (data.error !== undefined) {
                reject(new Error(data.error));
                return;
            }
            // Defaulted rather than trusted: the worker shim is written by the
            // host, and a reply missing a counter must not poison the totals.
            resolve({
                notes: data.notes ?? [],
                tagFiltered: data.tagFiltered ?? 0,
                selfMatched: data.selfMatched ?? 0,
                pairwiseMatched: data.pairwiseMatched ?? 0,
                maxSelfEphIndex: data.maxSelfEphIndex ?? null,
                maxOutgoingEphIndex: data.maxOutgoingEphIndex ?? null,
                sentNotes: data.sentNotes ?? [],
                learnedRecipients: data.learnedRecipients ?? [],
                unmatchedSent: data.unmatchedSent ?? [],
                sealedBookEntries: data.sealedBookEntries ?? [],
            });
        };
        worker.onerror = () => {
            cleanup();
            reject(new Error(WORKER_CRASHED));
        };

        signal?.addEventListener('abort', onAbort, { once: true });
        worker.postMessage(payload);
    });
}
