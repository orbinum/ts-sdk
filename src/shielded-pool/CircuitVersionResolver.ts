import {
    CircuitType,
    WebArtifactProvider,
    circuitTypeToId,
    type ArtifactProvider,
} from '@orbinum/proof-generator';
import type { ZkVerifierModule } from '../zk-verifier/ZkVerifierModule';

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
 * The single fail-closed choke point for spending a note under a specific
 * circuit version.
 *
 * A note carries the circuit version it was created under (`ZkNote.circuitVersion`).
 * When that note is spent, the proof MUST be generated against that version's
 * artifacts and verified on-chain against that version's VK — never the current
 * `active_version`, or a VK rotation would make old notes unspendable.
 *
 * `resolve()` pins the prover to the note's version, cross-checks that the
 * prover's VK hash matches what the chain declares for that version, and confirms
 * the chain still supports it. On any mismatch it throws BEFORE any proof is
 * generated — there is no fallback to the active version. The returned
 * `{ provider, version }` is fed to the proof generator and the extrinsic.
 */
export type ResolvedSpendVersion = {
    /** Artifact provider pinned to the note's circuit version. Pass to `generate*Proof`. */
    provider: ArtifactProvider;
    /** The circuit version to send in the extrinsic (`circuit_version` arg). */
    version: number;
};

export class CircuitVersionResolver {
    private readonly makeProvider: ProviderFactory;

    constructor(
        private readonly zkVerifier: ZkVerifierModule,
        /** Optional base URL for a self-hosted artifact mirror (else the npm CDN). */
        baseUrl?: string,
        /** Override how the pinned provider is built (tests inject a fake). */
        providerFactory?: ProviderFactory
    ) {
        this.makeProvider =
            providerFactory ??
            ((circuit, noteVersion) =>
                new WebArtifactProvider({
                    ...(baseUrl ? { baseUrl } : {}),
                    circuitVersions: { [circuit]: noteVersion },
                }));
    }

    /**
     * Resolves the prover + on-chain version for spending a note of `circuit`
     * created under `noteVersion`. Fail-closed: throws on unsupported version or
     * VK-hash mismatch (CDN vs chain), before generating any proof.
     */
    async resolve(circuit: CircuitType, noteVersion: number): Promise<ResolvedSpendVersion> {
        if (!Number.isInteger(noteVersion) || noteVersion <= 0) {
            throw new Error(
                `CircuitVersionResolver: invalid note circuitVersion ${noteVersion} for ${circuit}`
            );
        }

        // Pin the prover to the note's exact version (override the manifest active version).
        const provider = this.makeProvider(circuit, noteVersion);

        // Prover's resolved version + declared VK hash for that version.
        const resolved = await provider.getResolvedVersion(circuit);
        if (resolved.version !== noteVersion) {
            throw new Error(
                `CircuitVersionResolver: prover resolved ${circuit} to v${resolved.version}, ` +
                    `expected v${noteVersion}`
            );
        }

        // Chain's view: supported versions + VK hash per version.
        const circuitId = circuitTypeToId(circuit);
        const info = await this.zkVerifier.getCircuitVersionInfo(circuitId);
        if (!info) {
            throw new Error(
                `CircuitVersionResolver: chain reports no version info for ${circuit} (id ${circuitId})`
            );
        }
        if (!info.supportedVersions.includes(noteVersion)) {
            throw new Error(
                `CircuitVersionResolver: chain does not support ${circuit} v${noteVersion} ` +
                    `(supported: ${info.supportedVersions.join(', ')})`
            );
        }

        // Cross-check the VK hash: the prover's artifacts must match the VK the
        // chain will verify against. A mismatch means the CDN and chain disagree.
        const chainVk = info.vkHashes.find((h) => h.version === noteVersion);
        if (!chainVk) {
            throw new Error(
                `CircuitVersionResolver: chain has no VK hash for ${circuit} v${noteVersion}`
            );
        }
        if (!vkHashEquals(chainVk.vkHash, resolved.vkHash)) {
            throw new Error(
                `CircuitVersionResolver: VK hash mismatch for ${circuit} v${noteVersion} — ` +
                    `prover ${resolved.vkHash}, chain ${chainVk.vkHash}`
            );
        }

        return { provider, version: noteVersion };
    }
}

/**
 * Compares two VK hashes case- and `0x`-prefix-insensitively.
 *
 * Both sides must be a well-formed 32-byte hex hash (64 hex chars, optional
 * `0x`). A malformed or empty value is NEVER considered equal — this closes a
 * fail-open where `'' === ''` (an absent hash on both sides) would pass the gate.
 */
function vkHashEquals(a: string, b: string): boolean {
    const na = normalizeHash(a);
    const nb = normalizeHash(b);
    if (na === null || nb === null) return false;
    return na === nb;
}

/** Lowercases and strips `0x`; returns null if not a 32-byte hex hash. */
function normalizeHash(h: string): string | null {
    if (typeof h !== 'string') return null;
    const s = h.toLowerCase().startsWith('0x') ? h.toLowerCase().slice(2) : h.toLowerCase();
    return /^[0-9a-f]{64}$/.test(s) ? s : null;
}
