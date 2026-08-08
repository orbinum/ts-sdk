/**
 * The same wallet on a platform that is NOT a browser.
 *
 * This exists to prove one claim: the only browser-specific parts of an Orbinum
 * wallet are three small adapters, and swapping them is all it takes to run on
 * an extension's service worker, on React Native, or on a server. Nothing here
 * touches `localStorage`, `indexedDB`, `window` or `navigator`.
 *
 * What a real port replaces:
 *
 *   | Adapter          | Browser                    | Extension            | Mobile              |
 *   |------------------|----------------------------|----------------------|---------------------|
 *   | `VaultStorage`   | `IndexedDbVaultStorage`    | same (IndexedDB)     | SQLite / MMKV       |
 *   | `SecretStore`    | `createWebStorageSecretStore` | `chrome.storage.local` | Keychain / Keystore |
 *   | `DeviceKeyStore` | `createIndexedDbDeviceKeyStore` | same             | secure enclave      |
 *
 * The identity logic on top — the encrypted envelope, the per-(chain, account)
 * scoping, deleting a cache that will not decrypt — is shared, so a port cannot
 * accidentally skip it.
 */
import {
    OrbinumWallet,
    MemoryVaultStorage,
    createMemorySecretStore,
    createDeviceKeyProvider,
    cacheSession,
    restoreSession,
    hasCachedSession,
    clearSession,
    vaultStorageName,
    PrivacyKeyManager,
    deriveSpendingKeyFromMaster,
} from '@orbinum/sdk';
import { createDecryptPool } from '@orbinum/sdk/worker';
import type { DeviceKeyStore, SecretStore, CryptoKey } from '@orbinum/sdk';

const CHAIN_ID = 42;
const ADDRESS = '0x1234567890abcdef1234567890abcdef12345678';
const MASTER = new Uint8Array(32).fill(7);

/**
 * A device-key store for a platform with no IndexedDB.
 *
 * A real mobile port persists the key bytes in the secure enclave and imports
 * them with `importDeviceKey`; a real extension keeps using IndexedDB, which
 * holds a non-extractable handle. Held in memory here so the example stays
 * dependency-free.
 */
function inMemoryDeviceKeyStore(): DeviceKeyStore {
    let held: CryptoKey | null = null;
    return {
        async load() {
            return held;
        },
        async save(key) {
            held = key;
        },
    };
}

/** Proves the identity survives a restart, using only the injected adapters. */
async function identityRoundTrip(store: SecretStore, deviceKey: CryptoKey) {
    const manager = new PrivacyKeyManager();
    await manager.load(deriveSpendingKeyFromMaster(MASTER), MASTER);

    await cacheSession({ store, deviceKey }, ADDRESS, CHAIN_ID, manager.exportHex());
    console.log(`cached identity for chain ${CHAIN_ID}`);

    // A fresh launch: nothing in memory, everything read back from the store.
    const restored = await restoreSession({ store, deviceKey }, ADDRESS, CHAIN_ID);
    if (restored === null) throw new Error('identity did not survive the restart');

    const reloaded = new PrivacyKeyManager();
    await reloaded.importFromHex(restored);
    if (reloaded.getSpendingKey() !== manager.getSpendingKey()) {
        throw new Error('restored identity does not match the cached one');
    }
    console.log('identity restored without re-signing');

    // The chain is part of the identity: another network must not restore this
    // one, or the user gets an empty vault with nothing to explain it.
    if (await hasCachedSession(store, ADDRESS, CHAIN_ID + 1)) {
        throw new Error('a different chain restored this identity');
    }
    console.log('other networks correctly see no cached identity');

    return manager;
}

async function main() {
    const store = createMemorySecretStore();
    const getDeviceKey = createDeviceKeyProvider(inMemoryDeviceKeyStore());
    const deviceKey = await getDeviceKey();

    // The cached identity is encrypted at rest: the raw stored value must not
    // contain the exported key, whatever backend holds it.
    const manager = await identityRoundTrip(store, deviceKey);
    const [key] = await store.keys();
    const stored = await store.get(key!);
    if (stored!.includes(manager.exportHex())) {
        throw new Error('the identity was stored in the clear');
    }
    console.log('stored value is ciphertext, not the key');

    // The vault name comes from the SDK so it always agrees with the derivation.
    const name = vaultStorageName(ADDRESS, '0xGENESIS');
    console.log(`vault name: ${name}`);

    const wallet = new OrbinumWallet({
        storage: new MemoryVaultStorage(), // a real port: SQLite, MMKV, IndexedDB
        hints: { async listHints({ limit }) { return { data: [], pagination: { limit, total: 0 } }; } },
        nullifiers: {
            async manifest() { return { generation: '1', chunks: [] }; },
            async chunk() { return { data: [] }; },
            async tail() { return { afterChunks: 0, data: [] }; },
        },
        pool: createDecryptPool({ factory: null }),
    });

    await wallet.unlock(MASTER);
    const { ownerPk } = wallet.privacyKeys();
    console.log(`wallet unlocked, ownerPk 0x${ownerPk.toString(16).slice(0, 16)}…`);

    await clearSession(store, ADDRESS);
    if (await hasCachedSession(store, ADDRESS, CHAIN_ID)) {
        throw new Error('disconnect left a cached identity behind');
    }
    console.log('disconnect cleared every network');

    console.log('\nOK — no browser API used');
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
