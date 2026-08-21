/// <reference lib="dom" />
/**
 * Promise wrapper for the IndexedDB request API.
 *
 * IndexedDB predates promises and reports through `onsuccess`/`onerror`
 * handlers. Every REQUEST in this subpath goes through here, so the callback
 * shape is written once for reads and writes.
 *
 * Opening a database is the exception and keeps its own handlers: it also needs
 * `onupgradeneeded` to create the object stores, and `onclose`/`onversionchange`
 * to drop a cached connection another tab closed underneath it.
 */

export function idbRequest<T>(req: IDBRequest<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
    });
}
