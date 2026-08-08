/**
 * The cached privacy identity.
 *
 * Two properties carry real cost if they break. The cache must be scoped by
 * chain AND account, because the spending key is derived from both — a shared
 * key restores one network's identity into another and shows an empty vault with
 * nothing to explain it. And a cache that cannot be decrypted must be deleted,
 * or the failure repeats on every launch forever.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import {
    cacheSession,
    restoreSession,
    clearSession,
    hasCachedSession,
    sessionCacheKey,
} from '../../../src/wallet/identity/sessionCache';
import { createMemorySecretStore } from '../../../src/wallet/identity/secretStore';
import { generateDeviceKey } from '../../../src/wallet/identity/deviceKey';
import { canonicalAccountId } from '../../../src/protocol/keys/accountIdentity';
import type { SecretStore } from '../../../src/wallet/identity/secretStore';

const ADDRESS = '0x1234567890abcdef1234567890abcdef12345678';
const IDENTITY = 'mk:0x' + 'ab'.repeat(32);

describe('sessionCacheKey', () => {
    it('scopes by chain, so one network cannot restore another', () => {
        // The chainId is folded into the key derivation, so the same wallet is a
        // DIFFERENT identity per network.
        expect(sessionCacheKey(ADDRESS, 1)).not.toBe(sessionCacheKey(ADDRESS, 2));
    });

    it('canonicalises the account the same way the derivation does', () => {
        // Keying by the raw string would file one identity under two names when a
        // wallet re-lists the account differently — same key, different vault.
        expect(sessionCacheKey(ADDRESS.toUpperCase(), 1)).toBe(sessionCacheKey(ADDRESS, 1));
        expect(sessionCacheKey(ADDRESS, 1)).toContain(canonicalAccountId(ADDRESS));
    });
});

describe('session cache', () => {
    let store: SecretStore;
    let deviceKey: CryptoKey;

    beforeEach(async () => {
        store = createMemorySecretStore();
        deviceKey = await generateDeviceKey();
    });

    const deps = () => ({ store, deviceKey });

    it('round-trips an identity', async () => {
        await cacheSession(deps(), ADDRESS, 1, IDENTITY);

        expect(await restoreSession(deps(), ADDRESS, 1)).toBe(IDENTITY);
    });

    it('stores the identity encrypted, never in the clear', async () => {
        await cacheSession(deps(), ADDRESS, 1, IDENTITY);

        const raw = await store.get(sessionCacheKey(ADDRESS, 1));
        expect(raw).not.toBeNull();
        expect(raw).not.toContain(IDENTITY);
        expect(JSON.parse(raw!)).toMatchObject({ v: 1 });
    });

    it('returns null for an account with no cache', async () => {
        expect(await restoreSession(deps(), ADDRESS, 1)).toBeNull();
    });

    it('does not restore one chain onto another', async () => {
        await cacheSession(deps(), ADDRESS, 1, IDENTITY);

        expect(await restoreSession(deps(), ADDRESS, 2)).toBeNull();
    });

    it('reports whether a cache exists without decrypting', async () => {
        expect(await hasCachedSession(store, ADDRESS, 1)).toBe(false);

        await cacheSession(deps(), ADDRESS, 1, IDENTITY);

        expect(await hasCachedSession(store, ADDRESS, 1)).toBe(true);
    });

    it('deletes a cache it cannot decrypt, so the failure does not repeat', async () => {
        // The device key was regenerated — a browser profile reset, a reinstall.
        // Leaving the envelope behind means failing identically on every launch.
        await cacheSession(deps(), ADDRESS, 1, IDENTITY);
        const otherKey = await generateDeviceKey();

        const restored = await restoreSession({ store, deviceKey: otherKey }, ADDRESS, 1);

        expect(restored).toBeNull();
        expect(await store.get(sessionCacheKey(ADDRESS, 1))).toBeNull();
    });

    it('deletes a corrupt envelope', async () => {
        await store.set(sessionCacheKey(ADDRESS, 1), 'not json at all');

        expect(await restoreSession(deps(), ADDRESS, 1)).toBeNull();
        expect(await store.get(sessionCacheKey(ADDRESS, 1))).toBeNull();
    });

    it('deletes an envelope of an unknown shape', async () => {
        await store.set(sessionCacheKey(ADDRESS, 1), JSON.stringify({ v: 99, data: 'x' }));

        expect(await restoreSession(deps(), ADDRESS, 1)).toBeNull();
    });
});

describe('clearSession', () => {
    let store: SecretStore;
    let deviceKey: CryptoKey;

    beforeEach(async () => {
        store = createMemorySecretStore();
        deviceKey = await generateDeviceKey();
        for (const chainId of [1, 2, 3]) {
            await cacheSession({ store, deviceKey }, ADDRESS, chainId, IDENTITY);
        }
    });

    it('drops one network when given a chainId', async () => {
        await clearSession(store, ADDRESS, 2);

        expect(await hasCachedSession(store, ADDRESS, 1)).toBe(true);
        expect(await hasCachedSession(store, ADDRESS, 2)).toBe(false);
        expect(await hasCachedSession(store, ADDRESS, 3)).toBe(true);
    });

    it('drops every network without one — what disconnecting means', async () => {
        // The user is leaving the account entirely, not switching chains. The
        // caller cannot construct these keys: it does not know which networks
        // were visited, which is why SecretStore has to expose its keys.
        await clearSession(store, ADDRESS);

        for (const chainId of [1, 2, 3]) {
            expect(await hasCachedSession(store, ADDRESS, chainId)).toBe(false);
        }
    });

    it('leaves other accounts alone', async () => {
        const other = '0xfedcba9876543210fedcba9876543210fedcba98';
        await cacheSession({ store, deviceKey }, other, 1, IDENTITY);

        await clearSession(store, ADDRESS);

        expect(await hasCachedSession(store, other, 1)).toBe(true);
    });

    it('leaves unrelated keys alone', async () => {
        await store.set('some-other-app-key', 'value');

        await clearSession(store, ADDRESS);

        expect(await store.get('some-other-app-key')).toBe('value');
    });
});
