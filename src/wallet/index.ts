/**
 * The assembled wallet — keys, vault, scanner and note building wired together.
 *
 * Use the pieces directly (`VaultStore`, `runScan`, `buildZkNote`) when a host
 * needs a different shape; this is the shortest path to a working wallet, not
 * the only one.
 */
export { OrbinumWallet } from './OrbinumWallet';
export type { OrbinumWalletConfig, ScanOptions } from './OrbinumWallet';
