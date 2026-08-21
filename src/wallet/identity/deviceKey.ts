/**
 * The key that protects secrets at rest on one device.
 *
 * A single AES-GCM-256 key, generated once and kept for the life of the install.
 * Where the platform allows it the key must be NON-EXTRACTABLE — created with
 * `extractable: false` and persisted as a key handle rather than as bytes — so
 * a storage dump, disk image or synced profile yields nothing usable.
 *
 * ## Why not derive it from the wallet signature
 *
 * Circular. The thing being protected is the cached identity, and the reason it
 * is cached is to avoid asking for a signature again. A key derived from that
 * signature would require the signature to read the cache that exists to avoid
 * the signature.
 *
 * ## Platform notes
 *
 * Browsers and extensions: `@orbinum/sdk/storage/indexeddb` exports
 * `getOrCreateIndexedDbDeviceKey`, which stores a non-extractable `CryptoKey`
 * via structured clone — the key material never becomes visible to JavaScript.
 *
 * React Native and Node: no non-extractable handle survives a restart, so store
 * raw key bytes in the platform's secure enclave (Keychain, Keystore) and import
 * them with `importDeviceKey`. The isolation then comes from the enclave rather
 * than from the key being unexportable.
 */

/**
 * A fresh AES-GCM-256 device key.
 *
 * `extractable` defaults to false and should stay that way — true is only for
 * the platforms above, which cannot persist a handle and must export bytes into
 * an enclave. Where a handle survives a restart, extractable is strictly worse:
 * the material becomes readable by any code in the context.
 */
export async function generateDeviceKey(extractable = false): Promise<CryptoKey> {
    return crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, extractable, [
        'encrypt',
        'decrypt',
    ]);
}

/**
 * Imports raw device-key bytes, for platforms that persist bytes in a secure
 * enclave rather than a key handle. The imported key is non-extractable, so the
 * bytes cannot be read back out through WebCrypto.
 */
export async function importDeviceKey(raw: Uint8Array): Promise<CryptoKey> {
    if (raw.length !== 32) {
        throw new Error(`Device key must be 32 bytes, got ${raw.length}.`);
    }
    return crypto.subtle.importKey('raw', raw.slice(0), 'AES-GCM', false, ['encrypt', 'decrypt']);
}

/**
 * Where a device key is persisted between launches.
 *
 * `load` returning null means "no key yet", not "failed" — the provider takes
 * that as permission to generate one. An adapter that cannot reach its backend
 * should throw instead, or the first transient failure silently mints a second
 * key and orphans every secret encrypted under the first.
 */
export interface DeviceKeyStore {
    load(): Promise<CryptoKey | null>;
    save(key: CryptoKey): Promise<void>;
}

/** The device key, generating and persisting it on first use. */
export function createDeviceKeyProvider(store: DeviceKeyStore): () => Promise<CryptoKey> {
    let cached: CryptoKey | null = null;
    let inFlight: Promise<CryptoKey> | null = null;

    return async function getOrCreateDeviceKey(): Promise<CryptoKey> {
        if (cached) return cached;
        // Cached per process and shared in flight, because a SECOND key orphans
        // every secret encrypted under the first — silently, and for good.
        if (inFlight) return inFlight;

        inFlight = (async () => {
            const existing = await store.load();
            if (existing) return existing;
            const key = await generateDeviceKey();
            await store.save(key);
            return key;
        })();

        try {
            cached = await inFlight;
            return cached;
        } finally {
            inFlight = null;
        }
    };
}
