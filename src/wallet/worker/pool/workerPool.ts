/**
 * Fanning a batch across Web Workers.
 *
 * One slice per worker, decrypted in parallel and concatenated in order — which
 * is why the slices are contiguous ranges rather than a round-robin: rebuilding
 * the input order then needs no per-hint tagging.
 *
 * Workers spawn lazily on the first batch and are reused for the rest of the
 * scan, because each one pays the discovery-window precompute on its first
 * message and throwing that away per page would cost more than it saves.
 */
import { runOnWorker } from './workerRpc';
import { scanAbortError } from '../../../foundation/errors/abort';
import { EMPTY_BATCH_RESULT } from '../kernel/types';
import type { DecryptPool, WorkerFactory, WorkerLike } from './types';
import type { DecryptBatchResult } from '../kernel/types';
import type { ScanCommitment } from '../../../protocol/types';

/** Contiguous slices, one per worker, covering `hints` in order. */
function sliceForWorkers(hints: ScanCommitment[], size: number): ScanCommitment[][] {
    const sliceLength = Math.ceil(hints.length / size);
    const slices: ScanCommitment[][] = [];
    for (let i = 0; i < hints.length; i += sliceLength) {
        slices.push(hints.slice(i, i + sliceLength));
    }
    return slices;
}

/** Concatenates per-slice results back into one, preserving input order. */
function mergeResults(results: DecryptBatchResult[]): DecryptBatchResult {
    return {
        notes: results.flatMap((r) => r.notes),
        tagFiltered: results.reduce((sum, r) => sum + r.tagFiltered, 0),
        selfMatched: results.reduce((sum, r) => sum + r.selfMatched, 0),
        pairwiseMatched: results.reduce((sum, r) => sum + r.pairwiseMatched, 0),
        sentNotes: results.flatMap((r) => r.sentNotes ?? []),
        // Deduped: slices run in parallel, so the same change note cannot be
        // seen twice, but two different ones may name the same recipient.
        learnedRecipients: [...new Set(results.flatMap((r) => r.learnedRecipients ?? []))],
        unmatchedSent: results.flatMap((r) => r.unmatchedSent ?? []),
        sealedBookEntries: [...new Set(results.flatMap((r) => r.sealedBookEntries ?? []))],
        maxSelfEphIndex: results.reduce<number | null>(
            (max, r) => (r.maxSelfEphIndex === null ? max : Math.max(max ?? -1, r.maxSelfEphIndex)),
            null
        ),
        maxOutgoingEphIndex: results.reduce<number | null>(
            (max, r) =>
                r.maxOutgoingEphIndex == null ? max : Math.max(max ?? -1, r.maxOutgoingEphIndex),
            null
        ),
    };
}

export function createWorkerPool(factory: WorkerFactory, size: number): DecryptPool {
    // Lazy: workers spawn on first batch and are reused across pages.
    const workers: WorkerLike[] = [];
    const workerAt = (i: number): WorkerLike => (workers[i] ??= factory());

    return {
        async decryptBatch(hints, keys, signal) {
            if (signal?.aborted) throw scanAbortError();
            if (hints.length === 0) return { ...EMPTY_BATCH_RESULT, notes: [] };

            try {
                const results = await Promise.all(
                    sliceForWorkers(hints, size).map((slice, i) =>
                        runOnWorker(workerAt(i), { hints: slice, keys }, signal)
                    )
                );
                return mergeResults(results);
            } catch (err) {
                // A worker can't be interrupted mid-computation — on abort or crash the
                // only safe recovery is tearing the pool down. The scan is over anyway.
                this.terminate();
                throw err;
            }
        },
        terminate() {
            for (const worker of workers.splice(0)) worker.terminate();
        },
    };
}
