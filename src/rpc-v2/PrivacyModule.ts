import type { SubstrateClient } from '../substrate/SubstrateClient';
import type { RawRpcV2MerkleProof, RawRpcV2NullifierStatus, RawRpcV2PoolStats } from './types/raw';
import type {
    RpcV2NullifierStatus,
    RpcV2PoolStats,
    RpcV2MerkleProof,
    PrivacyMerkleProof,
} from './types';
import { mapAssetBalance } from './helpers';

/**
 * Typed client for the Orbinum `rpc-v2` endpoints under the `privacy_*` namespace.
 */
export class PrivacyModule {
    constructor(private readonly substrate: SubstrateClient) {}

    /** Returns the current Merkle tree root. */
    async getMerkleRoot(): Promise<string> {
        return this.substrate.request<string>('privacy_getMerkleRoot', []);
    }

    /** Returns the Merkle proof for the given leaf index or commitment hex. */
    async getMerkleProof(leafIndex: number | string): Promise<RpcV2MerkleProof> {
        const raw = await this.substrate.request<RawRpcV2MerkleProof>('privacy_getMerkleProof', [
            leafIndex,
        ]);
        return {
            path: raw.path,
            leafIndex: raw.leaf_index,
            treeDepth: raw.tree_depth,
        };
    }

    /**
     * Returns the Merkle inclusion proof for a given commitment hex,
     * bundled with the current Merkle root.
     */
    async getMerkleProofByCommitment(commitmentHex: string): Promise<PrivacyMerkleProof> {
        const [proof, root] = await Promise.all([
            this.getMerkleProof(commitmentHex),
            this.getMerkleRoot(),
        ]);
        return { ...proof, root };
    }

    /** Returns the spend status of a nullifier. */
    async getNullifierStatus(nullifier: string): Promise<RpcV2NullifierStatus> {
        const raw = await this.substrate.request<RawRpcV2NullifierStatus>(
            'privacy_getNullifierStatus',
            [nullifier]
        );
        return {
            nullifier: raw.nullifier,
            isSpent: raw.is_spent,
        };
    }

    /** Returns aggregated statistics for the shielded pool from `rpc-v2`. */
    async getPoolStats(): Promise<RpcV2PoolStats> {
        const raw = await this.substrate.request<RawRpcV2PoolStats>('privacy_getPoolStats', []);
        return {
            merkleRoot: raw.merkle_root,
            commitmentCount: raw.commitment_count,
            totalBalance: raw.total_balance.toString(),
            assetBalances: raw.asset_balances.map(mapAssetBalance),
            treeDepth: raw.tree_depth,
        };
    }
}
