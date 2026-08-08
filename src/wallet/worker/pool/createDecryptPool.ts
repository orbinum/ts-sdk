/**
 * Choosing a decryption strategy, and surviving a worker that dies.
 *
 * The two strategies are interchangeable behind `DecryptPool`; this picks one
 * and wraps it with the crash fallback. A worker that crashes mid-scan would
 * otherwise abort the whole scan, and the main thread can always finish the job
 * — slower, but a slow scan beats a failed one.
 */
import { createMainThreadPool } from './mainThreadPool';
import { createWorkerPool } from './workerPool';
import { MAX_WORKERS, WORKER_CRASHED, type DecryptPool, type WorkerFactory } from './types';

/**
 * Builds the decrypt pool for one scan run.
 *
 * `factory` is required rather than defaulted: constructing a worker means
 * naming a module URL, which only the host's bundler can resolve. Pass `null`
 * to decrypt on the calling thread — correct everywhere, and the only option
 * outside a browser.
 */
export function createDecryptPool(options: {
    factory: WorkerFactory | null;
    /** Workers to spread a batch across. Defaults to `MAX_WORKERS`. */
    size?: number;
}): DecryptPool {
    const { factory } = options;
    if (!factory) return createMainThreadPool();

    let pool = createWorkerPool(factory, Math.min(options.size ?? MAX_WORKERS, MAX_WORKERS));
    return {
        async decryptBatch(hints, keys, signal) {
            try {
                return await pool.decryptBatch(hints, keys, signal);
            } catch (err) {
                // Only a crash is recoverable. An abort must propagate — the user
                // asked to stop, and retrying on the main thread would ignore that.
                if (!(err instanceof Error) || err.message !== WORKER_CRASHED) throw err;
                // Swapped in place, so `terminate()` below reaches the strategy
                // that is actually running — and the main-thread one clears the
                // discovery window, which the dead worker pool no longer can.
                pool = createMainThreadPool();
                return pool.decryptBatch(hints, keys, signal);
            }
        },
        terminate: () => pool.terminate(),
    };
}
