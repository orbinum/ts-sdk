/// <reference lib="dom" />
/**
 * A fake IndexedDB good enough to test a vault against.
 *
 * Lives in the SDK so every backend built on IndexedDB drives the same one —
 * two fakes would drift, and a divergence here stays invisible until a real
 * browser disagrees with both.
 *
 * What it models beyond a plain Map, because each one caught a real bug:
 *   - per-store transaction serialisation, so a concurrent read-modify-write
 *     cannot interleave the way a naive fake would allow
 *   - connections dying without close() being called, which is what a browser
 *     does when it evicts storage under pressure
 */
type FakeRequest<T> = IDBRequest<T> & {
    onsuccess: ((this: IDBRequest<T>, ev: Event) => void) | null;
    onerror: ((this: IDBRequest<T>, ev: Event) => void) | null;
    onupgradeneeded?: ((this: IDBOpenDBRequest, ev: Event) => void) | null;
    result: T;
    error: DOMException | null;
};

type FakeStoreMap = Map<string, Map<string, unknown>>;

function createRequest<T>(): FakeRequest<T> {
    return {
        onsuccess: null,
        onerror: null,
        result: undefined as T,
        error: null,
    } as FakeRequest<T>;
}

/**
 * Handle on the fake factory so a test can reproduce what the browser does on
 * its own: kill the live connection (Safari evicting under storage pressure,
 * another tab deleting the DB) without the app ever calling close().
 */
export type FakeIDB = {
    factory: IDBFactory;
    /** Marks every open connection dead — later transaction() throws InvalidStateError. */
    killConnections: () => void;
    /** Same, but also fires onclose, which is the path the browser takes when it can. */
    killConnectionsWithEvent: () => void;
    /** How many times open() was called — proves the retry reopened exactly once. */
    openCount: () => number;
};

export function createFakeIndexedDB(): FakeIDB {
    const databases = new Map<string, FakeStoreMap>();
    const live = new Set<{ db: IDBDatabase; closed: boolean }>();
    let opens = 0;

    /**
     * Per-store lock chain, so overlapping readwrite transactions run one after
     * another instead of interleaving.
     *
     * Real IDB guarantees this: readwrite transactions with overlapping scopes
     * are serialized in creation order, and a transaction holds its scope until
     * it commits. Without modelling it, every concurrent reserveSelfEphIndex()
     * would read the counter before any write lands — the fake would report a
     * collision the browser never produces, and would be unable to show that a
     * single-transaction read-modify-write is what fixes the reuse.
     */
    const locks = new Map<string, Promise<void>>();

    function acquire(names: string[]): { ready: Promise<void>; release: () => void } {
        const prior = Promise.all(names.map((n) => locks.get(n) ?? Promise.resolve()));
        let release!: () => void;
        const done = new Promise<void>((r) => {
            release = r;
        });
        for (const n of names)
            locks.set(
                n,
                prior.then(() => done)
            );
        return { ready: prior.then(() => undefined), release };
    }

    const factory = {
        open(name: string, _version?: number): IDBOpenDBRequest {
            const request = createRequest<IDBDatabase>() as FakeRequest<IDBDatabase>;
            opens += 1;

            setTimeout(() => {
                let stores = databases.get(name);
                const isNew = !stores;
                if (!stores) {
                    stores = new Map();
                    databases.set(name, stores);
                }

                const handle = { db: null as unknown as IDBDatabase, closed: false };

                const db = {
                    objectStoreNames: {
                        contains: (storeName: string) => stores.has(storeName),
                    },
                    createObjectStore: (storeName: string) => {
                        if (!stores.has(storeName)) stores.set(storeName, new Map());
                        return {} as IDBObjectStore;
                    },
                    transaction: (storeName: string | string[]) => {
                        // The real failure mode: a closed connection rejects every
                        // transaction with InvalidStateError, forever.
                        if (handle.closed) {
                            throw Object.assign(
                                new Error(
                                    "Failed to execute 'transaction' on 'IDBDatabase': " +
                                        'The database connection is closing.'
                                ),
                                { name: 'InvalidStateError' }
                            );
                        }
                        const names = Array.isArray(storeName) ? storeName : [storeName];
                        for (const n of names) {
                            if (!stores.has(n)) throw new Error(`Missing store: ${n}`);
                        }

                        const { ready, release } = acquire(names);
                        // Commit (and free the scope) once the caller stops issuing
                        // requests — the same "no pending requests" rule real IDB uses.
                        let pending = 0;
                        let settled = false;
                        const maybeCommit = () => {
                            if (settled || pending > 0) return;
                            settled = true;
                            release();
                        };

                        /** Runs `op` only after the scope is free, keeping the tx open meanwhile. */
                        const enqueue = <T>(op: () => T): FakeRequest<T> => {
                            const req = createRequest<T>();
                            pending += 1;
                            void ready.then(() => {
                                const result = op();
                                pending -= 1;
                                req.result = result;
                                req.onsuccess?.call(req, { target: req } as unknown as Event);
                                // Let the caller chain another request in its onsuccess/await
                                // before we decide the transaction is done.
                                setTimeout(maybeCommit, 0);
                            });
                            return req;
                        };

                        return {
                            objectStore: (target: string) => {
                                const store = stores.get(target) as Map<string, unknown>;
                                return {
                                    get: (key: string) => enqueue(() => store.get(key)),
                                    put: (value: unknown) =>
                                        enqueue(() => {
                                            const key = String(
                                                (
                                                    value as {
                                                        id?: string;
                                                        commitmentTag?: string;
                                                        h?: string;
                                                    }
                                                ).id ??
                                                    (value as { commitmentTag?: string })
                                                        .commitmentTag ??
                                                    (value as { h?: string }).h ??
                                                    (value as { commitmentHex?: string })
                                                        .commitmentHex
                                            );
                                            store.set(key, value);
                                            return key as IDBValidKey;
                                        }),
                                    getAll: () => enqueue(() => [...store.values()]),
                                    delete: (key: string) =>
                                        enqueue(() => {
                                            store.delete(key);
                                            return undefined;
                                        }),
                                    clear: () =>
                                        enqueue(() => {
                                            store.clear();
                                            return undefined;
                                        }),
                                    count: () => enqueue(() => store.size),
                                };
                            },
                        } as unknown as IDBTransaction;
                    },
                    close: () => {
                        handle.closed = true;
                    },
                } as IDBDatabase;

                handle.db = db;
                live.add(handle);
                request.result = db;
                if (isNew) {
                    request.onupgradeneeded?.call(
                        request as IDBOpenDBRequest,
                        { target: request, oldVersion: 0 } as unknown as Event
                    );
                }
                request.onsuccess?.call(request, { target: request } as unknown as Event);
            }, 0);

            return request as IDBOpenDBRequest;
        },

        deleteDatabase(name: string): IDBOpenDBRequest {
            const request = createRequest<IDBDatabase>() as FakeRequest<IDBDatabase>;

            setTimeout(() => {
                databases.delete(name);
                request.onsuccess?.call(request, { target: request } as unknown as Event);
            }, 0);

            return request as IDBOpenDBRequest;
        },
    } as IDBFactory;

    return {
        factory,
        killConnections: () => {
            for (const h of live) h.closed = true;
            live.clear();
        },
        killConnectionsWithEvent: () => {
            for (const h of live) {
                h.closed = true;
                (h.db as unknown as { onclose?: () => void }).onclose?.();
            }
            live.clear();
        },
        openCount: () => opens,
    };
}
