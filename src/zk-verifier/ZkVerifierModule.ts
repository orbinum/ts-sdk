import type { SubstrateClient } from '../substrate/SubstrateClient';
import type { RawZkVerifierCircuitVersionInfo, RawZkVerifierVkHash } from './types/raw';
import type { ZkVerifierCircuitVersionInfo, ZkVerifierVkHash } from './types/client';

function mapVkHash(raw: RawZkVerifierVkHash): ZkVerifierVkHash {
    return { version: raw.version, vkHash: raw.vk_hash };
}

function mapCircuitVersionInfo(raw: RawZkVerifierCircuitVersionInfo): ZkVerifierCircuitVersionInfo {
    return {
        circuitId: raw.circuit_id,
        activeVersion: raw.active_version,
        proofSystem: 'Groth16',
        supportedVersions: raw.supported_versions,
        vkHashes: raw.vk_hashes.map(mapVkHash),
        historicalVersions: [],
    };
}

/**
 * Typed client for `zkVerifier_*` JSON-RPC endpoints.
 */
export class ZkVerifierModule {
    constructor(private readonly substrate: SubstrateClient) {}

    /** Returns basic version info for all registered circuits. */
    async getAllCircuitVersions(): Promise<ZkVerifierCircuitVersionInfo[]> {
        const raw = await this.substrate.request<RawZkVerifierCircuitVersionInfo[]>(
            'zkVerifier_getAllCircuitVersions',
            []
        );
        return raw.map(mapCircuitVersionInfo);
    }

    /** Returns version info for a specific circuit, or null if not found. */
    async getCircuitVersionInfo(circuitId: number): Promise<ZkVerifierCircuitVersionInfo | null> {
        const raw = await this.substrate.request<RawZkVerifierCircuitVersionInfo | null>(
            'zkVerifier_getCircuitVersionInfo',
            [circuitId]
        );
        return raw ? mapCircuitVersionInfo(raw) : null;
    }
}
