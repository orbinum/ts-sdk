/// <reference lib="dom" />
/**
 * The per-installation device key, kept in IndexedDB.
 *
 * A non-extractable `CryptoKey` that never leaves the browser: it wraps the
 * cached session secret so a stored blob is useless on any other device. Stored
 * in its OWN database, separate from the vault, because it is not per-account —
 * one installation has one device key regardless of how many wallets it opens.
 *
 * Non-extractable is the point. The raw bytes cannot be read back out even by
 * this code, so a compromised page cannot exfiltrate the key itself.
 */
import { createDeviceKeyProvider } from '../../wallet/identity/deviceKey';
import type { DeviceKeyStore } from '../../wallet/identity/deviceKey';
import { idbRequest } from './idb';

const KEYSTORE_DB = 'orbinum-keystore';
const KEYSTORE_STORE = 'keys';
const DEVICE_KEY_ID = 'device';

/**
 * A `DeviceKeyStore` backed by a tiny dedicated IndexedDB.
 *
 * IndexedDB rather than localStorage because it stores a `CryptoKey` HANDLE via
 * structured clone. The key is generated non-extractable, so its material never
 * becomes visible to JavaScript — a storage dump yields an opaque handle, not
 * bytes. localStorage can only hold strings, which would mean exporting the key.
 *
 * Its own database, separate from the vault: the device key outlives any single
 * vault and must survive one being dropped.
 */
export function createIndexedDbDeviceKeyStore(indexedDBFactory?: IDBFactory): DeviceKeyStore {
    const idb = indexedDBFactory ?? globalThis.indexedDB;
    if (!idb) throw new Error('IndexedDB is unavailable; supply a different DeviceKeyStore.');

    const open = () =>
        new Promise<IDBDatabase>((resolve, reject) => {
            const req = idb.open(KEYSTORE_DB, 1);
            req.onupgradeneeded = () => {
                const db = req.result;
                if (!db.objectStoreNames.contains(KEYSTORE_STORE)) {
                    db.createObjectStore(KEYSTORE_STORE, { keyPath: 'id' });
                }
            };
            req.onsuccess = () => resolve(req.result);
            req.onerror = () =>
                reject(new Error(`Failed to open keystore: ${String(req.error?.message)}`));
        });

    return {
        async load() {
            const db = await open();
            try {
                const row = await idbRequest<{ id: string; key: CryptoKey } | undefined>(
                    db
                        .transaction(KEYSTORE_STORE, 'readonly')
                        .objectStore(KEYSTORE_STORE)
                        .get(DEVICE_KEY_ID)
                );
                return row?.key ?? null;
            } finally {
                db.close();
            }
        },
        async save(key) {
            const db = await open();
            try {
                await idbRequest(
                    db
                        .transaction(KEYSTORE_STORE, 'readwrite')
                        .objectStore(KEYSTORE_STORE)
                        .put({ id: DEVICE_KEY_ID, key })
                );
            } finally {
                db.close();
            }
        },
    };
}

/**
 * The browser device key, generated and persisted on first use.
 *
 * The store is built on the FIRST CALL, not at import time: an extension's
 * service worker and a test environment can both import this module before
 * IndexedDB is reachable, and failing there would take down everything that
 * merely imports the entry point.
 */
export const getOrCreateIndexedDbDeviceKey = createDeviceKeyProvider({
    load: () => createIndexedDbDeviceKeyStore().load(),
    save: (key) => createIndexedDbDeviceKeyStore().save(key),
});
