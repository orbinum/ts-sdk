/**
 * Wallet operations: creating notes, spending them, and the marshalling in
 * between.
 *
 * ```
 * notes/      build a note, recover a self-addressed one, move notes between devices
 * spend/      transfer, unshield, fee claim — plus the plan and the pre-flight guards
 * transport/  extrinsic arguments, circuit version, recovery from a dropped submit
 * ```
 *
 * These own PROTOCOL, not transport. Each spend takes a `submit` callback and
 * the host supplies the chain client, which is what lets one implementation
 * serve a browser tab, an extension service worker and a mobile runtime without
 * the SDK knowing which it is running in.
 *
 * What that buys, concretely: a third party spending notes would otherwise have
 * to reimplement the merkle-root reconciliation loop, the cross-tree guard, the
 * change-note key derivation, and the little-endian commitment encoding — each
 * of which fails silently or unrecoverably when guessed wrong.
 */
export * from './notes/index';
export * from './spend/index';
export * from './transport/index';
