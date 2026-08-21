/// <reference lib="dom" />
/**
 * A `SecretStore` over Web Storage.
 *
 * No IndexedDB involved — it ships from this entry point because a consumer
 * reaching for browser persistence wants both adapters together, and splitting
 * them across two subpaths would buy nothing.
 *
 * Values arrive already encrypted; see `sessionCache`.
 */
import type { SecretStore } from '../../wallet/identity/secretStore';

/**
 * Durable by default, with `sessionStorage` as a READ fallback so a value left
 * by an older build or a session-scoped flow is still found.
 *
 * Every write goes to the durable area and drops the session copy, so one key
 * never lives in both and a stale session value cannot shadow a fresh one.
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
