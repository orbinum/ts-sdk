import { describe, it, expect, vi } from 'vitest';
import { RpcV2Module } from '../../src/rpc-v2/RpcV2Module';
import { PrivacyModule } from '../../src/rpc-v2/PrivacyModule';
import type { SubstrateClient } from '../../src/substrate/SubstrateClient';

function makeSubstrate(): SubstrateClient {
    return {
        request: vi.fn().mockResolvedValue({}),
    } as unknown as SubstrateClient;
}

// ─── RpcV2Module ──────────────────────────────────────────────────────────────

describe('RpcV2Module', () => {
    it('exposes a PrivacyModule instance as .privacy', () => {
        const substrate = makeSubstrate();
        const mod = new RpcV2Module(substrate);
        expect(mod.privacy).toBeInstanceOf(PrivacyModule);
    });

    it('passes the substrate client to PrivacyModule', async () => {
        const substrate = makeSubstrate();
        vi.mocked(substrate.request).mockResolvedValue('0xroot');

        const mod = new RpcV2Module(substrate);
        const root = await mod.privacy.getMerkleRoot();

        expect(root).toBe('0xroot');
        expect(substrate.request).toHaveBeenCalledWith('privacy_getMerkleRoot', []);
    });
});
