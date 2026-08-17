/** EVM transaction request passed to an `EvmSigner` callback. */
export type EvmTxRequest = {
    to: string;
    data: string;
    value?: bigint;
    /**
     * Explicit gas price in wei. Omit to let the wallet pick, which prices the
     * transaction at the bare base fee — enough to be evicted as `GasPriceTooLow`
     * the moment the base fee rises, stranding every later nonce from the account.
     */
    gasPrice?: bigint;
};

/** Callback that signs and submits an EVM transaction, returning the tx hash. */
export type EvmSigner = (tx: EvmTxRequest) => Promise<string>;

/** Metadata for a known precompile: display name and function selector map. */
export interface KnownPrecompileInfo {
    /** Human-readable name, e.g. "ShieldedPool". */
    name: string;
    /** Map from 4-byte hex selector (no 0x prefix) to function signature. */
    functions: Record<string, string>;
}
