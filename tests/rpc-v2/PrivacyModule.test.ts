import { describe, expect, it, vi } from 'vitest';
import { PrivacyModule } from '../../src/rpc-v2/PrivacyModule';
import type { SubstrateClient } from '../../src/substrate/SubstrateClient';

function makeSubstrate(responses: Record<string, unknown>): SubstrateClient {
    return {
        request: vi.fn(async (method: string, _params: unknown[]) => {
            if (method in responses) return responses[method];
            throw new Error(`Unexpected RPC method: ${method}`);
        }),
    } as unknown as SubstrateClient;
}

describe('PrivacyModule.getMerkleRoot', () => {
    it('calls the rpc-v2 merkle root endpoint', async () => {
        const substrate = makeSubstrate({ privacy_getMerkleRoot: '0xroot' });
        const root = await new PrivacyModule(substrate).getMerkleRoot();
        expect(root).toBe('0xroot');
        expect(substrate.request).toHaveBeenCalledWith('privacy_getMerkleRoot', []);
    });
});

describe('PrivacyModule.getMerkleProof', () => {
    it('maps snake_case response to camelCase shape', async () => {
        const substrate = makeSubstrate({
            privacy_getMerkleProof: {
                path: ['0xa', '0xb'],
                leaf_index: 7,
                tree_depth: 32,
            },
        });
        const proof = await new PrivacyModule(substrate).getMerkleProof(7);
        expect(proof).toEqual({
            path: ['0xa', '0xb'],
            leafIndex: 7,
            treeDepth: 32,
        });
        expect(substrate.request).toHaveBeenCalledWith('privacy_getMerkleProof', [7]);
    });

    it('acepta commitment hex como parámetro', async () => {
        const substrate = makeSubstrate({
            privacy_getMerkleProof: { path: ['0xc'], leaf_index: 5, tree_depth: 32 },
        });
        await new PrivacyModule(substrate).getMerkleProof('0xabc123');
        expect(substrate.request).toHaveBeenCalledWith('privacy_getMerkleProof', ['0xabc123']);
    });
});

describe('PrivacyModule.getNullifierStatus', () => {
    it('maps snake_case response to camelCase shape', async () => {
        const substrate = makeSubstrate({
            privacy_getNullifierStatus: {
                nullifier: '0xdead',
                is_spent: true,
            },
        });
        const status = await new PrivacyModule(substrate).getNullifierStatus('0xdead');
        expect(status).toEqual({
            nullifier: '0xdead',
            isSpent: true,
        });
        expect(substrate.request).toHaveBeenCalledWith('privacy_getNullifierStatus', ['0xdead']);
    });
});

describe('PrivacyModule.getPoolStats', () => {
    it('preserves u128 values as decimal strings and maps balances', async () => {
        const substrate = makeSubstrate({
            privacy_getPoolStats: {
                merkle_root: '0xroot',
                commitment_count: 12,
                nullifier_count: 7,
                total_balance: '1000000000000000000',
                asset_balances: [
                    { asset_id: 0, balance: '900000000000000000' },
                    { asset_id: 1, balance: 1000 },
                ],
                tree_depth: 20,
            },
        });
        const stats = await new PrivacyModule(substrate).getPoolStats();
        expect(stats).toEqual({
            merkleRoot: '0xroot',
            commitmentCount: 12,
            nullifierCount: 7,
            totalBalance: '1000000000000000000',
            assetBalances: [
                { assetId: 0, balance: '900000000000000000' },
                { assetId: 1, balance: '1000' },
            ],
            treeDepth: 20,
        });
        expect(substrate.request).toHaveBeenCalledWith('privacy_getPoolStats', []);
    });

    it('exposes nullifierCount for active-notes estimation', async () => {
        const substrate = makeSubstrate({
            privacy_getPoolStats: {
                merkle_root: '0xroot',
                commitment_count: 20,
                nullifier_count: 8,
                total_balance: 0,
                asset_balances: [],
                tree_depth: 20,
            },
        });
        const stats = await new PrivacyModule(substrate).getPoolStats();
        expect(stats.nullifierCount).toBe(8);
        expect(stats.commitmentCount - stats.nullifierCount).toBe(12); // estimated active notes
    });
});

describe('PrivacyModule.getMerkleProofByCommitment', () => {
    it('usa privacy_getMerkleProofByCommitment para garantizar root y path atómicos', async () => {
        const substrate = makeSubstrate({
            privacy_getMerkleProofByCommitment: { root: '0xcurrentroot', path: ['0xaa', '0xbb'], leaf_index: 3, tree_depth: 20 },
        });
        const proof = await new PrivacyModule(substrate).getMerkleProofByCommitment('0xdeadbeef');
        expect(proof).toEqual({
            path: ['0xaa', '0xbb'],
            leafIndex: 3,
            treeDepth: 20,
            root: '0xcurrentroot',
        });
        expect(substrate.request).toHaveBeenCalledWith('privacy_getMerkleProofByCommitment', ['0xdeadbeef']);
        expect(substrate.request).not.toHaveBeenCalledWith('privacy_getMerkleRoot', []);
    });

    it('incluye root en el resultado tomado del mismo endpoint atómico', async () => {
        const substrate = makeSubstrate({
            privacy_getMerkleProofByCommitment: { root: '0xabcdef', path: [], leaf_index: 0, tree_depth: 20 },
        });
        const proof = await new PrivacyModule(substrate).getMerkleProofByCommitment('0x01');
        expect(proof.root).toBe('0xabcdef');
    });
});