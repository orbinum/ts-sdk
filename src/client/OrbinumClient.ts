import { SubstrateClient } from '../substrate/SubstrateClient';
import { EvmClient } from '../evm/EvmClient';
import { EvmExplorer } from '../evm-explorer/EvmExplorer';
import { IndexerClient } from '../indexer/IndexerClient';
import { ShieldedPoolModule } from '../shielded-pool/ShieldedPoolModule';
import { AccountMappingModule } from '../account-mapping/AccountMappingModule';
import { PrivacyModule } from '../rpc-v2/PrivacyModule';
import { ZkVerifierModule } from '../zk-verifier/ZkVerifierModule';
import { ShieldedPoolPrecompile } from '../precompiles/ShieldedPoolPrecompile';
import { AccountMappingPrecompile } from '../precompiles/AccountMappingPrecompile';
import { CryptoPrecompiles } from '../precompiles/CryptoPrecompiles';
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
 * // Query Merkle tree stats
 * const stats = await client.privacy.getPoolStats();
 * console.log('root:', stats.merkleRoot, 'leaves:', stats.commitmentCount);
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
    /**
     * High-level EVM block and transaction explorer (if `evmRpc` is configured).
     * Provides enriched queries for blocks, transactions, addresses, and token transfers.
     */
    readonly evmExplorer: EvmExplorer | null;
    /**
     * HTTP client for the Orbinum indexer REST API (if `indexerUrl` is configured).
     * Provides paginated access to indexed blocks, extrinsics, shielded events, and nullifiers.
     */
    readonly indexer: IndexerClient | null;
    /** Shielded-pool operations: shield, unshield, privateTransfer, and merkle queries. */
    readonly shieldedPool: ShieldedPoolModule;
    /** Account mapping: aliases, chain links, metadata, marketplace, and identity extrinsics. */
    readonly accountMapping: AccountMappingModule;
    /** Typed access to Orbinum `privacy_*` RPC endpoints. */
    readonly privacy: PrivacyModule;
    /** Typed access to zkVerifier_* RPC endpoints. */
    readonly zkVerifier: ZkVerifierModule;
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

    private constructor(
        substrate: SubstrateClient,
        evm: EvmClient | null,
        indexer: IndexerClient | null
    ) {
        this.substrate = substrate;
        this.evm = evm;
        this.evmExplorer = evm ? new EvmExplorer(evm) : null;
        this.indexer = indexer;
        this.shieldedPool = new ShieldedPoolModule(substrate);
        this.accountMapping = new AccountMappingModule(substrate);
        this.privacy = new PrivacyModule(substrate);
        this.zkVerifier = new ZkVerifierModule(substrate);
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
        const indexer = config.indexerUrl
            ? new IndexerClient({ baseUrl: config.indexerUrl })
            : null;
        return new OrbinumClient(substrate, evm, indexer);
    }

    /** Closes the WebSocket connection to the Substrate node. */
    destroy(): void {
        this.substrate.destroy();
    }
}
