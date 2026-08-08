/**
 * `@orbinum/sdk/storage/indexeddb` — the browser adapters.
 *
 * Three separate concerns, shipped together because a consumer reaching for
 * browser persistence wants all of them:
 *
 *   VaultStorage.ts    the wallet's notes, in IndexedDB
 *   deviceKeyStore.ts  the per-installation wrapping key, in its own database
 *   secretStore.ts     the cached session blob, in Web Storage (no IndexedDB)
 *
 * Everything here is optional. The interfaces they satisfy live in the root
 * entry, so a host on Node or React Native implements its own and never loads
 * this subpath.
 */
export { IndexedDbVaultStorage } from './VaultStorage';
export type { IndexedDbVaultStorageOptions } from './VaultStorage';
export { createIndexedDbDeviceKeyStore, getOrCreateIndexedDbDeviceKey } from './deviceKeyStore';
export { createWebStorageSecretStore } from './secretStore';
