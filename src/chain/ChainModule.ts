import type { SubstrateClient } from '../substrate/SubstrateClient';
import type { EvmClient } from '../evm/EvmClient';
import type { ChainInfo, FullIdentityInfo } from '../types';
import { normalizeEvmAddress } from '../utils/address';

// ─── Raw RPC shapes ───────────────────────────────────────────────────────────

type RawFullIdentity = {
    substrate_address: string | null;
    evm_address: string | null;
    alias: string | null;
};

type RawSystemHealth = {
    peers: number;
    isSyncing: boolean;
    shouldHavePeers: boolean;
};

type RawRuntimeVersion = {
    specName: string;
    specVersion: number;
    implName: string;
    ss58Prefix?: number;
};

// ─── ChainModule ─────────────────────────────────────────────────────────────

/**
 * Provides general chain queries: node info, account mapping, address resolution.
 */
export class ChainModule {
    constructor(
        private readonly substrate: SubstrateClient,
        private readonly evm: EvmClient | null
    ) {}

    // ─── Node info ─────────────────────────────────────────────────────────────

    /**
     * Returns basic chain information from the node.
     */
    async getChainInfo(): Promise<ChainInfo> {
        const [name, version] = await Promise.all([
            this.substrate.request<string>('system_name', []),
            this.substrate.request<RawRuntimeVersion>('state_getRuntimeVersion', []),
        ]);
        return {
            name,
            version: String(version.specVersion),
            ss58Prefix: version.ss58Prefix ?? 42,
        };
    }

    /**
     * Returns the node's peer count and sync status.
     */
    async getHealth(): Promise<RawSystemHealth> {
        return this.substrate.request<RawSystemHealth>('system_health', []);
    }

    /**
     * Returns the node's software version string.
     */
    async getNodeVersion(): Promise<string> {
        return this.substrate.request<string>('system_version', []);
    }

    /**
     * Returns the genesis hash hex.
     */
    async getGenesisHash(): Promise<string> {
        return this.substrate.request<string>('chain_getBlockHash', [0]);
    }

    // ─── Account mapping ───────────────────────────────────────────────────────

    /**
     * Resolves the full identity (Substrate + EVM addresses, alias) for an account.
     * Accepts an EVM address (0x...) or a Substrate account hex (0x...32bytes).
     */
    async getFullIdentity(address: string): Promise<FullIdentityInfo | null> {
        try {
            const raw = await this.substrate.request<RawFullIdentity>(
                'accountMapping_resolveFullIdentity',
                [address]
            );
            return {
                substrateAddress: raw.substrate_address ?? null,
                evmAddress: raw.evm_address ? normalizeEvmAddress(raw.evm_address) : null,
                alias: raw.alias ?? null,
            };
        } catch {
            return null;
        }
    }

    /**
     * Returns the mapped Substrate account hex for a given EVM address, or null.
     */
    async getMappedAccountByEvm(evmAddress: string): Promise<string | null> {
        try {
            return await this.substrate.request<string | null>('accountMapping_getMappedAccount', [
                normalizeEvmAddress(evmAddress),
            ]);
        } catch {
            return null;
        }
    }

    /**
     * Returns the alias registered for a Substrate account, or null.
     */
    async getAliasOf(accountHex: string): Promise<string | null> {
        try {
            return await this.substrate.request<string | null>('accountMapping_getAliasOf', [
                accountHex,
            ]);
        } catch {
            return null;
        }
    }

    // ─── EVM helpers ───────────────────────────────────────────────────────────

    /**
     * Returns estimated EVM chain ID from the EVM RPC endpoint. Requires evmRpc
     * to have been provided in `OrbinumClientConfig`.
     */
    async getEvmChainId(): Promise<number> {
        if (!this.evm)
            throw new Error('No EVM RPC URL configured. Set evmRpc in OrbinumClientConfig.');
        return this.evm.getChainId();
    }

    /**
     * Returns the current EVM block number.
     */
    async getEvmBlockNumber(): Promise<number> {
        if (!this.evm) throw new Error('No EVM RPC URL configured.');
        return this.evm.getBlockNumber();
    }
}
