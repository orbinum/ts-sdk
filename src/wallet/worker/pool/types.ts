/**
 * The pool contract, and the minimal Worker surface it drives.
 *
 * `WorkerLike` is deliberately narrower than the DOM `Worker`: the pool only
 * ever posts a message, reads one back, and terminates. Keeping it to those
 * four members is what lets a test pass a fake that runs the kernel inline, and
 * what keeps this file free of `lib.dom`.
 */
import type { DecryptBatchResult, ScanKeys } from '../kernel/types';
import type { ScanCommitment } from '../../../protocol/types';

/** Cap on pool size — EC math parallelizes linearly but tabs share the CPU. */
/**
 * Ceiling on workers per batch. Past four the ECDH loop is bound by memory
 * bandwidth rather than cores, and every extra worker still costs its own copy
 * of the precomputed discovery window.
 */
export const MAX_WORKERS = 4;

/**
 * Main-thread strategy only: trial-decrypts to run before yielding so the
 * browser can paint between bursts of synchronous EC math.
 */
export const DECRYPT_YIELD_EVERY = 25;

/**
 * The message a worker hands back, structurally.
 *
 * Not `MessageEvent`: that name lives in `lib.dom`, and naming it here would put
 * it in the published `.d.ts` of the ROOT entry — so a React Native consumer
 * compiling with `lib: esnext` and no `@types/node` would fail to typecheck an
 * import it never asked for. `data` is the only member the pool reads, and a
 * real `MessageEvent` satisfies this shape.
 *
 * Same reasoning as `CryptoKey` in `foundation/crypto/webcrypto-types.d.ts`.
 */
export interface WorkerMessage {
    data: unknown;
}

/**
 * The minimal Worker surface the pool needs — a real Worker or a test fake.
 *
 * The handler parameters are typed `any` rather than `unknown`, which is the
 * one place this file trades strictness for reach. A DOM `Worker` declares
 * `onerror` as `(event: ErrorEvent) => void`, and function parameters are
 * contravariant: a handler accepting `unknown` is NOT assignable where one
 * accepting `ErrorEvent` is expected. Typing these as `unknown` therefore makes
 * a real browser `Worker` fail to satisfy the interface — the exact consumer
 * this contract exists to serve.
 *
 * `any` keeps both a real Worker and an inline fake assignable while still
 * keeping `MessageEvent`/`ErrorEvent` — both `lib.dom` — out of the published
 * types. The pool reads only `event.data` and ignores the error payload
 * entirely, so nothing downstream depends on the precision given up here.
 */
export interface WorkerLike {
    postMessage(message: unknown): void;
    /* eslint-disable-next-line @typescript-eslint/no-explicit-any */
    onmessage: ((event: any) => void) | null;
    /** Error payload is unused: the pool treats any error as "worker died". */
    /* eslint-disable-next-line @typescript-eslint/no-explicit-any */
    onerror: ((event: any) => void) | null;
    terminate(): void;
}

export type WorkerFactory = () => WorkerLike;

export interface DecryptPool {
    /** Decrypts `hints` in input order. Rejects with AbortError when cancelled. */
    decryptBatch(
        hints: ScanCommitment[],
        keys: ScanKeys,
        signal?: AbortSignal
    ): Promise<DecryptBatchResult>;
    /** Tears down every worker. The pool is per-scan; always call when done. */
    terminate(): void;
}

/** The message a worker receives. Structured-clone friendly by construction. */
export interface DecryptRequest {
    hints: ScanCommitment[];
    keys: ScanKeys;
}

/** Thrown when a worker dies mid-batch; the factory catches it to fall back. */
export const WORKER_CRASHED = 'Decrypt worker crashed';
