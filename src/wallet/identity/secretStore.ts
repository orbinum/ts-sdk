/**
 * Where a host keeps small secrets between sessions.
 *
 * Three methods, because that is all the identity cache needs and every platform
 * has them: `localStorage` in a page, `chrome.storage.local` in an extension,
 * Keychain or SharedPreferences on mobile, a file on a server. Keeping the
 * surface this small is what makes those adapters a few lines each.
 *
 * Values handed to `set` are already ENCRYPTED — see `sessionCache`. A store is
 * not trusted with plaintext secrets, so a backend with weak isolation is still
 * a safe place to put one.
 */
export interface SecretStore {
    get(key: string): Promise<string | null>;
    set(key: string, value: string): Promise<void>;
    remove(key: string): Promise<void>;
    /**
     * Keys currently held. Needed to clear every network's cache for one account
     * on disconnect, which cannot be done by constructing keys — the caller does
     * not know which chains the user has visited.
     */
    keys(): Promise<string[]>;
}

/**
 * An in-memory `SecretStore`. Loses everything on restart, which is the whole
 * point of the real ones — useful for tests and for a host that deliberately
 * wants re-signing on every launch.
 */
export function createMemorySecretStore(): SecretStore {
    const entries = new Map<string, string>();
    return {
        async get(key) {
            return entries.get(key) ?? null;
        },
        async set(key, value) {
            entries.set(key, value);
        },
        async remove(key) {
            entries.delete(key);
        },
        async keys() {
            return [...entries.keys()];
        },
    };
}
