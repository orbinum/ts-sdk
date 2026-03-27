/**
 * TypeScript types for pallet-account-mapping extrinsics.
 *
 * Conventions:
 *   - Byte arrays  → `number[]`  (SCALE-compatible)
 *   - Balances     → `bigint`
 *   - AccountId    → `string`    (SS58 or 0x-prefixed 64-char hex)
 *   - ChainId      → `number`    (u32, typically a SLIP-0044 coin type)
 *   - Optional     → `T | null`
 */

// ─── Supporting types ─────────────────────────────────────────────────────────

/**
 * External chain signature scheme.
 * Maps to `SignatureScheme` enum in pallet-account-mapping.
 *
 * - `Eip191`  — Ethereum personal_sign (EIP-191 prefix)
 * - `Ed25519` — Raw Ed25519 signature (Solana, Polkadot, etc.)
 */
export type SignatureScheme = 'Eip191' | 'Ed25519';

// ─── Extrinsic argument types ─────────────────────────────────────────────────

// Call index 0 — `map_account` (Signed origin, EVM signer): no arguments.
// Call index 1 — `unmap_account` (Signed origin): no arguments.
// Call index 3 — `release_alias` (Signed origin): no arguments.
// Call index 6 — `cancel_sale` (Signed origin): no arguments.

/**
 * Call index 2 — `register_alias` (Signed origin)
 * Registers a human-readable identity alias for the caller's Substrate account.
 * Valid characters: alphanumeric, underscore, hyphen.
 * Length bounded by `T::MaxAliasLength` on-chain (configurable; typically ≤ 32 bytes).
 */
export type RegisterAliasArgs = {
    alias: string;
};

/**
 * Call index 4 — `transfer_alias` (Signed origin)
 * Transfers the caller's alias to another account.
 * The current owner loses the alias; the new owner must not already hold one.
 */
export type TransferAliasArgs = {
    /** AccountId of the new owner. */
    newOwner: string;
};

/**
 * Call index 5 — `put_alias_on_sale` (Signed origin)
 * Lists the caller's alias for purchase at a given planck price.
 */
export type PutAliasOnSaleArgs = {
    /** Sale price in planck (native token smallest unit). Cannot be zero. */
    price: bigint;
    /**
     * Optional whitelist of AccountIds allowed to buy.
     * Null = unrestricted public sale.
     * Max {@link MAX_WHITELIST_SIZE} entries.
     */
    allowedBuyers: string[] | null;
};

/**
 * Call index 7 — `buy_alias` (Signed origin)
 * Purchases an alias currently listed for sale.
 * The buyer must not already hold an alias.
 */
export type BuyAliasArgs = {
    /** The alias to purchase. */
    alias: string;
};

/**
 * Call index 8 — `add_chain_link` (Signed origin)
 * Links an external-chain address to the caller's Orbinum identity.
 * The `signature` must be produced over a deterministic challenge message
 * using the private key corresponding to `address` on the given chain.
 */
export type AddChainLinkArgs = {
    /** u32 chain identifier (must be in the supported chains registry). */
    chainId: number;
    /** Raw external address bytes — 20 bytes for EVM, 32 bytes for Ed25519 chains. */
    address: number[];
    /** Ownership proof signature bytes. */
    signature: number[];
};

/**
 * Call index 9 — `remove_chain_link` (Signed origin)
 * Removes a previously verified external chain link from the caller's identity.
 */
export type RemoveChainLinkArgs = {
    /** u32 chain identifier of the link to remove. */
    chainId: number;
};

/**
 * Call index 10 — `set_account_metadata` (Signed origin)
 * Sets or updates the caller's public profile metadata.
 * Fields set to null are cleared from storage.
 */
export type SetAccountMetadataArgs = {
    /** Display name — max 64 bytes UTF-8. Null removes the field. */
    displayName: string | null;
    /** Short biography — max 512 bytes UTF-8. Null removes the field. */
    bio: string | null;
    /** Avatar URL or IPFS CID — max 256 bytes. Null removes the field. */
    avatar: string | null;
};

/**
 * Call index 11 — `add_supported_chain` (Root origin)
 * Registers a new external chain in the supported chains registry.
 */
export type AddSupportedChainArgs = {
    /** u32 chain identifier (e.g. SLIP-0044 coin type). */
    chainId: number;
    /** Signature scheme used for address-ownership proofs on this chain. */
    scheme: SignatureScheme;
};

/**
 * Call index 12 — `remove_supported_chain` (Root origin)
 * Removes a chain from the supported chains registry.
 * Existing links for that chain are unaffected.
 */
export type RemoveSupportedChainArgs = {
    /** u32 chain identifier to remove. */
    chainId: number;
};

/**
 * Call index 13 — `dispatch_as_linked_account` (Signed origin, relayer)
 * Dispatches a RuntimeCall on behalf of an account that owns a verified chain link.
 * The relayer pays fees; authorisation comes from the external chain signature.
 */
export type DispatchAsLinkedAccountArgs = {
    /** AccountId on whose behalf to dispatch. */
    owner: string;
    /** u32 chain identifier of the link used for authorisation. */
    chainId: number;
    /** Raw external address bytes of the authorising signer. */
    address: number[];
    /** Signature over the SCALE-encoded `call` payload. */
    signature: number[];
    /** SCALE-encoded RuntimeCall to dispatch. */
    call: number[];
};

/**
 * Call index 14 — `register_private_link` (Signed origin)
 * Registers a hidden chain link using a Poseidon commitment: H(address, blinding).
 * The actual external address is not revealed on-chain.
 */
export type RegisterPrivateLinkArgs = {
    /** u32 chain identifier. */
    chainId: number;
    /** 32-byte Poseidon commitment: H(address || blinding) (LE). */
    commitment: number[];
};

/**
 * Call index 15 — `remove_private_link` (Signed origin)
 * Removes a private chain link identified by its commitment.
 */
export type RemovePrivateLinkArgs = {
    /** 32-byte commitment identifying the link to remove (LE). */
    commitment: number[];
};

/**
 * Call index 16 — `reveal_private_link` (Signed origin)
 * Reveals a previously registered private link by providing the commitment preimage.
 * After this call the link becomes publicly readable in storage.
 */
export type RevealPrivateLinkArgs = {
    /** 32-byte commitment: H(address || blinding) (LE). */
    commitment: number[];
    /** The actual raw external address bytes being revealed. */
    address: number[];
    /** 32-byte blinding factor used when creating the commitment (LE). */
    blinding: number[];
    /** Ownership proof signature produced with the external-chain key. */
    signature: number[];
};

/**
 * Call index 17 — `dispatch_as_private_link` (Signed origin, relayer)
 * Dispatches a RuntimeCall on behalf of an account identified only by a private
 * link commitment. A Groth16 ZK proof (PRIVATE_LINK circuit) authorises the
 * dispatch without revealing the external address.
 */
export type DispatchAsPrivateLinkArgs = {
    /** AccountId on whose behalf to dispatch. */
    owner: string;
    /** 32-byte commitment identifying the private link (LE). */
    commitment: number[];
    /** Groth16 proof bytes (PRIVATE_LINK circuit). */
    zkProof: number[];
    /** SCALE-encoded RuntimeCall to dispatch. */
    call: number[];
};

// ─── Discriminated call union ─────────────────────────────────────────────────

/** All pallet-account-mapping calls as a discriminated union. */
export type AccountMappingCall =
    | { type: 'mapAccount' }
    | { type: 'unmapAccount' }
    | { type: 'registerAlias'; args: RegisterAliasArgs }
    | { type: 'releaseAlias' }
    | { type: 'transferAlias'; args: TransferAliasArgs }
    | { type: 'putAliasOnSale'; args: PutAliasOnSaleArgs }
    | { type: 'cancelSale' }
    | { type: 'buyAlias'; args: BuyAliasArgs }
    | { type: 'addChainLink'; args: AddChainLinkArgs }
    | { type: 'removeChainLink'; args: RemoveChainLinkArgs }
    | { type: 'setAccountMetadata'; args: SetAccountMetadataArgs }
    | { type: 'addSupportedChain'; args: AddSupportedChainArgs }
    | { type: 'removeSupportedChain'; args: RemoveSupportedChainArgs }
    | { type: 'dispatchAsLinkedAccount'; args: DispatchAsLinkedAccountArgs }
    | { type: 'registerPrivateLink'; args: RegisterPrivateLinkArgs }
    | { type: 'removePrivateLink'; args: RemovePrivateLinkArgs }
    | { type: 'revealPrivateLink'; args: RevealPrivateLinkArgs }
    | { type: 'dispatchAsPrivateLink'; args: DispatchAsPrivateLinkArgs };
