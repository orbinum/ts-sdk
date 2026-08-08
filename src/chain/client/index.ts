/**
 * Connecting to an Orbinum node.
 *
 * ```
 * OrbinumClient.ts          one connection, every protocol module hanging off it
 * OrbinumClientProvider.ts  that connection kept alive: heartbeat, backoff, status
 * types.ts                  the config both take, and the result every extrinsic returns
 * ```
 *
 * Use `OrbinumClient` directly for a script or a test — it connects once and
 * stays connected as long as the process does. Use the provider for anything
 * long-lived: a tab that sleeps, a phone that changes network, a node that
 * restarts. The provider is what turns those into a status event instead of a
 * dead client nobody noticed.
 */
export * from './OrbinumClient';
export * from './OrbinumClientProvider';
export * from './types';
