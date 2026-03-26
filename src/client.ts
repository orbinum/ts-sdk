import { SubstrateClient } from './substrate/SubstrateClient';
import { EvmClient } from './evm/EvmClient';
import { MerkleModule } from './shielded-pool/MerkleModule';
import { ShieldedPoolModule } from './shielded-pool/ShieldedPoolModule';
import { ChainModule } from './chain/ChainModule';
import { AccountMappingModule } from './account-mapping/AccountMappingModule';
import { ShieldedPoolPrecompile } from './precompiles/ShieldedPoolPrecompile';
import { AccountMappingPrecompile } from './precompiles/AccountMappingPrecompile';
import { CryptoPrecompiles } from './precompiles/CryptoPrecompiles';
import type { OrbinumClientConfig } from './types';

export type { OrbinumClientConfig };

/**
 * Main entry point for the Orbinum TypeScript SDK.
 *
 * Connects to an Orbinum node and exposes all protocol modules.
 *
 * @example
 * ```ts
 * import { OrbinumClient } from '@orbinum/sdk';
 *
 * const client = await OrbinumClient.connect({
 *   substrateWs: 'ws://localhost:9944',
 *   evmRpc: 'http://localhost:9933',
 * });
 *
 * // Query Merkle tree
 * const info = await client.shieldedPool.merkle.getTreeInfo();
 * console.log('root:', info.root, 'nodes:', info.treeSize);
 *
 * // Shield tokens (with a PolkadotSigner)
 * const result = await client.shieldedPool.shield(
 *   { assetId: 1, amount: 1000n, commitment: '0xabc...' },
 *   signer,
 * );
 * console.log('tx ok:', result.ok, 'block:', result.blockHash);
 *
 * client.destroy();
 * ```
 */
export class OrbinumClient {
    /** Raw access to the Substrate WebSocket connection and RPC. */
    readonly substrate: SubstrateClient;
    /** Raw access to the EVM HTTP JSON-RPC endpoint (if configured). */
    readonly evm: EvmClient | null;
    /** Shielded-pool operations: shield, unshield, privateTransfer, and merkle queries. */
    readonly shieldedPool: ShieldedPoolModule;
    /** General chain queries: node info, identity resolution. */
    readonly chain: ChainModule;
    /** Account mapping: aliases, chain links, metadata, marketplace, and identity extrinsics. */
    readonly accountMapping: AccountMappingModule;
    /**
     * EVM precompiles: shielded pool + account mapping callable from an EVM wallet.
     * Only available when `evmRpc` is configured. Methods throw if `evm` is null.
     */
    readonly precompiles: {
        /** `ShieldedPoolPrecompile` (0x0801): shield/unshield/transfer via EVM wallet. */
        shieldedPool: ShieldedPoolPrecompile;
        /** `AccountMappingPrecompile` (0x0800): identity management via EVM wallet. */
        accountMapping: AccountMappingPrecompile;
        /** Cryptographic precompiles: ECRecover, Keccak-256, Curve25519. */
        crypto: CryptoPrecompiles;
    } | null;

    private constructor(substrate: SubstrateClient, evm: EvmClient | null) {
        this.substrate = substrate;
        this.evm = evm;
        const merkle = new MerkleModule(substrate);
        this.shieldedPool = new ShieldedPoolModule(substrate, merkle);
        this.chain = new ChainModule(substrate, evm);
        this.accountMapping = new AccountMappingModule(substrate);
        this.precompiles = evm
            ? {
                  shieldedPool: new ShieldedPoolPrecompile(evm),
                  accountMapping: new AccountMappingPrecompile(evm),
                  crypto: new CryptoPrecompiles(evm),
              }
            : null;
    }

    /**
     * Connects to an Orbinum node and returns a ready-to-use `OrbinumClient`.
     * Throws if the Substrate node is unreachable within `connectTimeoutMs`.
     */
    static async connect(config: OrbinumClientConfig): Promise<OrbinumClient> {
        const substrate = await SubstrateClient.connect(
            config.substrateWs,
            config.connectTimeoutMs ?? 15_000
        );
        const evm = config.evmRpc ? new EvmClient(config.evmRpc) : null;
        return new OrbinumClient(substrate, evm);
    }

    /**
     * Convenience getter for the Merkle module (shortcut for `shieldedPool.merkle`).
     */
    get merkle() {
        return this.shieldedPool.merkle;
    }

    /** Closes the WebSocket connection to the Substrate node. */
    destroy(): void {
        this.substrate.destroy();
    }
}
