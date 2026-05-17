/**
 * Decoded extrinsic arg shapes — "explorer/read path".
 *
 * These interfaces mirror on-chain arg shapes as they appear after JSON
 * decoding (snake_case keys, string amounts).  They are intentionally
 * different from the call-builder types in shielded-pool/types/pallet-extrinsics.ts
 * which use camelCase and bigint/Bytes32 for SCALE construction.
 */

// ── pallet-shielded-pool ───────────────────────────────────────────────────

export interface DecodedShieldArgs {
    asset_id: number | string;
    amount: string;
    commitment: string;
    encrypted_memo: string;
}

export interface DecodedShieldBatchOperation {
    asset_id: number | string;
    amount: string;
    commitment: string;
    encrypted_memo: string;
}

export interface DecodedShieldBatchArgs {
    operations: DecodedShieldBatchOperation[];
}

export interface DecodedPrivateTransferArgs {
    proof: string;
    merkle_root: string;
    nullifiers: string[];
    commitments: string[];
    encrypted_memos: string[];
}

export interface DecodedUnshieldArgs {
    proof: string;
    merkle_root: string;
    nullifier: string;
    asset_id: number | string;
    amount: string;
    recipient: string;
}

// ── pallet-balances ────────────────────────────────────────────────────────

export interface DecodedTransferArgs {
    dest: string;
    value: string;
}

export type DecodedTransferKeepAliveArgs = DecodedTransferArgs;

export interface DecodedTransferAllArgs {
    dest: string;
    keep_alive: boolean;
}

// ── pallet-utility ─────────────────────────────────────────────────────────

export interface DecodedBatchArgs {
    calls: unknown[];
}

// ── pallet-sudo ────────────────────────────────────────────────────────────

export interface DecodedSudoArgs {
    call: unknown;
}

// ── pallet-system ──────────────────────────────────────────────────────────

export interface DecodedRemarkArgs {
    remark: string;
}

// ── pallet-account-mapping ─────────────────────────────────────────────────

export interface DecodedRegisterAliasArgs {
    alias: string;
}

export interface DecodedPutAliasForSaleArgs {
    asking_price: string;
    sale_type: string;
    whitelist_count?: number;
}

export interface DecodedSetAccountMetadataArgs {
    display_name: string;
    bio: string;
    avatar: string;
}

export interface DecodedAddChainLinkArgs {
    chain_id: number | string;
    target_address: string;
    signature: string;
}

export interface DecodedRevealPrivateLinkArgs {
    commitment: string;
    address: string;
    blinding: string;
    signature: string;
}

export interface DecodedDispatchAsPrivateLinkArgs {
    owner: string;
    commitment: string;
    zk_proof: string;
    inner_call: string;
}

// ── pallet-evm / pallet-ethereum ───────────────────────────────────────────

export interface DecodedEthereumTransactArgs {
    tx_type: string;
    chain_id?: number;
    nonce?: number;
    gas_limit?: number;
    to: string;
    value?: string;
    input: string;
}

export interface DecodedEvmCallArgs {
    source: string;
    target: string;
    input: string;
    value: string;
    gas_limit: number;
}
