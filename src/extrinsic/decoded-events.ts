/**
 * Decoded pallet event data shapes — "explorer/read path".
 *
 * These interfaces represent the JSON-decoded form of on-chain events as
 * they are received via RPC or indexer.  They cover all pallets relevant
 * to the Orbinum explorer: shielded-pool, balances, system, ethereum, evm,
 * and account-mapping.
 *
 * Note: EventRecord itself is exported from @orbinum/sdk via substrate/types.
 */

// ── pallet-shielded-pool ───────────────────────────────────────────────────

export interface ShieldedEventData {
    sender: string;
    amount: string | null;
    commitment: string;
    memo: string;
    index: number;
}

export interface PrivateTransferEventData {
    nullifiers: string[];
    commitments: string[];
    memos: string[];
    indices: number[];
}

export interface UnshieldedEventData {
    nullifier: string;
    amount: string | null;
    recipient: string;
}

export interface MerkleRootUpdatedData {
    old_root: string;
    new_root: string;
    size: number;
}

export interface AuditPolicySetData {
    who: string;
    auditors: string[];
    version: number;
}

export interface DisclosureRequestedData {
    requestor: string;
    target: string;
    commitment: string;
    reason?: string;
}

export interface DisclosureApprovedData {
    who: string;
    commitment: string;
    auditor: string;
}

export interface DisclosureRejectedData {
    who: string;
    auditor: string;
    reason: string;
}

export interface DisclosureSubmittedData {
    who: string;
    commitment: string;
    proof_size: number;
    auditor: string;
}

export interface DisclosureVerifiedData {
    who: string;
    commitment: string;
    verified: boolean;
}

export interface AuditTrailRecordedData {
    account: string;
    auditor: string;
    commitment: string;
    trail_hash: string;
    trail_id: string;
}

// ── pallet-balances ────────────────────────────────────────────────────────

export interface TransferEventData {
    from: string;
    to: string;
    amount: string;
}

export interface EndowedEventData {
    account: string;
    free_balance: string;
}

export interface ReservedEventData {
    account: string;
    amount: string;
}

// ── pallet-account-mapping ─────────────────────────────────────────────────

export interface AliasRegisteredData {
    who: string;
    alias: string;
}

export interface AliasTransferredData {
    from: string;
    to: string;
    alias: string;
}

export interface AliasOnSaleData {
    alias: string;
    price: string;
}

export interface AliasSoldData {
    from: string;
    to: string;
    alias: string;
    price: string;
}

export interface AccountMappedData {
    account: string;
    address: string;
}

// ── pallet-evm / pallet-ethereum ───────────────────────────────────────────

/** EVM exit reason — either a named variant or a plain string. */
export type EvmExitReason = string | Record<string, unknown>;

export interface EvmExecutedData {
    from: string;
    to: string;
    tx_hash: string;
    exit_reason: EvmExitReason;
}

export interface EthereumExecutedData {
    from: string;
    to: string;
    tx_hash: string;
    exit_reason: EvmExitReason;
}

// ── pallet-system ──────────────────────────────────────────────────────────

export interface DispatchInfo {
    weight: Record<string, unknown>;
    class: string;
    pays_fee: string;
}

export interface DispatchError {
    module?: { index: number; error: number };
    [variant: string]: unknown;
}

export interface ExtrinsicSuccessData {
    dispatch_info: DispatchInfo;
}

export interface ExtrinsicFailedData {
    dispatch_error: DispatchError;
    dispatch_info: DispatchInfo;
}
