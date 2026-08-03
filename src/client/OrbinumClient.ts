import { SubstrateClient } from '../substrate/SubstrateClient';
import { EvmClient } from '../evm/EvmClient';
import { EvmExplorer } from '../evm-explorer/EvmExplorer';
import { ShieldedPoolModule } from '../shielded-pool/pallet/ShieldedPoolModule';
import { ChainModule } from '../rpc-v2/ChainModule';
import { PrivacyModule } from '../rpc-v2/PrivacyModule';
import { ZkVerifierModule } from '../zk-verifier/ZkVerifierModule';
import { CircuitVersionResolver } from '../shielded-pool/CircuitVersionResolver';
import { RelayerStatusModule } from '../relayer/RelayerStatusModule';
import { ShieldedPoolPrecompile } from '../precompiles/ShieldedPoolPrecompile';
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
    /** Raw Substrate WebSocket connection — use for custom RPC calls or low-level access. */
    readonly substrate: SubstrateClient;
    /** Raw EVM HTTP JSON-RPC client. `null` when `evmRpc` is not configured. */
    readonly evm: EvmClient | null;
    /**
     * High-level EVM block and transaction explorer.
     * Provides enriched queries for blocks, transactions, addresses, and token transfers.
     * `null` when `evmRpc` is not configured.
     */
    readonly evmExplorer: EvmExplorer | null;
    /** Shielded-pool extrinsics and Merkle tree queries (`shield`, `unshield`, `privateTransfer`, …). */
    readonly shieldedPool: ShieldedPoolModule;
    /** Typed access to `privacy_*` custom RPC endpoints. */
    readonly privacy: PrivacyModule;
    /** Typed access to general chain state via `chain_*` custom RPC endpoints. */
    readonly chain: ChainModule;
    /** Typed access to `zkVerifier_*` custom RPC endpoints. */
    readonly zkVerifier: ZkVerifierModule;
    /**
     * Resolves a note's circuit version to a pinned prover + on-chain version
     * before spending it (fail-closed: throws on unsupported version / VK mismatch).
     */
    readonly circuitVersionResolver: CircuitVersionResolver;
    /** Typed access to `relayer_*` RPC endpoints (registry lookup and pending fee queries). */
    readonly relayerStatus: RelayerStatusModule;
    /**
     * Precompile modules for interacting with Orbinum contracts from an EVM wallet.
     * `null` when `evmRpc` is not configured. Methods on each sub-module throw if `evm` is `null`.
     */
    readonly precompiles: {
        /** `ShieldedPoolPrecompile` at `0x0801`: shield / unshield / transfer via EVM wallet. */
        shieldedPool: ShieldedPoolPrecompile;
        /** Built-in cryptographic precompiles: ECRecover, Keccak-256, Curve25519. */
        crypto: CryptoPrecompiles;
    } | null;

    /** @internal Use `OrbinumClient.connect()` to obtain an instance. */
    private constructor(
        substrate: SubstrateClient,
        evm: EvmClient | null,
        circuitsBaseUrl?: string
    ) {
        this.substrate = substrate;
        this.evm = evm;
        this.evmExplorer = evm ? new EvmExplorer(evm) : null;
        this.shieldedPool = new ShieldedPoolModule(substrate);
        this.privacy = new PrivacyModule(substrate);
        this.chain = new ChainModule(substrate);
        this.zkVerifier = new ZkVerifierModule(substrate);
        this.circuitVersionResolver = new CircuitVersionResolver(this.zkVerifier, circuitsBaseUrl);
        this.relayerStatus = new RelayerStatusModule(substrate);
        this.precompiles = evm
            ? {
                  shieldedPool: new ShieldedPoolPrecompile(evm),
                  crypto: new CryptoPrecompiles(evm),
              }
            : null;
    }

    /**
     * Creates and connects an `OrbinumClient` from the given configuration.
     *
     * Establishes the Substrate WebSocket connection and, if configured, instantiates
     * the EVM and indexer clients. Throws if the node is unreachable within `connectTimeoutMs`.
     */
    static async connect(config: OrbinumClientConfig): Promise<OrbinumClient> {
        const substrate = await SubstrateClient.connect(
            config.substrateWs,
            config.connectTimeoutMs ?? 15_000
        );
        const evm = config.evmRpc ? new EvmClient(config.evmRpc) : null;
        return new OrbinumClient(substrate, evm, config.circuitsBaseUrl);
    }

    /** Closes the underlying Substrate WebSocket connection and releases all resources. */
    destroy(): void {
        this.substrate.destroy();
    }
}
