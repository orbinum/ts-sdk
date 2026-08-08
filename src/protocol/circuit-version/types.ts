/**
 * The vocabulary of pinning a proof to one circuit version.
 *
 * Separate from the resolver so a host can name what it injects — a fake
 * provider in a test, a self-hosted artifact mirror in production — without
 * importing the class that consumes them.
 */
import type { CircuitType, ArtifactProvider } from '@orbinum/proof-generator';

/** The resolved version + VK hash the prover reports for a circuit. */
export type ResolvedProverVersion = {
    version: number;
    vkHash: string;
};

/**
 * A provider that can both serve artifacts and report the version it resolved
 * for a circuit (`WebArtifactProvider` implements both). The resolver needs the
 * version-reporting half; it is a separate type so tests can inject a fake.
 */
export type VersionedArtifactProvider = ArtifactProvider & {
    getResolvedVersion(circuit: CircuitType): Promise<ResolvedProverVersion>;
};

/**
 * Builds a provider pinned to `noteVersion` for `circuit`. The default uses the
 * npm CDN (or `baseUrl` mirror); tests inject a fake.
 */
export type ProviderFactory = (
    circuit: CircuitType,
    noteVersion: number
) => VersionedArtifactProvider;

/**
 * What a spend needs to prove and submit under one specific circuit version.
 *
 * Produced only after the prover, the chain's supported-version list and both
 * sides' VK hashes have been cross-checked — see `CircuitVersionResolver`.
 */
export type ResolvedSpendVersion = {
    /** Artifact provider pinned to the note's circuit version. Pass to `generate*Proof`. */
    provider: ArtifactProvider;
    /** The circuit version to send in the extrinsic (`circuit_version` arg). */
    version: number;
};
