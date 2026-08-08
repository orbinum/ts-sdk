/**
 * The unlocked-vault session: the keys that exist only while a wallet is open,
 * and the error raised when something needs them and they are gone.
 */
export { createWalletSession, requireSessionKeys } from './WalletSession';
export type { WalletSession, MutableWalletSession } from './WalletSession';
export { VaultLockedError } from './errors';
