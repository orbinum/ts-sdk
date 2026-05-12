import type { SubstrateClient } from '../substrate/SubstrateClient';

/**
 * Status info for a registered relayer account.
 */
export interface RelayerInfo {
    /** Whether the account is a registered relayer. */
    isRelayer: boolean;
    /** The registered EVM address (0x-prefixed), or null if not registered. */
    evmAddress: string | null;
}

/**
 * Typed client for `relayer_*` JSON-RPC endpoints.
 *
 * Exposes read-only queries for relayer registry and pending fee data.
 */
export class RelayerStatusModule {
    constructor(private readonly substrate: SubstrateClient) {}

    /**
     * Returns true if the given SS58 address is a registered relayer.
     */
    async isRelayer(ss58Address: string): Promise<boolean> {
        return this.substrate.request<boolean>('relayer_isRelayer', [ss58Address]);
    }

    /**
     * Returns the pending fees (in planck) for the given account and asset.
     * The node returns the value as a decimal string to avoid u128 overflow.
     */
    async pendingFees(ss58Address: string, assetId: number): Promise<bigint> {
        const raw = await this.substrate.request<string>('relayer_pendingFees', [
            ss58Address,
            assetId,
        ]);
        return BigInt(raw);
    }

    /**
     * Returns the registered EVM address (0x-prefixed) for the given account,
     * or null if the account is not a registered relayer.
     */
    async registeredEvmAddress(ss58Address: string): Promise<string | null> {
        return this.substrate.request<string | null>('relayer_registeredEvmAddress', [ss58Address]);
    }

    /**
     * Convenience method: returns relayer registry info for an account.
     */
    async getRelayerInfo(ss58Address: string): Promise<RelayerInfo> {
        const [isRelayer, evmAddress] = await Promise.all([
            this.isRelayer(ss58Address),
            this.registeredEvmAddress(ss58Address),
        ]);
        return { isRelayer, evmAddress };
    }
}
