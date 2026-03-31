/**
 * Signature verification scheme for cross-chain links.
 * Mirrors `SignatureScheme` in pallet-account-mapping.
 */
export const SignatureScheme = {
    Eip191: 'Eip191',
    Ed25519: 'Ed25519',
} as const;
export type SignatureScheme = (typeof SignatureScheme)[keyof typeof SignatureScheme];

/** A verified public link to an external chain wallet. */
export type ChainLink = {
    chainId: number;
    address: string;
};

/** A private link: only the Poseidon commitment is stored on-chain. */
export type PrivateLink = {
    chainId: number;
    commitment: string;
};

/** Public profile metadata set by the account owner. */
export type AccountMetadata = {
    displayName: string | null;
    bio: string | null;
    avatar: string | null;
};

/** Identity info by alias: owner, optional EVM address, link count. */
export type AliasInfo = {
    /** 0x-prefixed 32-byte AccountId32 hex. */
    owner: string;
    /** Normalized EVM address (0x + 40 hex chars), or null. */
    evmAddress: string | null;
    chainLinksCount: number;
};

/**
 * Full identity for an alias: owner, EVM address, all public chain links, metadata.
 * Returned by `accountMapping_getFullIdentity` (alias-based lookup).
 */
export type AliasFullIdentity = {
    owner: string;
    evmAddress: string | null;
    chainLinks: ChainLink[];
    metadata: AccountMetadata | null;
};

/** Sale listing info for an alias on the marketplace. */
export type ListingInfo = {
    price: bigint;
    /** True if sale is private (whitelist-only). */
    private: boolean;
    whitelistCount: number;
};

/** An alias actively listed for sale with its full info. */
export type AccountListing = {
    alias: string;
    listing: ListingInfo;
};

/** A supported chain and its signature verification scheme. */
export type SupportedChain = {
    chainId: number;
    scheme: SignatureScheme;
};

/** Parameters for adding a verified public chain link. */
export type AddChainLinkParams = {
    /** External chain ID. Use SLIP0044_NAMESPACE | coinType for SLIP-0044 chains. */
    chainId: number;
    /** The external address bytes (e.g. 20 bytes for EVM, 32 for Solana). */
    address: Uint8Array;
    /** Signature over the caller's AccountId32 (64 bytes for Ed25519, 65 for EIP-191). */
    signature: Uint8Array;
};

/** Parameters for updating public profile metadata. */
export type SetMetadataParams = {
    displayName?: string | null;
    bio?: string | null;
    avatar?: string | null;
};

/** Parameters for listing an alias on the marketplace. */
export type PutOnSaleParams = {
    price: bigint;
    /** If true the sale becomes OTC (whitelist required). */
    isPrivate: boolean;
};

/** Parameters for dispatching a call authenticated by a linked external account. */
export type DispatchAsLinkedParams = {
    /** Owner AccountId32 hex (0x-prefixed 64 chars). */
    owner: string;
    chainId: number;
    address: Uint8Array;
    /** Signature over the encoded call payload. */
    signature: Uint8Array;
    /** Encoded call bytes (SCALE). */
    callData: Uint8Array;
};

/**
 * Bitmask to convert a SLIP-0044 coin type into an Orbinum ChainId.
 * Example: `SLIP0044_NAMESPACE | 501` = Solana.
 */
export const SLIP0044_NAMESPACE = 0x8000_0000;
