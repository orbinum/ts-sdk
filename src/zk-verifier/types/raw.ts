/** Raw (snake_case) RPC response shapes from `zkVerifier_*` endpoints. Internal use only. */

export type RawZkVerifierVkHash = {
    version: number;
    vk_hash: string;
};

export type RawZkVerifierCircuitVersionInfo = {
    circuit_id: number;
    active_version: number;
    supported_versions: number[];
    vk_hashes: RawZkVerifierVkHash[];
};
