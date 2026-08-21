/**
 * Who the user is on this device, and where that survives between launches.
 *
 * ```
 * sessionCache.ts        the derived identity, encrypted at rest
 * deviceKey.ts           the key that encrypts it — one per install, never derived from a signature
 * secretStore.ts         where a host puts small secrets; three methods, one adapter per platform
 * vaultName.ts           the vault's name, which must match the key derivation
 * injectedExtensions.ts  browser wallet discovery, guarded for hosts with no page
 * ```
 *
 * The platform-specific halves are injected — where secrets go, and what key
 * protects them — so an extension, a mobile app and a web page share the logic
 * and differ only in the adapter. `@orbinum/sdk/storage/indexeddb` supplies the
 * browser ones.
 *
 * The pieces are interdependent in one direction worth knowing: the cache key
 * and the vault name both canonicalise the account the same way the spending-key
 * derivation does. Get one of the three out of step and a wallet derives the
 * right key but opens the wrong vault, with an empty balance and nothing to
 * explain it.
 */
export { createMemorySecretStore } from './secretStore';
export type { SecretStore } from './secretStore';
export {
    hasCachedSession,
    cacheSession,
    restoreSession,
    clearSession,
    sessionCacheKey,
} from './sessionCache';
export type { SessionCacheDeps } from './sessionCache';
export { generateDeviceKey, importDeviceKey, createDeviceKeyProvider } from './deviceKey';
export type { DeviceKeyStore } from './deviceKey';
export { vaultStorageName } from './vaultName';
export type { IdentityVersion } from './vaultName';
export { deriveIdentity, exportViewingCredential } from './walletIdentity';
export type { WalletIdentity, ViewingCredential } from './walletIdentity';
export {
    connectInjectedExtension,
    getInjectedExtensions,
    hasInjectedExtensions,
} from './injectedExtensions';
