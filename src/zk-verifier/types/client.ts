/** Public (camelCase) types for `zkVerifier_*` RPC responses. */

export type ZkVerifierVkHash = {
    version: number;
    vkHash: string;
    /** On-chain verification statistics for this version (if available). */
    stats?: ZkVerifierVersionStats;
};

/** Proof verification counts for a specific circuit version. */
export type ZkVerifierVersionStats = {
    /** Total proof verification attempts. */
    total: number;
    /** Successful verifications. */
    successful: number;
    /** Failed verifications. */
    failed: number;
};

/**
 * A version whose VK was removed from storage but whose stats record survived.
 * The key data is gone; only the usage record remains.
 */
export type ZkVerifierHistoricalVersion = {
    version: number;
    stats: ZkVerifierVersionStats;
};

export type ZkVerifierCircuitVersionInfo = {
    circuitId: number;
    activeVersion: number;
    /** Proof system (e.g. 'Groth16'). */
    proofSystem: string;
    supportedVersions: number[];
    vkHashes: ZkVerifierVkHash[];
    /** Versions removed from storage that still have stats records. */
    historicalVersions: ZkVerifierHistoricalVersion[];
};
