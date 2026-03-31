/** EVM transaction request passed to an `EvmSigner` callback. */
export type EvmTxRequest = {
    to: string;
    data: string;
    value?: bigint;
};

/** Callback that signs and submits an EVM transaction, returning the tx hash. */
export type EvmSigner = (tx: EvmTxRequest) => Promise<string>;

export type ResolvedAlias = {
    /** AccountId32 hex of the alias owner (as 0x-prefixed 20-byte EVM address). */
    owner: string;
    /** EVM address of the owner, or null if unset. */
    evmAddress: string | null;
};

/** Metadata for a known precompile: display name and function selector map. */
export interface KnownPrecompileInfo {
    /** Human-readable name, e.g. "ShieldedPool". */
    name: string;
    /** Map from 4-byte hex selector (no 0x prefix) to function signature. */
    functions: Record<string, string>;
}
