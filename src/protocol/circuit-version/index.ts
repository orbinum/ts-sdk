/**
 * Pinning a proof to the circuit version its note was created under.
 *
 * ```
 * CircuitVersionResolver.ts  the fail-closed gate: prover, chain and VK must agree
 * vkHash.ts                  hash comparison, deliberately strict about malformed input
 * types.ts                   what a host injects and what it gets back
 * ```
 *
 * A VK rotation changes what the chain verifies with, but notes already in a
 * vault were created under the old key. Resolving to the note's version rather
 * than the active one is what keeps those notes spendable.
 */
export { CircuitVersionResolver } from './CircuitVersionResolver';
// `vkHash` stays internal: it is how THIS gate compares, not a utility a
// consumer composes with. Tests import it from its own module.
export type {
    ResolvedSpendVersion,
    ResolvedProverVersion,
    VersionedArtifactProvider,
    ProviderFactory,
} from './types';
