/**
 * `@orbinum/sdk/worker` — trial decryption, for a worker or the main thread.
 *
 * Its own entry point because a wallet scan runs the kernel inside a worker,
 * and a worker bundle should carry the decryption path and nothing else — not
 * the chain client, not the extrinsic decoders.
 *
 * ```
 * kernel/  the pure loop: window precompute, then decrypt. No threading.
 * pool/    where it runs: across workers, or on the calling thread.
 * ```
 *
 * The worker itself is not shipped. Creating one requires
 * `new Worker(new URL('./entry.ts', import.meta.url))`, which a bundler
 * rewrites at build time; inside a published package it would resolve
 * differently under Vite, webpack, Next.js and Node, and fail silently in at
 * least one. The host writes those lines against its own toolchain and passes
 * the resulting factory to `createDecryptPool`:
 *
 * ```ts
 * // orbinum.worker.ts
 * import { decryptHintBatch } from '@orbinum/sdk/worker';
 *
 * self.onmessage = (e) => {
 *   try {
 *     self.postMessage(decryptHintBatch(e.data.hints, e.data.keys));
 *   } catch (err) {
 *     self.postMessage({ error: err instanceof Error ? err.message : String(err) });
 *   }
 * };
 * ```
 *
 * ```ts
 * createDecryptPool({
 *   factory: () => new Worker(new URL('./orbinum.worker.ts', import.meta.url), { type: 'module' }),
 * });
 * ```
 *
 * Passing `factory: null` runs the same kernel on the calling thread — correct
 * everywhere, and the only option outside a browser.
 */
export * from './kernel/index';
export * from './pool/index';
