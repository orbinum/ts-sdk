/// <reference lib="dom" />
/**
 * Promise wrapper for the IndexedDB request API.
 *
 * IndexedDB predates promises and reports through `onsuccess`/`onerror`
 * handlers. Every call in this subpath goes through here so the callback shape
 * appears exactly once.
 */

export function idbRequest<T>(req: IDBRequest<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
    });
}
