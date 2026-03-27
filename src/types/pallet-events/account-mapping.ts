/**
 * TypeScript types for events emitted by pallet-account-mapping.
 *
 * Conventions:
 *   - AccountId     → `string`  (SS58)
 *   - H160          → `string`  (0x-prefixed 20-byte Ethereum address)
 *   - AliasOf<T>    → `string`  (bounded string, max configurable)
 *   - ChainId       → `number`  (SLIP-0044 coin-type u32)
 *   - ExternalAddr  → `string`  (chain-specific address string)
 *   - BalanceOf<T>  → `bigint`
 *   - [u8; 32]      → `string`  (0x-prefixed hex, for private commitments)
 *   - SignatureScheme → imported from pallet-extrinsics
 */

import type { SignatureScheme } from '../pallet-extrinsics';

// ─── Account mapping (EVM ↔ Substrate) ───────────────────────────────────────

/**
 * Emitted when a Substrate account is mapped to an Ethereum address.
 * Rust variant: `AccountMapped { account, address }`
 */
export type AccountMappedEvent = {
    account: string;
    /** 0x-prefixed 20-byte Ethereum address. */
    address: string;
};

/**
 * Emitted when an existing account mapping is removed.
 * Rust variant: `AccountUnmapped { account, address }`
 */
export type AccountUnmappedEvent = {
    account: string;
    /** 0x-prefixed 20-byte Ethereum address. */
    address: string;
};

// ─── Alias lifecycle ──────────────────────────────────────────────────────────

/**
 * Emitted by `register_alias()` when a new alias is claimed.
 * Rust variant: `AliasRegistered { account, alias, evm_address }`
 */
export type AliasRegisteredEvent = {
    account: string;
    alias: string;
    /** Optional EVM address linked at registration time. */
    evmAddress: string | null;
};

/**
 * Emitted when an alias is released (burned / expired).
 * Rust variant: `AliasReleased { account, alias }`
 */
export type AliasReleasedEvent = {
    account: string;
    alias: string;
};

/**
 * Emitted by `transfer_alias()` when ownership changes hands.
 * Rust variant: `AliasTransferred { from, to, alias }`
 */
export type AliasTransferredEvent = {
    from: string;
    to: string;
    alias: string;
};

/**
 * Emitted by `put_alias_on_sale()` when an alias is listed on the marketplace.
 * Rust variant: `AliasListedForSale { seller, alias, price, private }`
 */
export type AliasListedForSaleEvent = {
    seller: string;
    alias: string;
    price: bigint;
    /** Whether the listing is private (whitelist-only). */
    private: boolean;
};

/**
 * Emitted when an alias listing is cancelled before a sale.
 * Rust variant: `AliasSaleCancelled { seller, alias }`
 */
export type AliasSaleCancelledEvent = {
    seller: string;
    alias: string;
};

/**
 * Emitted by `buy_alias()` when an alias is purchased.
 * Rust variant: `AliasSold { seller, buyer, alias, price }`
 */
export type AliasSoldEvent = {
    seller: string;
    buyer: string;
    alias: string;
    price: bigint;
};

// ─── Chain links ──────────────────────────────────────────────────────────────

/**
 * Emitted by `add_chain_link()` when an external address is linked.
 * Rust variant: `ChainLinkAdded { account, chain_id, address }`
 */
export type ChainLinkAddedEvent = {
    account: string;
    /** SLIP-0044 coin-type identifying the external chain. */
    chainId: number;
    /** Chain-specific address string. */
    address: string;
};

/**
 * Emitted by `remove_chain_link()` when an external address link is removed.
 * Rust variant: `ChainLinkRemoved { account, chain_id }`
 */
export type ChainLinkRemovedEvent = {
    account: string;
    chainId: number;
};

// ─── Metadata ─────────────────────────────────────────────────────────────────

/**
 * Emitted by `set_account_metadata()` when an account's metadata is updated.
 * Rust variant: `MetadataUpdated { account }`
 */
export type MetadataUpdatedEvent = {
    account: string;
};

// ─── Supported chains governance ──────────────────────────────────────────────

/**
 * Emitted by `add_supported_chain()` (governance) when a new chain type is whitelisted.
 * Rust variant: `SupportedChainAdded { chain_id, scheme }`
 */
export type SupportedChainAddedEvent = {
    chainId: number;
    scheme: SignatureScheme;
};

/**
 * Emitted by `remove_supported_chain()` (governance) when a chain type is removed.
 * Rust variant: `SupportedChainRemoved { chain_id }`
 */
export type SupportedChainRemovedEvent = {
    chainId: number;
};

// ─── Proxy / dispatch ─────────────────────────────────────────────────────────

/**
 * Emitted after a successful `dispatch_as_linked_account()` call.
 * Rust variant: `ProxyCallExecuted { owner, chain_id, address }`
 */
export type ProxyCallExecutedEvent = {
    owner: string;
    chainId: number;
    address: string;
};

// ─── Private chain links ──────────────────────────────────────────────────────

/**
 * Emitted by `register_private_link()` when a private (commitment-based) chain link is added.
 * Rust variant: `PrivateChainLinkAdded { account, chain_id, commitment }`
 */
export type PrivateChainLinkAddedEvent = {
    account: string;
    chainId: number;
    /** 0x-prefixed 32-byte Poseidon commitment of the private link. */
    commitment: string;
};

/**
 * Emitted by `remove_private_link()` when a private chain link is removed.
 * Rust variant: `PrivateChainLinkRemoved { account, chain_id, commitment }`
 */
export type PrivateChainLinkRemovedEvent = {
    account: string;
    chainId: number;
    /** 0x-prefixed 32-byte commitment. */
    commitment: string;
};

/**
 * Emitted by `reveal_private_link()` when a private link is publicly revealed.
 * Rust variant: `PrivateChainLinkRevealed { account, chain_id, address }`
 */
export type PrivateChainLinkRevealedEvent = {
    account: string;
    chainId: number;
    /** The now-revealed external address. */
    address: string;
};

/**
 * Emitted after a successful `dispatch_as_private_link()` call.
 * Rust variant: `PrivateLinkDispatchExecuted { owner, commitment }`
 */
export type PrivateLinkDispatchExecutedEvent = {
    owner: string;
    /** 0x-prefixed 32-byte commitment of the private link used. */
    commitment: string;
};

// ─── Discriminated union ──────────────────────────────────────────────────────

/** All events emitted by pallet-account-mapping as a discriminated union. */
export type AccountMappingEvent =
    | { type: 'AccountMapped'; data: AccountMappedEvent }
    | { type: 'AccountUnmapped'; data: AccountUnmappedEvent }
    | { type: 'AliasRegistered'; data: AliasRegisteredEvent }
    | { type: 'AliasReleased'; data: AliasReleasedEvent }
    | { type: 'AliasTransferred'; data: AliasTransferredEvent }
    | { type: 'AliasListedForSale'; data: AliasListedForSaleEvent }
    | { type: 'AliasSaleCancelled'; data: AliasSaleCancelledEvent }
    | { type: 'AliasSold'; data: AliasSoldEvent }
    | { type: 'ChainLinkAdded'; data: ChainLinkAddedEvent }
    | { type: 'ChainLinkRemoved'; data: ChainLinkRemovedEvent }
    | { type: 'MetadataUpdated'; data: MetadataUpdatedEvent }
    | { type: 'SupportedChainAdded'; data: SupportedChainAddedEvent }
    | { type: 'SupportedChainRemoved'; data: SupportedChainRemovedEvent }
    | { type: 'ProxyCallExecuted'; data: ProxyCallExecutedEvent }
    | { type: 'PrivateChainLinkAdded'; data: PrivateChainLinkAddedEvent }
    | { type: 'PrivateChainLinkRemoved'; data: PrivateChainLinkRemovedEvent }
    | { type: 'PrivateChainLinkRevealed'; data: PrivateChainLinkRevealedEvent }
    | { type: 'PrivateLinkDispatchExecuted'; data: PrivateLinkDispatchExecutedEvent };
