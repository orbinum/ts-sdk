/**
 * Where the kernel runs: across Web Workers, or on the calling thread.
 *
 * Both strategies satisfy `DecryptPool`, so the scanner never learns which one
 * it got. `createDecryptPool` picks, and falls back to the main thread if a
 * worker dies mid-scan.
 */
export { createDecryptPool } from './createDecryptPool';
export { createMainThreadPool } from './mainThreadPool';
export { createWorkerPool } from './workerPool';
export { MAX_WORKERS, DECRYPT_YIELD_EVERY, WORKER_CRASHED } from './types';
export type {
    DecryptPool,
    WorkerLike,
    WorkerMessage,
    WorkerFactory,
    DecryptRequest,
} from './types';
