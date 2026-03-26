import type { SubstrateClient } from '../substrate/SubstrateClient';
import type { MerkleTreeInfo, MerkleProof } from '../types';

type RawMerkleTreeInfo = {
    root: string;
    tree_size: number;
    depth: number;
};

type RawMerkleProof = {
    root: string;
    leaf_index: number;
    siblings: string[];
};

/**
 * Queries the Orbinum shielded-pool Merkle tree via custom RPC methods.
 */
export class MerkleModule {
    constructor(private readonly substrate: SubstrateClient) {}

    /**
     * Returns the current Merkle tree state: root, number of leaves, and depth.
     */
    async getTreeInfo(): Promise<MerkleTreeInfo> {
        const raw = await this.substrate.request<RawMerkleTreeInfo>(
            'shieldedPool_getMerkleTreeInfo',
            []
        );
        return {
            root: raw.root,
            treeSize: raw.tree_size,
            depth: raw.depth,
        };
    }

    /**
     * Returns the Merkle inclusion proof for a leaf at `leafIndex`.
     */
    async getProof(leafIndex: number): Promise<MerkleProof> {
        const raw = await this.substrate.request<RawMerkleProof>('shieldedPool_getMerkleProof', [
            leafIndex,
        ]);
        return {
            root: raw.root,
            leafIndex: raw.leaf_index,
            siblings: raw.siblings,
        };
    }

    /**
     * Returns the Merkle inclusion proof for a given commitment (0x-prefixed hex).
     * Searches the tree for the commitment and returns its proof.
     */
    async getProofByCommitment(commitmentHex: string): Promise<MerkleProof> {
        const raw = await this.substrate.request<RawMerkleProof>('shieldedPool_getMerkleProof', [
            commitmentHex,
        ]);
        return {
            root: raw.root,
            leafIndex: raw.leaf_index,
            siblings: raw.siblings,
        };
    }

    /**
     * Returns the current Merkle root without fetching the full tree info.
     */
    async getRoot(): Promise<string> {
        const info = await this.getTreeInfo();
        return info.root;
    }

    /**
     * Returns an array of commitment leaves from index `from` to `to` (inclusive).
     * Defaults to returning all leaves.
     */
    async getLeaves(from = 0, to?: number): Promise<string[]> {
        return this.substrate.request<string[]>('shieldedPool_getMerkleLeaves', [from, to ?? null]);
    }
}
