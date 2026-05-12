export type RawRpcV2MerkleProof = {
    root: string;
    path: string[];
    leaf_index: number;
    tree_depth: number;
};

export type RawRpcV2NullifierStatus = {
    nullifier: string;
    is_spent: boolean;
};

export type RawRpcV2PoolAssetBalance = {
    asset_id: number;
    balance: string | number;
};

export type RawRpcV2PoolStats = {
    merkle_root: string;
    commitment_count: number;
    nullifier_count: number;
    total_balance: string | number;
    asset_balances: RawRpcV2PoolAssetBalance[];
    tree_depth: number;
};
