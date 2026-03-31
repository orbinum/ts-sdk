export type RpcV2MerkleProof = {
    path: string[];
    leafIndex: number;
    treeDepth: number;
};

/** Prueba Merkle enriquecida con el `root` actual del árbol. Devuelta por `getMerkleProofByCommitment`. */
export type PrivacyMerkleProof = RpcV2MerkleProof & { root: string };

export type RpcV2NullifierStatus = {
    nullifier: string;
    isSpent: boolean;
};

export type RpcV2PoolAssetBalance = {
    assetId: number;
    /** Balance serializado como string decimal para preservar `u128`. */
    balance: string;
};

export type RpcV2PoolStats = {
    merkleRoot: string;
    commitmentCount: number;
    /** Total pool balance serializado como string decimal para preservar `u128`. */
    totalBalance: string;
    assetBalances: RpcV2PoolAssetBalance[];
    treeDepth: number;
};
