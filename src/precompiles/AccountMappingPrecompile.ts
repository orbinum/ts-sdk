import type { EvmClient } from '../evm/EvmClient';
import { fromHex, ensureHexPrefix } from '../utils/hex';
import { normalizeEvmAddress } from '../utils/address';
import { encodeHex, hexToBytes, decodeAddress, decodeBool, decodeString } from './abi';
import { PRECOMPILE_ADDR, AM_SEL } from './addresses';
import type { EvmTxRequest, EvmSigner } from './ShieldedPoolPrecompile';

// ─── Return types ─────────────────────────────────────────────────────────────

export type ResolvedAlias = {
    /** AccountId32 hex of the alias owner (as 0x-prefixed 20-byte EVM address). */
    owner: string;
    /** EVM address of the owner, or null if unset. */
    evmAddress: string | null;
};

// ─── AccountMappingPrecompile ─────────────────────────────────────────────────

/**
 * EVM bindings for `AccountMappingPrecompile` at address `0x...0800`.
 *
 * This precompile wraps `pallet-account-mapping` extrinsics and queries,
 * allowing **EVM wallets** to manage their on-chain identity (aliases, chain
 * links, metadata, marketplace) without a Substrate signer.
 *
 * ### Read-only calls
 * Use `resolveAlias`, `getAliasOf`, `hasPrivateLink` to query state via
 * `eth_call` — no signer required.
 *
 * ### Write calls
 * Provide an `EvmSigner` callback. The EVM caller's address is mapped to its
 * Substrate AccountId32 via `AddressMapping`.
 */
export class AccountMappingPrecompile {
    private readonly addr = PRECOMPILE_ADDR.ACCOUNT_MAPPING;

    constructor(private readonly evm: EvmClient) {}

    // ─── Read-only ─────────────────────────────────────────────────────────────

    /**
     * Resolves `@alias` to its owner EVM address (and optionally a secondary EVM address).
     *
     * Returns `(address owner, address evmAddress)` — two 32-byte ABI-encoded slots.
     * `evmAddress` is zero-address (`0x000...0`) if the owner has no explicit EVM address.
     */
    async resolveAlias(alias: string): Promise<ResolvedAlias | null> {
        try {
            const data = encodeHex(AM_SEL.RESOLVE_ALIAS, { type: 'string', value: alias });
            const raw = hexToBytes(await this.evm.call(this.addr, data));
            if (raw.length < 64) return null;
            const owner = decodeAddress(raw, 0);
            const evm = decodeAddress(raw, 32);
            const ZERO = '0x0000000000000000000000000000000000000000';
            return {
                owner,
                evmAddress: evm === ZERO ? null : normalizeEvmAddress(evm),
            };
        } catch {
            return null;
        }
    }

    /**
     * Returns the alias registered for the given EVM address, or null.
     * The precompile ABI encodes the alias as `bytes` (UTF-8).
     */
    async getAliasOf(evmAddress: string): Promise<string | null> {
        try {
            const data = encodeHex(AM_SEL.GET_ALIAS_OF, {
                type: 'address',
                value: normalizeEvmAddress(evmAddress),
            });
            const raw = hexToBytes(await this.evm.call(this.addr, data));
            if (raw.length === 0) return null;
            const alias = decodeString(raw, 0);
            return alias.length > 0 ? alias : null;
        } catch {
            return null;
        }
    }

    /**
     * Returns true if the given Poseidon commitment is registered as a private
     * link for the given alias.
     */
    async hasPrivateLink(alias: string, commitment: string): Promise<boolean> {
        try {
            const commitmentBytes = fromHex(ensureHexPrefix(commitment));
            const data = encodeHex(
                AM_SEL.HAS_PRIVATE_LINK,
                { type: 'string', value: alias },
                { type: 'bytes32', value: commitmentBytes }
            );
            const raw = hexToBytes(await this.evm.call(this.addr, data));
            if (raw.length < 32) return false;
            return decodeBool(raw, 0);
        } catch {
            return false;
        }
    }

    // ─── No-arg writes ─────────────────────────────────────────────────────────

    /**
     * Creates an explicit EVM → Substrate account mapping for the signer's address.
     * Extrinsic: `accountMapping.mapAccount()`
     */
    async mapAccount(signer: EvmSigner): Promise<string> {
        return signer({ to: this.addr, data: encodeHex(AM_SEL.MAP_ACCOUNT) });
    }

    /**
     * Removes the EVM → Substrate mapping for the signer's address.
     * Extrinsic: `accountMapping.unmapAccount()`
     */
    async unmapAccount(signer: EvmSigner): Promise<string> {
        return signer({ to: this.addr, data: encodeHex(AM_SEL.UNMAP_ACCOUNT) });
    }

    /**
     * Releases the signer's registered alias, recovering the deposit.
     * Extrinsic: `accountMapping.releaseAlias()`
     */
    async releaseAlias(signer: EvmSigner): Promise<string> {
        return signer({ to: this.addr, data: encodeHex(AM_SEL.RELEASE_ALIAS) });
    }

    /**
     * Cancels an active alias sale listing.
     * Extrinsic: `accountMapping.cancelSale()`
     */
    async cancelSale(signer: EvmSigner): Promise<string> {
        return signer({ to: this.addr, data: encodeHex(AM_SEL.CANCEL_SALE) });
    }

    // ─── Writes with arguments ─────────────────────────────────────────────────

    /**
     * Registers a unique @alias for the signer's account.
     * Requires a deposit. The alias must be 3–32 ASCII lowercase alphanumeric chars + hyphens.
     * Extrinsic: `accountMapping.registerAlias(alias)`
     */
    async registerAlias(alias: string, signer: EvmSigner): Promise<string> {
        const data = encodeHex(AM_SEL.REGISTER_ALIAS, { type: 'string', value: alias });
        return signer({ to: this.addr, data });
    }

    /**
     * Transfers the signer's alias to a new EVM `owner` address.
     * Extrinsic: `accountMapping.transferAlias(newOwner)`
     */
    async transferAlias(newOwnerEvmAddress: string, signer: EvmSigner): Promise<string> {
        const data = encodeHex(AM_SEL.TRANSFER_ALIAS, {
            type: 'address',
            value: normalizeEvmAddress(newOwnerEvmAddress),
        });
        return signer({ to: this.addr, data });
    }

    /**
     * Purchases an alias currently listed for sale.
     * Extrinsic: `accountMapping.buyAlias(alias)`
     */
    async buyAlias(alias: string, signer: EvmSigner): Promise<string> {
        const data = encodeHex(AM_SEL.BUY_ALIAS, { type: 'string', value: alias });
        return signer({ to: this.addr, data });
    }

    /**
     * Lists the signer's alias for sale on the alias marketplace.
     *
     * @param price          Asking price in planck (ORB).
     * @param allowedBuyers  Whitelist of EVM addresses allowed to buy.
     *                       Pass an empty array for a public (open) listing.
     * Extrinsic: `accountMapping.putAliasOnSale(price, allowedBuyers)`
     */
    async putAliasOnSale(
        price: bigint,
        allowedBuyers: string[],
        signer: EvmSigner
    ): Promise<string> {
        const data = encodeHex(
            AM_SEL.PUT_ALIAS_ON_SALE,
            { type: 'uint', value: price },
            { type: 'address[]', value: allowedBuyers.map(normalizeEvmAddress) }
        );
        return signer({ to: this.addr, data });
    }

    /**
     * Removes the external-chain link for the given chain ID.
     * Extrinsic: `accountMapping.removeChainLink(chainId)`
     */
    async removeChainLink(chainId: number, signer: EvmSigner): Promise<string> {
        const data = encodeHex(AM_SEL.REMOVE_CHAIN_LINK, { type: 'uint', value: BigInt(chainId) });
        return signer({ to: this.addr, data });
    }

    /**
     * Adds a verified public link to an external-chain wallet.
     *
     * @param chainId       Orbinum chain ID (use `SLIP0044_NAMESPACE | coinType` for SLIP-0044).
     * @param externalAddr  External wallet address bytes (20 bytes for EVM, 32 for Solana).
     * @param signature     Signature over the caller's AccountId32:
     *                        - EIP-191 (EVM): 65 bytes over keccak256("\x19Ethereum Signed Message:\n32" + accountId32)
     *                        - Ed25519 (Solana): 64 bytes over the raw accountId32 bytes
     *
     * Extrinsic: `accountMapping.addChainLink(chainId, address, signature)`
     */
    async addChainLink(
        chainId: number,
        externalAddr: Uint8Array,
        signature: Uint8Array,
        signer: EvmSigner
    ): Promise<string> {
        const data = encodeHex(
            AM_SEL.ADD_CHAIN_LINK,
            { type: 'uint', value: BigInt(chainId) },
            { type: 'bytes', value: externalAddr },
            { type: 'bytes', value: signature }
        );
        return signer({ to: this.addr, data });
    }

    /**
     * Registers a private chain link — only the Poseidon commitment is stored.
     * The real external address is never revealed on-chain.
     *
     * @param chainId     External chain ID.
     * @param commitment  0x-prefixed 32-byte Poseidon commitment hex.
     *
     * Extrinsic: `accountMapping.registerPrivateLink(chainId, commitment)`
     */
    async registerPrivateLink(
        chainId: number,
        commitment: string,
        signer: EvmSigner
    ): Promise<string> {
        const commitmentBytes = fromHex(
            commitment.startsWith('0x') ? commitment : '0x' + commitment
        );
        const data = encodeHex(
            AM_SEL.REGISTER_PRIVATE_LINK,
            { type: 'uint', value: BigInt(chainId) },
            { type: 'bytes32', value: commitmentBytes }
        );
        return signer({ to: this.addr, data });
    }

    /**
     * Removes a private link by its commitment.
     * Extrinsic: `accountMapping.removePrivateLink(commitment)`
     */
    async removePrivateLink(commitment: string, signer: EvmSigner): Promise<string> {
        const commitmentBytes = fromHex(
            commitment.startsWith('0x') ? commitment : '0x' + commitment
        );
        const data = encodeHex(AM_SEL.REMOVE_PRIVATE_LINK, {
            type: 'bytes32',
            value: commitmentBytes,
        });
        return signer({ to: this.addr, data });
    }

    /**
     * Reveals a private link publicly by providing the real address and blinding.
     * After this call the link becomes a public chain link.
     *
     * @param commitment  32-byte commitment hex.
     * @param address     External address bytes (the actual wallet address).
     * @param blinding    32-byte blinding factor used when computing the commitment.
     * @param signature   Signature over the AccountId32 bytes (same rules as `addChainLink`).
     *
     * Extrinsic: `accountMapping.revealPrivateLink(commitment, address, blinding, signature)`
     */
    async revealPrivateLink(
        commitment: string,
        address: Uint8Array,
        blinding: string,
        signature: Uint8Array,
        signer: EvmSigner
    ): Promise<string> {
        const commitmentBytes = fromHex(
            commitment.startsWith('0x') ? commitment : '0x' + commitment
        );
        const blindingBytes = fromHex(blinding.startsWith('0x') ? blinding : '0x' + blinding);
        const data = encodeHex(
            AM_SEL.REVEAL_PRIVATE_LINK,
            { type: 'bytes32', value: commitmentBytes },
            { type: 'bytes', value: address },
            { type: 'bytes32', value: blindingBytes },
            { type: 'bytes', value: signature }
        );
        return signer({ to: this.addr, data });
    }

    /**
     * Updates the signer's public profile metadata.
     * Pass `null` for any field to leave it unchanged.
     *
     * Extrinsic: `accountMapping.setAccountMetadata(displayName, bio, avatar)`
     */
    async setAccountMetadata(
        displayName: string | null,
        bio: string | null,
        avatar: string | null,
        signer: EvmSigner
    ): Promise<string> {
        const enc = (v: string | null): Uint8Array =>
            v != null ? new TextEncoder().encode(v) : new Uint8Array(0);
        const data = encodeHex(
            AM_SEL.SET_ACCOUNT_METADATA,
            { type: 'bytes', value: enc(displayName) },
            { type: 'bytes', value: enc(bio) },
            { type: 'bytes', value: enc(avatar) }
        );
        return signer({ to: this.addr, data });
    }

    // ─── Calldata builders (for custom signing / batching) ─────────────────────

    /** Returns the raw ABI-encoded calldata for `registerAlias`. */
    buildRegisterAliasCalldata(alias: string): string {
        return encodeHex(AM_SEL.REGISTER_ALIAS, { type: 'string', value: alias });
    }

    /** Returns the raw ABI-encoded calldata for `mapAccount`. */
    buildMapAccountCalldata(): string {
        return encodeHex(AM_SEL.MAP_ACCOUNT);
    }
}

export type { EvmTxRequest, EvmSigner };
