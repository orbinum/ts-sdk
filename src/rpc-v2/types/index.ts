export type RpcV2MerkleProof = {
    path: string[];
    leafIndex: number;
    treeDepth: number;
};

export type PrivacyMerkleProof = RpcV2MerkleProof & { root: string };

export type RpcV2NullifierStatus = {
    nullifier: string;
    isSpent: boolean;
};

export type RpcV2PoolAssetBalance = {
    assetId: number;
    balance: string;
};

export type RpcV2PoolStats = {
    merkleRoot: string;
    commitmentCount: number;
    nullifierCount: number;
    totalBalance: string;
    assetBalances: RpcV2PoolAssetBalance[];
    treeDepth: number;
};
