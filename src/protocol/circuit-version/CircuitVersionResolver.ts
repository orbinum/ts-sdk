/**
 * The single fail-closed choke point for spending a note under a specific
 * circuit version.
 *
 * A note carries the circuit version it was created under
 * (`ZkNote.circuitVersion`). When that note is spent, the proof MUST be
 * generated against that version's artifacts and verified on-chain against that
 * version's VK — never the current `active_version`, or a VK rotation would
 * make every older note unspendable.
 *
 * `resolve()` runs four checks and throws on the first failure, all BEFORE any
 * proof is generated. There is no fallback to the active version: proving takes
 * seconds and a wrong version is rejected on chain anyway, so failing early
 * costs the user nothing and failing open would cost them a spend.
 */
import { CircuitType, WebArtifactProvider, circuitTypeToId } from '@orbinum/proof-generator';
import type { ZkVerifierCircuitVersionInfo } from '../../chain/pallet/zk-verifier/types/client';
import type { ZkVerifierModule } from '../../chain/pallet/zk-verifier/ZkVerifierModule';
import { vkHashEquals } from './vkHash';
import type { ProviderFactory, ResolvedProverVersion, ResolvedSpendVersion } from './types';

/** Prefixes every failure, so a caller sees which gate refused the spend. */
const ERR = 'CircuitVersionResolver:';

export class CircuitVersionResolver {
    private readonly makeProvider: ProviderFactory;

    constructor(
        private readonly zkVerifier: ZkVerifierModule,
        /** Optional base URL for a self-hosted artifact mirror (else the npm CDN). */
        baseUrl?: string,
        /** Override how the pinned provider is built (tests inject a fake). */
        providerFactory?: ProviderFactory
    ) {
        this.makeProvider = providerFactory ?? defaultProviderFactory(baseUrl);
    }

    /**
     * Resolves the prover + on-chain version for spending a note of `circuit`
     * created under `noteVersion`.
     *
     * Fail-closed: throws on an invalid version, a prover that pinned something
     * else, a version the chain no longer supports, or a VK hash the two sides
     * disagree on.
     */
    async resolve(circuit: CircuitType, noteVersion: number): Promise<ResolvedSpendVersion> {
        assertUsableVersion(circuit, noteVersion);

        // Pin the prover to the note's exact version, overriding whatever the
        // manifest calls active.
        const provider = this.makeProvider(circuit, noteVersion);
        const resolved = await provider.getResolvedVersion(circuit);
        assertProverPinned(circuit, noteVersion, resolved);

        const info = await this.fetchChainVersionInfo(circuit);
        assertChainSupports(circuit, noteVersion, info);
        assertVkHashesAgree(circuit, noteVersion, info, resolved);

        return { provider, version: noteVersion };
    }

    /** The chain's supported versions and per-version VK hashes for a circuit. */
    private async fetchChainVersionInfo(
        circuit: CircuitType
    ): Promise<ZkVerifierCircuitVersionInfo> {
        const circuitId = circuitTypeToId(circuit);
        const info = await this.zkVerifier.getCircuitVersionInfo(circuitId);
        if (!info) {
            throw new Error(
                `${ERR} chain reports no version info for ${circuit} (id ${circuitId})`
            );
        }
        return info;
    }
}

/** The npm CDN, or a self-hosted mirror when `baseUrl` is given. */
function defaultProviderFactory(baseUrl?: string): ProviderFactory {
    return (circuit, noteVersion) =>
        new WebArtifactProvider({
            ...(baseUrl ? { baseUrl } : {}),
            circuitVersions: { [circuit]: noteVersion },
        });
}

// ─── Gates ───────────────────────────────────────────────────────────────────
// One per failure mode, each throwing with what it saw. Separate functions
// rather than inline branches because each is a distinct reason a spend is
// refused, and a caller reads the message to decide what to tell the user.

/**
 * Rejects a version that could not have come from a real note.
 *
 * Runs before any network call: a zero or fractional version means the note
 * record is damaged, and no lookup will make it spendable.
 */
function assertUsableVersion(circuit: CircuitType, noteVersion: number): void {
    if (!Number.isInteger(noteVersion) || noteVersion <= 0) {
        throw new Error(`${ERR} invalid note circuitVersion ${noteVersion} for ${circuit}`);
    }
}

/**
 * Rejects a prover that pinned a different version than asked.
 *
 * Means the artifact manifest ignored the override — proving would silently use
 * the wrong circuit and produce a proof the chain rejects.
 */
function assertProverPinned(
    circuit: CircuitType,
    noteVersion: number,
    resolved: ResolvedProverVersion
): void {
    if (resolved.version !== noteVersion) {
        throw new Error(
            `${ERR} prover resolved ${circuit} to v${resolved.version}, expected v${noteVersion}`
        );
    }
}

/** Rejects a version the chain has retired or never knew. */
function assertChainSupports(
    circuit: CircuitType,
    noteVersion: number,
    info: ZkVerifierCircuitVersionInfo
): void {
    if (!info.supportedVersions.includes(noteVersion)) {
        throw new Error(
            `${ERR} chain does not support ${circuit} v${noteVersion} ` +
                `(supported: ${info.supportedVersions.join(', ')})`
        );
    }
}

/**
 * Rejects artifacts whose VK is not the one the chain will verify against.
 *
 * The last gate and the one that matters most: the prover's artifacts and the
 * chain's verifying key must be the same key. A mismatch means the CDN and the
 * chain disagree about what v`n` is, and every proof built from those artifacts
 * would fail verification after the user has paid to generate it.
 */
function assertVkHashesAgree(
    circuit: CircuitType,
    noteVersion: number,
    info: ZkVerifierCircuitVersionInfo,
    resolved: ResolvedProverVersion
): void {
    const chainVk = info.vkHashes.find((entry) => entry.version === noteVersion);
    if (!chainVk) {
        throw new Error(`${ERR} chain has no VK hash for ${circuit} v${noteVersion}`);
    }
    if (!vkHashEquals(chainVk.vkHash, resolved.vkHash)) {
        throw new Error(
            `${ERR} VK hash mismatch for ${circuit} v${noteVersion} — ` +
                `prover ${resolved.vkHash}, chain ${chainVk.vkHash}`
        );
    }
}
