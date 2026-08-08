/**
 * `IndexedDbVaultStorage` — the browser backend, driven through the shared
 * `VaultStorage` conformance suite plus the behaviours only IndexedDB has.
 *
 * Running the same suite that `MemoryVaultStorage` runs is the point: a contract
 * verified against one backend only describes that backend. The connection-death
 * tests below are the part memory can never exercise, and the reason the retry
 * exists at all.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import {
    IndexedDbVaultStorage,
    createWebStorageSecretStore,
} from '../../../src/adapters/indexeddb/index';
import {
    testVaultStorageConformance,
    emptyConfig,
    noteRecord,
} from '../../wallet/vault/storage/storageConformance';
import { createFakeIndexedDB, type FakeIDB } from './fakeIndexedDB';

let fake: FakeIDB;

testVaultStorageConformance('IndexedDbVaultStorage', () => {
    fake = createFakeIndexedDB();
    return new IndexedDbVaultStorage({ name: 'conformance', indexedDB: fake.factory });
});

describe('IndexedDbVaultStorage — connection lifecycle', () => {
    let idb: FakeIDB;
    let storage: IndexedDbVaultStorage;

    beforeEach(async () => {
        idb = createFakeIndexedDB();
        storage = new IndexedDbVaultStorage({ name: 'vault', indexedDB: idb.factory });
        await storage.putConfig(emptyConfig());
    });

    it('reuses one connection across calls', async () => {
        await storage.getConfig();
        await storage.getConfig();
        await storage.getAllNoteRecords();

        expect(idb.openCount()).toBe(1);
    });

    it('recovers from a connection the browser killed silently', async () => {
        // Storage eviction can kill a handle without onclose ever firing, which
        // is why the retry — not the event — is what makes this self-healing.
        idb.killConnections();

        await expect(storage.getConfig()).resolves.toEqual(emptyConfig());
        expect(idb.openCount()).toBe(2);
    });

    it('recovers when the close event does fire', async () => {
        idb.killConnectionsWithEvent();

        await expect(storage.getConfig()).resolves.toEqual(emptyConfig());
    });

    it('reopens exactly once per dead connection, not on every call', async () => {
        idb.killConnections();
        await storage.getConfig();
        await storage.getConfig();
        await storage.getConfig();

        expect(idb.openCount()).toBe(2);
    });

    it('surfaces a non-connection error instead of retrying it', async () => {
        // Retrying a real failure would hide it behind a second identical one.
        const broken = new IndexedDbVaultStorage({
            name: 'vault',
            indexedDB: {
                open: () => {
                    throw new Error('quota exceeded');
                },
            } as unknown as IDBFactory,
        });

        await expect(broken.getConfig()).rejects.toThrow('quota exceeded');
    });

    it('reopens after an explicit close', async () => {
        storage.close();

        await expect(storage.getConfig()).resolves.toEqual(emptyConfig());
        expect(idb.openCount()).toBe(2);
    });
});

describe('browser adapters — construction is lazy', () => {
    /**
     * Importing this entry must not require a browser API to be present yet.
     * An extension's service worker and a test environment both import modules
     * before their storage is reachable, and a module-level throw would take
     * down everything that merely imports the entry point — not just the code
     * that uses the adapter.
     */
    it('builds a secret store before Web Storage is reachable', async () => {
        // A service worker imports its modules before storage is available.
        // Construction must survive that; only USING it should fail, and only
        // until the area appears.
        let area: Storage | undefined;
        const store = createWebStorageSecretStore(
            // Resolved per call, so a later-arriving area is picked up.
            new Proxy({} as Storage, {
                get: (_t, prop) => {
                    if (!area) throw new Error('Web Storage is unavailable; not ready yet');
                    return Reflect.get(area, prop, area);
                },
            }),
            null
        );

        await expect(store.get('k')).rejects.toThrow(/Web Storage is unavailable/);

        const entries = new Map<string, string>();
        area = {
            getItem: (k: string) => entries.get(k) ?? null,
            setItem: (k: string, v: string) => void entries.set(k, v),
            removeItem: (k: string) => void entries.delete(k),
        } as unknown as Storage;

        await store.set('k', 'v');
        expect(await store.get('k')).toBe('v');
    });

    it('uses an injected storage area', async () => {
        const entries = new Map<string, string>();
        const fake = {
            getItem: (k: string) => entries.get(k) ?? null,
            setItem: (k: string, v: string) => void entries.set(k, v),
            removeItem: (k: string) => void entries.delete(k),
        } as unknown as Storage;

        const store = createWebStorageSecretStore(fake, null);
        await store.set('a', '1');

        expect(await store.get('a')).toBe('1');
        await store.remove('a');
        expect(await store.get('a')).toBeNull();
    });

    it('reads a value left in session storage but writes to the durable area', async () => {
        // A value written by an older build, or by a deliberately session-scoped
        // flow, must still be found — and must not end up living in both.
        const durable = new Map<string, string>();
        const session = new Map<string, string>([['k', 'from-session']]);
        const area = (m: Map<string, string>) =>
            ({
                getItem: (k: string) => m.get(k) ?? null,
                setItem: (k: string, v: string) => void m.set(k, v),
                removeItem: (k: string) => void m.delete(k),
            }) as unknown as Storage;

        const store = createWebStorageSecretStore(area(durable), area(session));

        expect(await store.get('k')).toBe('from-session');
        await store.set('k', 'fresh');
        expect(durable.get('k')).toBe('fresh');
        expect(session.has('k')).toBe(false);
    });
});

describe('IndexedDbVaultStorage — construction', () => {
    it('throws when IndexedDB is unavailable rather than failing later', async () => {
        // A wallet on Node with no adapter passed should learn that at
        // construction, not on its first write.
        expect(
            () =>
                new IndexedDbVaultStorage({
                    name: 'vault',
                    indexedDB: undefined as unknown as IDBFactory,
                })
        ).toThrow(/IndexedDB is unavailable/);
    });

    it('keeps separate databases isolated', async () => {
        // One vault per (chain, account): a wallet must never read notes that
        // belong to a different chain or a different key.
        const idb = createFakeIndexedDB();
        const a = new IndexedDbVaultStorage({ name: 'vault-a', indexedDB: idb.factory });
        const b = new IndexedDbVaultStorage({ name: 'vault-b', indexedDB: idb.factory });

        await a.putConfig(emptyConfig());
        await a.putNotes([noteRecord('tag-a')]);

        expect(await b.getConfig()).toBeNull();
        expect(await b.getAllNoteRecords()).toEqual([]);
    });
});
