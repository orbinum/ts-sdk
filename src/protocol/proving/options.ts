/**
 * The options every proof entry point accepts.
 *
 * One declaration instead of the same inline object repeated per circuit: the
 * three generators differ in their INPUTS, never in how a caller configures
 * proving, and a shape written three times drifts on the fourth.
 */
import type { ArtifactProvider } from '@orbinum/proof-generator';

export interface ProofOptions {
    /** Where circuit artifacts come from. Defaults to the web provider. */
    provider?: ArtifactProvider;
    verbose?: boolean;
    /**
     * Prove on ONE thread instead of a Web Worker per logical core.
     *
     * Omit this. Left absent, `@orbinum/proof-generator` decides from the
     * device — and getting it wrong on a phone is not a slow proof but no proof
     * at all: `ffjavascript` spawns one worker per core, each with its own
     * `WebAssembly.Memory`, and a mobile browser's per-tab budget cannot hold
     * them. The transfer of the WASM buffer then fails with
     * `Data cannot be cloned, out of memory`.
     *
     * Pass it only when the host knows better than the heuristic — a desktop
     * app certain of its environment, or a benchmark pinning one mode. The
     * proof is byte-identical either way; only the wall-clock changes.
     */
    singleThread?: boolean;
}

/**
 * Narrows caller options into what `generateProof` takes.
 *
 * Spread-conditional rather than assigning undefined: the package treats an
 * ABSENT `singleThread` as "decide for me" and an explicit `false` as "use
 * threads", so passing `undefined` would silently disable the device
 * heuristic on exactly the phones it exists for.
 */
export function toGenerateOptions(
    provider: ArtifactProvider,
    options: ProofOptions
): { provider: ArtifactProvider; verbose?: boolean; singleThread?: boolean } {
    return {
        provider,
        ...(options.verbose !== undefined ? { verbose: options.verbose } : {}),
        ...(options.singleThread !== undefined ? { singleThread: options.singleThread } : {}),
    };
}
