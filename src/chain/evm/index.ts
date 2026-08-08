/**
 * The EVM side of the chain.
 *
 * ```
 * EvmClient.ts   the JSON-RPC client
 * explorer/      enriched block, transaction and token queries
 * precompiles/   Orbinum's contracts, reachable from an EVM wallet
 * ```
 *
 * Optional throughout: a wallet that only speaks Substrate never touches this,
 * which is why `OrbinumClient.evm` is nullable rather than throwing.
 */
export { EvmClient } from './EvmClient';
export * from './explorer/index';
export * from './precompiles/index';
