/**
 * Ephemeral-index reservation against the REAL browser backend.
 *
 * Every other test of the counters drives `MemoryVaultStorage`, whose
 * `updateConfig` is a promise chain over a plain object. The browser backend is
 * neither: it is an IndexedDB read-modify-write inside one readwrite
 * transaction, and the values it hands back have been through structured
 * clone. Two properties only this backend can prove:
 *
 *   - **serialisation** — concurrent reservations must not both read the same
 *     counter. A lost increment here is not a lost UI update, it is two notes
 *     deriving the same ephemeral index and publishing one ephPk twice.
 *   - **survival of the round trip** — the sanitising guards exist because the
 *     config comes back as whatever was on disk, so the corrupt values have to
 *     be written through the real store rather than injected into an object.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { IndexedDbVaultStorage } from '../../../src/adapters/indexeddb/index';
import {
    reserveSelfEphIndex,
    reserveOutgoingIndex,
    registerPairwiseCounterparty,
} from '../../../src/wallet/vault/storage/ephemeralIndex';
import { buildConfig } from '../../../src/wallet/vault/storage/config';
import { createFakeIndexedDB, type FakeIDB } from './fakeIndexedDB';
import type { VaultConfigRecord } from '../../../src/wallet/vault/storage/contract';

const IVK = '0xAABB';

let idb: FakeIDB;
let storage: IndexedDbVaultStorage;

beforeEach(async () => {
    idb = createFakeIndexedDB();
    storage = new IndexedDbVaultStorage({ name: 'vault', indexedDB: idb.factory });
    await storage.putConfig(buildConfig(null));
});

/** Write a config field straight to the store, as a restore or migration would. */
async function poison(mutate: (config: Record<string, unknown>) => void): Promise<void> {
    const config = (await storage.getConfig()) as unknown as Record<string, unknown>;
    mutate(config);
    await storage.putConfig(config as unknown as VaultConfigRecord);
}

describe('reservation through the IndexedDB backend', () => {
    it('never hands the same self index to two concurrent callers', async () => {
        // The transaction is what makes this hold: a getConfig/putConfig pair
        // would let both callers read the same counter and the second write win.
        const indexes = await Promise.all(
            Array.from({ length: 50 }, () => reserveSelfEphIndex(storage))
        );

        expect(new Set(indexes).size).toBe(50);
    });

    it('never hands the same outgoing index to two concurrent callers', async () => {
        const indexes = await Promise.all(
            Array.from({ length: 50 }, () => reserveOutgoingIndex(storage))
        );

        expect(new Set(indexes).size).toBe(50);
    });

    it('registers counterparties across the round trip', async () => {
        await registerPairwiseCounterparty(storage, '0xa1');
        await registerPairwiseCounterparty(storage, '0xb2');

        const parties = (await storage.getConfig())?.pairwiseCounterparties ?? {};
        expect(Object.keys(parties).sort()).toEqual(['0xa1', '0xb2']);
    });

    it('restarts a corrupt self counter that came back from the store', async () => {
        // Written through putConfig and read back through the store, so the
        // value survives whatever the backend does to it on the way.
        await poison((c) => {
            c['selfEphCounter'] = 2.5;
        });

        expect(await reserveSelfEphIndex(storage)).toBe(0);
        expect(await reserveSelfEphIndex(storage)).toBe(1);
    });

    it('restarts a corrupt outgoing counter that came back from the store', async () => {
        await poison((c) => {
            c['outgoingEphCounter'] = NaN;
        });

        expect(await reserveOutgoingIndex(storage)).toBe(0);
        expect(await reserveOutgoingIndex(storage)).toBe(1);
    });

    it('a valid stored counter resumes rather than restarting', async () => {
        // The guards must not fire on good data: restarting a live counter is
        // the leak, reached by the fix itself.
        await poison((c) => {
            c['selfEphCounter'] = 7;
            c['outgoingEphCounter'] = 9;
        });

        expect(await reserveSelfEphIndex(storage)).toBe(7);
        expect(await reserveOutgoingIndex(storage)).toBe(9);
    });

    it('survives the connection dying mid-reservation', async () => {
        // A browser evicts storage under pressure, killing the connection
        // without close(). The retry must not lose or repeat an index.
        await reserveSelfEphIndex(storage);
        idb.killConnections();

        const after = await reserveSelfEphIndex(storage);
        expect(after).toBe(1);
    });
});
