import { Binary, type PolkadotSigner } from 'polkadot-api';
import type { SubstrateClient } from '../substrate/SubstrateClient';
import type { TxResult } from '../client/types';
import { normalizeEvmAddress } from '../utils/address';
import { callUnsafeTx, resolveTx, toTxResult } from '../utils/tx';
import type {
    RawAccountAddresses,
    RawAliasResponse,
    RawListingResponse,
    RawAccountMetadataResponse,
    RawFullIdentityResponse,
    RawPrivateLinkResponse,
} from './types/raw';
import type {
    ChainLink,
    PrivateLink,
    AccountMetadata,
    AliasInfo,
    AliasFullIdentity,
    ListingInfo,
    AccountListing,
    SupportedChain,
    AddChainLinkParams,
    SetMetadataParams,
    PutOnSaleParams,
    DispatchAsLinkedParams,
} from './types';
import { mapRawScheme } from './helpers';

// ─── AccountMappingModule ─────────────────────────────────────────────────────

/**
 * Module for Orbinum pallet-account-mapping:
 * - Query on-chain identity data (aliases, chain links, metadata, marketplace)
 * - Submit identity management extrinsics
 *
 * All query methods return null/false on not-found or network errors.
 */
export class AccountMappingModule {
    constructor(private readonly substrate: SubstrateClient) {}

    // ─── Address resolution ─────────────────────────────────────────────────────

    /**
     * Returns the explicitly mapped (or fallback) Substrate AccountId32 hex for
     * an EVM address. `mapped` is set only when `map_account` was called.
     * `fallback` is always the EeSuffix rule: `H160 ++ [0x00; 12]`.
     */
    async getAccountAddresses(
        accountId: string
    ): Promise<{ mapped: string | null; fallback: string | null }> {
        try {
            const raw = await this.substrate.request<RawAccountAddresses>(
                'accountMapping_getAccountAddresses',
                [accountId]
            );
            return { mapped: raw.mapped ?? null, fallback: raw.fallback ?? null };
        } catch {
            return { mapped: null, fallback: null };
        }
    }

    /**
     * Returns the explicitly mapped Substrate AccountId32 hex for a given EVM
     * address, or null if no explicit mapping exists.
     */
    async getMappedAccount(evmAddress: string): Promise<string | null> {
        try {
            return await this.substrate.request<string | null>('accountMapping_getMappedAccount', [
                normalizeEvmAddress(evmAddress),
            ]);
        } catch {
            return null;
        }
    }

    // ─── Alias queries ──────────────────────────────────────────────────────────

    /**
     * Resolves "@alias" to basic info (owner, optional EVM address, link count).
     * Accepts the alias with or without the leading "@".
     */
    async resolveAlias(alias: string): Promise<AliasInfo | null> {
        try {
            const raw = await this.substrate.request<RawAliasResponse | null>(
                'accountMapping_resolveAlias',
                [alias]
            );
            if (!raw) return null;
            return {
                owner: raw.substrate_account,
                evmAddress: raw.evm_address ? normalizeEvmAddress(raw.evm_address) : null,
                chainLinksCount: raw.chain_links_count,
            };
        } catch {
            return null;
        }
    }

    /**
     * Returns the alias registered for the given Substrate AccountId32 hex, or null.
     */
    async getAliasOf(accountId: string): Promise<string | null> {
        try {
            return await this.substrate.request<string | null>('accountMapping_getAliasOf', [
                accountId,
            ]);
        } catch {
            return null;
        }
    }

    // ─── Full identity ──────────────────────────────────────────────────────────

    /**
     * Resolves "@alias" to its full identity: owner, EVM address, all public
     * chain links, and profile metadata.
     */
    async resolveFullIdentity(alias: string): Promise<AliasFullIdentity | null> {
        try {
            const raw = await this.substrate.request<RawFullIdentityResponse | null>(
                'accountMapping_resolveFullIdentity',
                [alias]
            );
            if (!raw) return null;
            return {
                owner: raw.owner,
                evmAddress: raw.evm_address ? normalizeEvmAddress(raw.evm_address) : null,
                chainLinks: raw.chain_links.map<ChainLink>((l) => ({
                    chainId: l.chain_id,
                    address: l.address,
                })),
                metadata: raw.metadata
                    ? {
                          displayName: raw.metadata.display_name ?? null,
                          bio: raw.metadata.bio ?? null,
                          avatar: raw.metadata.avatar ?? null,
                      }
                    : null,
            };
        } catch {
            return null;
        }
    }

    /**
     * Returns the profile metadata for a given Substrate AccountId32 hex, or null.
     */
    async getAccountMetadata(accountId: string): Promise<AccountMetadata | null> {
        try {
            const raw = await this.substrate.request<RawAccountMetadataResponse | null>(
                'accountMapping_getAccountMetadata',
                [accountId]
            );
            if (!raw) return null;
            return {
                displayName: raw.display_name ?? null,
                bio: raw.bio ?? null,
                avatar: raw.avatar ?? null,
            };
        } catch {
            return null;
        }
    }

    // ─── Chain links ────────────────────────────────────────────────────────────

    /**
     * Returns the owner AccountId32 hex of a verified multichain link, or null.
     */
    async getLinkOwner(chainId: number, address: string): Promise<string | null> {
        try {
            return await this.substrate.request<string | null>('accountMapping_getLinkOwner', [
                chainId,
                address,
            ]);
        } catch {
            return null;
        }
    }

    /**
     * Returns all blockchain networks supported for verified cross-chain links.
     */
    async getSupportedChains(): Promise<SupportedChain[]> {
        try {
            const raw = await this.substrate.request<Array<[number, unknown]>>(
                'accountMapping_getSupportedChains',
                []
            );
            return raw.map(([chainId, scheme]) => ({
                chainId,
                scheme: mapRawScheme(scheme),
            }));
        } catch {
            return [];
        }
    }

    // ─── Private links ──────────────────────────────────────────────────────────

    /**
     * Returns the private link commitments registered for an alias.
     * Real addresses are never exposed. Returns null if the alias does not exist.
     */
    async getPrivateLinks(alias: string): Promise<PrivateLink[] | null> {
        try {
            const raw = await this.substrate.request<RawPrivateLinkResponse[] | null>(
                'accountMapping_getPrivateLinks',
                [alias]
            );
            if (!raw) return null;
            return raw.map((r) => ({ chainId: r.chain_id, commitment: r.commitment }));
        } catch {
            return null;
        }
    }

    /**
     * Returns true if the given commitment is registered as a private link for the alias.
     */
    async hasPrivateLink(alias: string, commitment: string): Promise<boolean> {
        try {
            return await this.substrate.request<boolean>('accountMapping_hasPrivateLink', [
                alias,
                commitment,
            ]);
        } catch {
            return false;
        }
    }

    // ─── Marketplace ────────────────────────────────────────────────────────────

    /**
     * Returns listing info if the alias is currently for sale, or null.
     */
    async getListingInfo(alias: string): Promise<ListingInfo | null> {
        try {
            const raw = await this.substrate.request<RawListingResponse | null>(
                'accountMapping_getListingInfo',
                [alias]
            );
            if (!raw) return null;
            return {
                price: BigInt(raw.price),
                private: raw.private,
                whitelistCount: raw.whitelist_count,
            };
        } catch {
            return null;
        }
    }

    /**
     * Returns the alias and its listing if the given account currently has an
     * alias listed for sale. Returns null otherwise.
     */
    async getAccountListing(accountId: string): Promise<AccountListing | null> {
        try {
            const raw = await this.substrate.request<RawListingResponse | null>(
                'accountMapping_getAccountListing',
                [accountId]
            );
            if (!raw) return null;
            return {
                alias: raw.alias,
                listing: {
                    price: BigInt(raw.price),
                    private: raw.private,
                    whitelistCount: raw.whitelist_count,
                },
            };
        } catch {
            return null;
        }
    }

    /**
     * Returns whether a specific buyer can purchase the given alias right now.
     */
    async canBuy(alias: string, buyerAccountId: string): Promise<boolean> {
        try {
            return await this.substrate.request<boolean>('accountMapping_canBuy', [
                alias,
                buyerAccountId,
            ]);
        } catch {
            return false;
        }
    }

    // ─── Extrinsics ─────────────────────────────────────────────────────────────

    /**
     * Creates an explicit EVM → Substrate account mapping.
     * Stores an explicit `MappedAccounts` entry for the caller's H160.
     * Extrinsic: accountMapping.mapAccount()
     */
    async mapAccount(signer: PolkadotSigner): Promise<TxResult> {
        const entry = resolveTx(this.substrate.unsafe, 'accountMapping', 'mapAccount');
        const tx = callUnsafeTx(entry);
        return toTxResult(await tx.signAndSubmit(signer));
    }

    /**
     * Removes the EVM → Substrate mapping for the caller.
     * Extrinsic: accountMapping.unmapAccount()
     */
    async unmapAccount(signer: PolkadotSigner): Promise<TxResult> {
        const entry = resolveTx(this.substrate.unsafe, 'accountMapping', 'unmapAccount');
        const tx = callUnsafeTx(entry);
        return toTxResult(await tx.signAndSubmit(signer));
    }

    /**
     * Registers a unique @alias for the caller.
     * Requires a deposit. The alias must be 3–32 ASCII lowercase alphanumeric chars + hyphens.
     * Extrinsic: accountMapping.registerAlias(alias)
     */
    async registerAlias(alias: string, signer: PolkadotSigner): Promise<TxResult> {
        const entry = resolveTx(this.substrate.unsafe, 'accountMapping', 'registerAlias');
        const tx = callUnsafeTx(entry, Binary.fromText(alias));
        return toTxResult(await tx.signAndSubmit(signer));
    }

    /**
     * Releases the caller's alias and recovers the deposit.
     * Extrinsic: accountMapping.releaseAlias()
     */
    async releaseAlias(signer: PolkadotSigner): Promise<TxResult> {
        const entry = resolveTx(this.substrate.unsafe, 'accountMapping', 'releaseAlias');
        const tx = callUnsafeTx(entry);
        return toTxResult(await tx.signAndSubmit(signer));
    }

    /**
     * Transfers the caller's alias to another account.
     * Extrinsic: accountMapping.transferAlias(newOwner)
     */
    async transferAlias(newOwnerHex: string, signer: PolkadotSigner): Promise<TxResult> {
        const entry = resolveTx(this.substrate.unsafe, 'accountMapping', 'transferAlias');
        const tx = callUnsafeTx(entry, newOwnerHex);
        return toTxResult(await tx.signAndSubmit(signer));
    }

    /**
     * Adds a verified public link to an external-chain wallet.
     *
     * `params.signature` must be produced by the external wallet over the caller's
     * AccountId32 bytes:
     *  - EIP-191 (EVM): sign(keccak256("\x19Ethereum Signed Message:\n32" + accountId32))
     *  - Ed25519 (Solana): sign(accountId32 bytes)
     *
     * Extrinsic: accountMapping.addChainLink(chainId, address, signature)
     */
    async addChainLink(params: AddChainLinkParams, signer: PolkadotSigner): Promise<TxResult> {
        const entry = resolveTx(this.substrate.unsafe, 'accountMapping', 'addChainLink');
        const tx = callUnsafeTx(
            entry,
            params.chainId,
            Binary.fromBytes(params.address),
            Binary.fromBytes(params.signature)
        );
        return toTxResult(await tx.signAndSubmit(signer));
    }

    /**
     * Removes the external-chain link for the given chain ID.
     * Extrinsic: accountMapping.removeChainLink(chainId)
     */
    async removeChainLink(chainId: number, signer: PolkadotSigner): Promise<TxResult> {
        const entry = resolveTx(this.substrate.unsafe, 'accountMapping', 'removeChainLink');
        const tx = callUnsafeTx(entry, chainId);
        return toTxResult(await tx.signAndSubmit(signer));
    }

    /**
     * Updates the caller's public profile metadata.
     * Extrinsic: accountMapping.setAccountMetadata(displayName, bio, avatar)
     */
    async setAccountMetadata(params: SetMetadataParams, signer: PolkadotSigner): Promise<TxResult> {
        const entry = resolveTx(this.substrate.unsafe, 'accountMapping', 'setAccountMetadata');
        const encode = (v: string | null | undefined) =>
            v != null ? Binary.fromText(v) : undefined;
        const tx = callUnsafeTx(
            entry,
            encode(params.displayName),
            encode(params.bio),
            encode(params.avatar)
        );
        return toTxResult(await tx.signAndSubmit(signer));
    }

    /**
     * Lists the caller's alias for sale on the alias marketplace.
     * Extrinsic: accountMapping.putAliasOnSale(price, isPrivate)
     */
    async putAliasOnSale(params: PutOnSaleParams, signer: PolkadotSigner): Promise<TxResult> {
        const entry = resolveTx(this.substrate.unsafe, 'accountMapping', 'putAliasOnSale');
        const tx = callUnsafeTx(entry, params.price.toString(), params.isPrivate);
        return toTxResult(await tx.signAndSubmit(signer));
    }

    /**
     * Cancels an active alias sale listing.
     * Extrinsic: accountMapping.cancelSale()
     */
    async cancelSale(signer: PolkadotSigner): Promise<TxResult> {
        const entry = resolveTx(this.substrate.unsafe, 'accountMapping', 'cancelSale');
        const tx = callUnsafeTx(entry);
        return toTxResult(await tx.signAndSubmit(signer));
    }

    /**
     * Purchases an alias listed for sale.
     * Extrinsic: accountMapping.buyAlias(alias)
     */
    async buyAlias(alias: string, signer: PolkadotSigner): Promise<TxResult> {
        const entry = resolveTx(this.substrate.unsafe, 'accountMapping', 'buyAlias');
        const tx = callUnsafeTx(entry, Binary.fromText(alias));
        return toTxResult(await tx.signAndSubmit(signer));
    }

    /**
     * Dispatches an arbitrary call on behalf of a linked external-chain wallet.
     *
     * This is the "Universal Proxy" feature that allows EVM/Solana wallets to
     * authorize on-chain actions without holding a Substrate private key.
     *
     * The relayer (who pays gas) calls this with the external wallet's signature
     * over the encoded call payload and the owner's AccountId32.
     *
     * Extrinsic: accountMapping.dispatchAsLinkedAccount(owner, chainId, address, signature, call)
     */
    async dispatchAsLinkedAccount(
        params: DispatchAsLinkedParams,
        signer: PolkadotSigner
    ): Promise<TxResult> {
        const entry = resolveTx(this.substrate.unsafe, 'accountMapping', 'dispatchAsLinkedAccount');
        const tx = callUnsafeTx(
            entry,
            params.owner,
            params.chainId,
            Binary.fromBytes(params.address),
            Binary.fromBytes(params.signature),
            Binary.fromBytes(params.callData)
        );
        return toTxResult(await tx.signAndSubmit(signer));
    }
}
