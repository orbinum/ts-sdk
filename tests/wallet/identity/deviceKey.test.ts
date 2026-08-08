/**
 * The device key that protects cached secrets at rest.
 *
 * The property that matters: exactly ONE key per install. Generating a second
 * one silently orphans every secret encrypted under the first, and the symptom
 * is a user who has to re-sign for no visible reason.
 */
import { describe, it, expect, vi } from 'vitest';
import {
    generateDeviceKey,
    importDeviceKey,
    createDeviceKeyProvider,
} from '../../../src/wallet/identity/deviceKey';
import { encryptJson, decryptJson } from '../../../src/index';
import type { DeviceKeyStore } from '../../../src/wallet/identity/deviceKey';

/** A store that keeps the key in memory, like a working platform backend. */
function memoryKeyStore(): DeviceKeyStore & { saves: number } {
    let held: CryptoKey | null = null;
    return {
        saves: 0,
        async load() {
            return held;
        },
        async save(key) {
            held = key;
            this.saves++;
        },
    };
}

describe('generateDeviceKey', () => {
    it('produces a non-extractable AES-GCM key by default', async () => {
        const key = await generateDeviceKey();

        expect(key.extractable).toBe(false);
        expect(key.algorithm).toMatchObject({ name: 'AES-GCM', length: 256 });
        // Non-extractable is the whole point: a storage dump must not yield bytes.
        await expect(crypto.subtle.exportKey('raw', key)).rejects.toThrow();
    });

    it('encrypts and decrypts round-trip', async () => {
        const key = await generateDeviceKey();

        const { iv, ciphertext } = await encryptJson(key, 'secret');

        expect(await decryptJson(key, iv, ciphertext)).toBe('secret');
    });
});

describe('importDeviceKey', () => {
    it('imports raw bytes as a non-extractable key', async () => {
        // For platforms whose secure enclave holds bytes rather than a handle.
        const key = await importDeviceKey(new Uint8Array(32).fill(3));

        expect(key.extractable).toBe(false);
        await expect(crypto.subtle.exportKey('raw', key)).rejects.toThrow();
    });

    it('produces the same key for the same bytes', async () => {
        const bytes = new Uint8Array(32).fill(5);
        const a = await importDeviceKey(bytes);
        const b = await importDeviceKey(bytes);

        const { iv, ciphertext } = await encryptJson(a, 'secret');

        expect(await decryptJson(b, iv, ciphertext)).toBe('secret');
    });

    it('rejects a key of the wrong length', async () => {
        await expect(importDeviceKey(new Uint8Array(16))).rejects.toThrow(/32 bytes/);
    });
});

describe('createDeviceKeyProvider', () => {
    it('generates and persists on first use', async () => {
        const store = memoryKeyStore();
        const getKey = createDeviceKeyProvider(store);

        await getKey();

        expect(store.saves).toBe(1);
    });

    it('reuses the persisted key instead of generating another', async () => {
        // A second key would orphan everything encrypted under the first.
        const store = memoryKeyStore();
        const first = await createDeviceKeyProvider(store)();

        const second = await createDeviceKeyProvider(store)();

        const { iv, ciphertext } = await encryptJson(first, 'secret');
        expect(await decryptJson(second, iv, ciphertext)).toBe('secret');
        expect(store.saves).toBe(1);
    });

    it('reads storage once, then serves from memory', async () => {
        const store = memoryKeyStore();
        const load = vi.spyOn(store, 'load');
        const getKey = createDeviceKeyProvider(store);

        await getKey();
        await getKey();
        await getKey();

        expect(load).toHaveBeenCalledOnce();
    });

    it('generates one key for concurrent first calls', async () => {
        // Two callers racing must not each generate and each persist — the
        // loser's secrets would become unreadable.
        const store = memoryKeyStore();
        const getKey = createDeviceKeyProvider(store);

        const [a, b, c] = await Promise.all([getKey(), getKey(), getKey()]);

        expect(store.saves).toBe(1);
        const { iv, ciphertext } = await encryptJson(a!, 'secret');
        expect(await decryptJson(b!, iv, ciphertext)).toBe('secret');
        expect(await decryptJson(c!, iv, ciphertext)).toBe('secret');
    });

    it('SECURITY: a load() that throws never mints a replacement key', async () => {
        // The contract `DeviceKeyStore.load` documents: null means "no key yet",
        // an unreachable backend must throw. Swallowing that and generating one
        // would orphan every secret encrypted under the real key — the user's
        // cached identity becomes permanently unreadable, silently.
        const save = vi.fn();
        const store: DeviceKeyStore = {
            async load() {
                throw new Error('keychain locked');
            },
            save,
        };
        const getKey = createDeviceKeyProvider(store);

        await expect(getKey()).rejects.toThrow('keychain locked');
        expect(save).not.toHaveBeenCalled();
    });

    it('retries after a failed generation instead of caching the failure', async () => {
        const store: DeviceKeyStore = {
            async load() {
                return null;
            },
            save: vi.fn().mockRejectedValueOnce(new Error('storage full')),
        };
        const getKey = createDeviceKeyProvider(store);

        await expect(getKey()).rejects.toThrow('storage full');
        await expect(getKey()).resolves.toBeDefined();
    });
});
