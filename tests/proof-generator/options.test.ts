/**
 * `toGenerateOptions` — how caller options reach `generateProof`.
 *
 * One property carries the mobile fix: an ABSENT `singleThread` must stay
 * absent. `@orbinum/proof-generator` reads a missing value as "decide from the
 * device" and an explicit `false` as "use threads", so forwarding `undefined`
 * would disable the heuristic on exactly the phones it exists for — the ones
 * where `ffjavascript` spawns a Worker per core and the WASM transfer dies with
 * `Data cannot be cloned, out of memory`.
 *
 * The distinction is invisible at a glance (`{ singleThread: undefined }` looks
 * like `{}`) and `in` is the only operator that tells them apart, which is why
 * it is asserted rather than assumed.
 */
import { describe, it, expect } from 'vitest';
import { toGenerateOptions } from '../../src/proof-generator/options';
import type { ArtifactProvider } from '@orbinum/proof-generator';

const provider = {} as ArtifactProvider;

describe('toGenerateOptions', () => {
    it('always forwards the resolved provider', () => {
        expect(toGenerateOptions(provider, {}).provider).toBe(provider);
    });

    it('SECURITY: omits singleThread entirely when the caller says nothing', () => {
        // Present-but-undefined would read as an explicit choice and turn the
        // device heuristic off.
        expect('singleThread' in toGenerateOptions(provider, {})).toBe(false);
    });

    it('forwards an explicit true', () => {
        expect(toGenerateOptions(provider, { singleThread: true })).toMatchObject({
            singleThread: true,
        });
    });

    it('forwards an explicit false — a host may know better than the heuristic', () => {
        expect(toGenerateOptions(provider, { singleThread: false })).toMatchObject({
            singleThread: false,
        });
    });

    it('omits verbose when unset, for the same reason', () => {
        expect('verbose' in toGenerateOptions(provider, {})).toBe(false);
    });

    it('forwards verbose when set', () => {
        expect(toGenerateOptions(provider, { verbose: true })).toMatchObject({ verbose: true });
    });

    it('carries both flags together', () => {
        expect(toGenerateOptions(provider, { verbose: true, singleThread: true })).toEqual({
            provider,
            verbose: true,
            singleThread: true,
        });
    });
});
