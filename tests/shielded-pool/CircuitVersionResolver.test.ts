import { describe, it, expect } from 'vitest';
import { CircuitType } from '@orbinum/proof-generator';
import {
    CircuitVersionResolver,
    type ProviderFactory,
    type VersionedArtifactProvider,
} from '../../src/shielded-pool/CircuitVersionResolver';
import type { ZkVerifierModule } from '../../src/zk-verifier/ZkVerifierModule';
import type { ZkVerifierCircuitVersionInfo } from '../../src/zk-verifier/types/client';

const VK_V1 = '0x' + 'ab'.repeat(32);
const VK_V2 = '0x' + 'cd'.repeat(32);

// Fake provider: reports a fixed resolved version + vkHash, no network.
function fakeProvider(version: number, vkHash: string): VersionedArtifactProvider {
    const notImpl = () => Promise.reject(new Error('not used in resolver test'));
    return {
        getResolvedVersion: async () => ({ version, packageVersion: '0.0.0', vkHash }),
        getCircuitWasm: notImpl,
        getCircuitZkey: notImpl,
        getCircuitProvingKey: notImpl,
    } as unknown as VersionedArtifactProvider;
}

// Fake ZkVerifierModule returning a canned circuit-version info (or null).
function fakeZkVerifier(info: ZkVerifierCircuitVersionInfo | null): ZkVerifierModule {
    return {
        getCircuitVersionInfo: async () => info,
    } as unknown as ZkVerifierModule;
}

function chainInfo(over: Partial<ZkVerifierCircuitVersionInfo> = {}): ZkVerifierCircuitVersionInfo {
    return {
        circuitId: 2, // unshield
        activeVersion: 1,
        proofSystem: 'Groth16',
        supportedVersions: [1],
        vkHashes: [{ version: 1, vkHash: VK_V1 }],
        historicalVersions: [],
        ...over,
    };
}

function makeResolver(
    info: ZkVerifierCircuitVersionInfo | null,
    provider: VersionedArtifactProvider
): CircuitVersionResolver {
    const factory: ProviderFactory = () => provider;
    return new CircuitVersionResolver(fakeZkVerifier(info), undefined, factory);
}

describe('CircuitVersionResolver', () => {
    it('resolves v1 when prover, chain support and vk_hash all agree', async () => {
        const resolver = makeResolver(chainInfo(), fakeProvider(1, VK_V1));
        const res = await resolver.resolve(CircuitType.Unshield, 1);
        expect(res.version).toBe(1);
        expect(res.provider).toBeDefined();
    });

    it('after a rotation, pins the note version (not the active version)', async () => {
        // Chain rotated to active=2 but still supports v1.
        const info = chainInfo({
            activeVersion: 2,
            supportedVersions: [1, 2],
            vkHashes: [
                { version: 1, vkHash: VK_V1 },
                { version: 2, vkHash: VK_V2 },
            ],
        });
        const resolver = makeResolver(info, fakeProvider(1, VK_V1));
        const res = await resolver.resolve(CircuitType.Unshield, 1);
        expect(res.version).toBe(1); // the OLD note's version, not active=2
    });

    it('throws when the chain does not support the note version', async () => {
        // v1 note, chain deprecated v1 (supports only [2]).
        const info = chainInfo({
            activeVersion: 2,
            supportedVersions: [2],
            vkHashes: [{ version: 2, vkHash: VK_V2 }],
        });
        const resolver = makeResolver(info, fakeProvider(1, VK_V1));
        await expect(resolver.resolve(CircuitType.Unshield, 1)).rejects.toThrow(
            /does not support/
        );
    });

    it('throws on vk_hash mismatch between prover and chain', async () => {
        // Chain says v1 VK is VK_V1, but the prover serves a different VK.
        const resolver = makeResolver(chainInfo(), fakeProvider(1, VK_V2));
        await expect(resolver.resolve(CircuitType.Unshield, 1)).rejects.toThrow(
            /VK hash mismatch/
        );
    });

    it('throws when the prover resolves a different version than requested', async () => {
        const resolver = makeResolver(chainInfo(), fakeProvider(2, VK_V1));
        await expect(resolver.resolve(CircuitType.Unshield, 1)).rejects.toThrow(
            /prover resolved/
        );
    });

    it('throws when the chain has no version info for the circuit', async () => {
        const resolver = makeResolver(null, fakeProvider(1, VK_V1));
        await expect(resolver.resolve(CircuitType.Unshield, 1)).rejects.toThrow(
            /no version info/
        );
    });

    it('rejects an invalid note version (0 or negative) before any lookup', async () => {
        const resolver = makeResolver(chainInfo(), fakeProvider(1, VK_V1));
        await expect(resolver.resolve(CircuitType.Unshield, 0)).rejects.toThrow(
            /invalid note circuitVersion/
        );
    });

    it('matches vk_hash case- and 0x-prefix-insensitively', async () => {
        const info = chainInfo({ vkHashes: [{ version: 1, vkHash: VK_V1.toUpperCase() }] });
        // prover reports the same hash without 0x and lowercase
        const resolver = makeResolver(info, fakeProvider(1, 'ab'.repeat(32)));
        const res = await resolver.resolve(CircuitType.Unshield, 1);
        expect(res.version).toBe(1);
    });
});
