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

// ─── Disclosure types ──────────────────────────────────────────────────────────

/**
 * Parameters for `requestDisclosure`.
 *
 * The EVM caller of this transaction is treated as the **auditor** on-chain.
 */
export type RequestDisclosureParams = {
    /** AccountId32 of the note owner (target), as a 0x-prefixed 64-hex-char string. */
    target: string;
    /** Note commitment, as a 0x-prefixed 64-hex-char string. */
    commitment: string;
    /** Whether to request disclosure of the note value. */
    disclosedValue: boolean;
    /** Whether to request disclosure of the asset ID. */
    disclosedAssetId: boolean;
    /** Whether to request disclosure of the note owner hash. */
    disclosedOwner: boolean;
    /** Human-readable reason (UTF-8, max 256 bytes). */
    reason: string;
    /** Auditor's Baby Jubjub public key X coordinate (32 bytes). */
    auditorBjjPkX: Uint8Array;
    /** Auditor's Baby Jubjub public key Y coordinate (32 bytes). */
    auditorBjjPkY: Uint8Array;
};

/**
 * Parameters for `disclose`.
 *
 * The EVM caller of this transaction is treated as the **note owner** on-chain.
 */
export type DiscloseParams = {
    /** Note commitment, as a 0x-prefixed 64-hex-char string. */
    commitment: string;
    /** 128-byte serialised Groth16 proof. */
    proofBytes: Uint8Array;
    /** 256-byte ECDH-encrypted disclosure signals from the circuit. */
    publicSignals: Uint8Array;
    /** AccountId32 of the auditor, as a 0x-prefixed 64-hex-char string. */
    auditor: string;
};

/**
 * Parameters for `rejectDisclosure`.
 *
 * The EVM caller of this transaction is treated as the **target** (note owner) on-chain.
 */
export type RejectDisclosureParams = {
    /** AccountId32 of the auditor who sent the request, as a 0x-prefixed 64-hex-char string. */
    auditor: string;
    /** Note commitment, as a 0x-prefixed 64-hex-char string. */
    commitment: string;
    /** Human-readable rejection reason (UTF-8, max 256 bytes). */
    reason: string;
};

/**
 * Parameters for `pruneExpiredRequest`.
 *
 * Permissionless: any EVM caller can prune an expired disclosure request.
 */
export type PruneExpiredRequestParams = {
    /** AccountId32 of the note owner, as a 0x-prefixed 64-hex-char string. */
    target: string;
    /** AccountId32 of the auditor, as a 0x-prefixed 64-hex-char string. */
    auditor: string;
    /** Note commitment, as a 0x-prefixed 64-hex-char string. */
    commitment: string;
};
