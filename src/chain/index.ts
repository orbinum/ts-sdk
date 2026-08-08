/**
 * Talking to the chain.
 *
 * ```
 * client/     OrbinumClient and the provider that keeps one alive
 * substrate/  the WebSocket transport and extrinsic decoding
 * evm/        the EVM JSON-RPC client, its explorer and the precompiles
 * rpc/        Orbinum's custom endpoints — privacy_*, chain_*
 * pallet/     the pallets: shielded-pool, zk-verifier, relayer
 * tx.ts       submitting an extrinsic and reading the outcome
 * ```
 *
 * Everything here needs a connection. The protocol layer below does not, which
 * is what lets a wallet build, decrypt and select notes with no node in reach —
 * only spending and scanning cross into this layer.
 *
 * `pallet/` holds the modules that MOVE notes on chain; what a note IS lives in
 * `protocol/`. The split matters because a rotation of the pallet's extrinsic
 * shapes must not touch the note format, and vice versa.
 */
export * from './client/index';
export * from './substrate/index';
export * from './evm/index';
export * from './rpc/index';
export * from './pallet/shielded-pool/index';
export * from './pallet/zk-verifier/index';
export * from './pallet/relayer/index';
export { signAndSubmitTx, toTxResult } from './tx';
export type { SubmitOptions, UnsafeTx, UnsafeTxOptions } from './tx';
