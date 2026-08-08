import { SubstrateClient } from '../substrate/SubstrateClient';
import { EvmClient } from '../evm/EvmClient';
import { EvmExplorer } from '../evm/explorer/EvmExplorer';
import { ShieldedPoolModule } from '../pallet/shielded-pool/ShieldedPoolModule';
import { ChainModule } from '../rpc/ChainModule';
import { PrivacyModule } from '../rpc/PrivacyModule';
import { ZkVerifierModule } from '../pallet/zk-verifier/ZkVerifierModule';
import { CircuitVersionResolver } from '../../protocol/circuit-version/index';
import { RelayerStatusModule } from '../pallet/relayer/RelayerStatusModule';
import { ShieldedPoolPrecompile } from '../evm/precompiles/ShieldedPoolPrecompile';
import { CryptoPrecompiles } from '../evm/precompiles/CryptoPrecompiles';
import type { OrbinumClientConfig } from './types';

export type { OrbinumClientConfig };

/**
 * One connection to an Orbinum node, with every protocol module hanging off it.
 *
 * Built once and held: each module below shares the same transport, so creating
 * a second client means a second WebSocket and two views of chain state that
 * can disagree. An application that already manages its own PAPI connection
 * should pass it as `papi` rather than opening another.
 *
 * For anything long-lived, prefer `OrbinumClientProvider` — this class has no
 * heartbeat and no reconnection, so a dropped connection surfaces only as
 * failing requests.
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
 * // Shield tokens (with a SubstrateSigner)
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
    /** The transport every module below shares. Use directly for RPC this SDK does not wrap. */
    readonly substrate: SubstrateClient;
    /** `null` when `evmRpc` was not configured. */
    readonly evm: EvmClient | null;
    /** Enriched block/tx/address queries. `null` when `evmRpc` was not configured. */
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
     * The shielded pool reached from an EVM wallet instead of a Substrate one.
     *
     * `null` when `evmRpc` was not configured — the whole group, so a caller
     * checks once rather than per method.
     */
    readonly precompiles: {
        /** `ShieldedPoolPrecompile` at `0x0801`: shield / unshield / transfer via EVM wallet. */
        shieldedPool: ShieldedPoolPrecompile;
        /** Built-in cryptographic precompiles: ECRecover, Keccak-256, Curve25519. */
        crypto: CryptoPrecompiles;
    } | null;

    /** @internal Private because construction cannot connect — use `connect()`. */
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
     * Connects, or throws if the node does not answer within `connectTimeoutMs`.
     *
     * An adopted `papi` client skips the handshake entirely — it is already
     * connected, and re-probing it would only add latency to every startup.
     */
    static async connect(config: OrbinumClientConfig): Promise<OrbinumClient> {
        const substrate = config.papi
            ? SubstrateClient.adopt(config.papi, config.substrateHttp)
            : await SubstrateClient.connect(config.substrateWs, config.connectTimeoutMs ?? 15_000);
        const evm = config.evmRpc ? new EvmClient(config.evmRpc) : null;
        return new OrbinumClient(substrate, evm, config.circuitsBaseUrl);
    }

    /**
     * Releases resources held by this client.
     *
     * A PAPI client passed in via `papi` is left running — it belongs to the
     * caller, and the rest of their application may still be using it.
     */
    destroy(): void {
        this.substrate.destroy();
    }
}
