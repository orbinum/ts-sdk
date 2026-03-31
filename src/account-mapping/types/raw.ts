export type RawAccountAddresses = {
    mapped: string | null;
    fallback: string | null;
};

export type RawAliasResponse = {
    alias: string;
    substrate_account: string;
    evm_address: string | null;
    chain_links_count: number;
};

export type RawListingResponse = {
    alias: string;
    price: string;
    private: boolean;
    whitelist_count: number;
};

export type RawChainLinkResponse = {
    chain_id: number;
    address: string;
};

export type RawAccountMetadataResponse = {
    display_name: string | null;
    bio: string | null;
    avatar: string | null;
};

export type RawFullIdentityResponse = {
    owner: string;
    evm_address: string | null;
    chain_links: RawChainLinkResponse[];
    metadata: RawAccountMetadataResponse | null;
};

export type RawPrivateLinkResponse = {
    chain_id: number;
    commitment: string;
};
