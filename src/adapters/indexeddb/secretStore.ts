/// <reference lib="dom" />
/**
 * A `SecretStore` over Web Storage.
 *
 * No IndexedDB involved — it ships from this entry point because a consumer
 * reaching for browser persistence wants both adapters together, and splitting
 * them across two subpaths would buy nothing.
 */
import type { SecretStore } from '../../wallet/identity/secretStore';

/**
 * A `SecretStore` over Web Storage.
 *
 * Reads fall back to `sessionStorage` so a value written by an older build, or
 * by a deliberately session-scoped flow, is still found. Writes always go to the
 * durable store and clear the session copy, so one key never lives in both.
 *
 * Values are encrypted before they arrive here — see `sessionCache`.
 */
export function createWebStorageSecretStore(
    storage?: Storage,
    sessionStorageArea?: Storage | null
): SecretStore {
    // Resolved per call, not at construction: an extension service worker or a
    // test environment may import this module before Web Storage exists, and
    // throwing then would break everything that merely imports the entry point.
    const durable = () => {
        const area = storage ?? globalThis.localStorage;
        if (!area) throw new Error('Web Storage is unavailable; supply a different SecretStore.');
        return area;
    };
    const session = () =>
        sessionStorageArea === undefined ? (globalThis.sessionStorage ?? null) : sessionStorageArea;

    return {
        async get(key) {
            return durable().getItem(key) ?? session()?.getItem(key) ?? null;
        },
        async set(key, value) {
            durable().setItem(key, value);
            session()?.removeItem(key);
        },
        async remove(key) {
            durable().removeItem(key);
            session()?.removeItem(key);
        },
        async keys() {
            const all = new Set<string>(Object.keys(durable()));
            const area = session();
            if (area) for (const k of Object.keys(area)) all.add(k);
            return [...all];
        },
    };
}
