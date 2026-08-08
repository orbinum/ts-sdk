/**
 * Caching a derived privacy identity between sessions.
 *
 * Without this the user signs on every launch, and on Substrate that is worse
 * than an annoyance: sr25519 signatures are randomised, so a second signature
 * over the same message yields a DIFFERENT key and a different vault. The cache
 * is what makes the identity stable across restarts.
 *
 * The cached value is encrypted at rest under a device-resident key the host
 * supplies. That key must be non-extractable where the platform can do it (a
 * WebCrypto `CryptoKey` with `extractable: false`), so a storage dump, a disk
 * image or a synced profile does not expose the spending key.
 *
 * Threat-model limit, stated honestly: code running in the same context can
 * still call decrypt. That boundary is not defendable from here. It is a strict
 * improvement over storing the key in the clear.
 */
import { encryptJson, decryptJson } from '../vault/index';
import { canonicalAccountId } from '../../protocol/keys/accountIdentity';
import type { SecretStore } from './secretStore';

const KEY_PREFIX = 'orbinum_sk_';

/** The stored envelope. Versioned so a format change is detectable, not fatal. */
interface EncryptedSessionEnvelope {
    v: 1;
    iv: string;
    ct: string;
}

function isEnvelope(value: unknown): value is EncryptedSessionEnvelope {
    return (
        typeof value === 'object' &&
        value !== null &&
        (value as EncryptedSessionEnvelope).v === 1 &&
        typeof (value as EncryptedSessionEnvelope).iv === 'string' &&
        typeof (value as EncryptedSessionEnvelope).ct === 'string'
    );
}

/**
 * Storage key for one cached identity.
 *
 * Scoped by chainId because the chain is PART of the identity: the spending key
 * is derived with `info = "orbinum-sk-v2:{chainId}:{account}"`, so one wallet
 * yields a different key per network. A key shared across networks would restore
 * one network's identity into another and show an empty vault with nothing to
 * explain it.
 *
 * The account half goes through `canonicalAccountId` for the same reason: it has
 * to match what the derivation keys by, or one identity ends up filed under two
 * names. An SS58 address re-listed under another network prefix is the common
 * way that happens — same key, different vault, orphaned notes.
 */
export function sessionCacheKey(address: string, chainId: number): string {
    return `${KEY_PREFIX}${chainId}_${canonicalAccountId(address)}`;
}

export interface SessionCacheDeps {
    store: SecretStore;
    /**
     * Encrypts the cached identity at rest. Prefer a non-extractable key that
     * never leaves the device — NOT one derived from a wallet signature, which
     * would be circular, since avoiding a re-signature is the reason this cache
     * exists.
     */
    deviceKey: CryptoKey;
}

/** Whether a cached identity exists, without decrypting it. */
export async function hasCachedSession(
    store: SecretStore,
    address: string,
    chainId: number
): Promise<boolean> {
    return (await store.get(sessionCacheKey(address, chainId))) !== null;
}

/**
 * Encrypts and stores an exported identity — the `mk:0x…` string
 * `PrivacyKeyManager.exportHex()` returns.
 *
 * Master bytes rather than the spending-key scalar, because that is what
 * `exportHex` emits and what keeps the vault key stable across a modulus change.
 */
export async function cacheSession(
    deps: SessionCacheDeps,
    address: string,
    chainId: number,
    exportedIdentity: string
): Promise<void> {
    const { iv, ciphertext } = await encryptJson(deps.deviceKey, exportedIdentity);
    const envelope: EncryptedSessionEnvelope = { v: 1, iv, ct: ciphertext };
    await deps.store.set(sessionCacheKey(address, chainId), JSON.stringify(envelope));
}

/**
 * Reads back a cached identity, or null when there is none.
 *
 * A cache that fails to decrypt is DELETED rather than reported: the device key
 * was regenerated, or the envelope predates a format change. Either way it can
 * never be read again, and leaving it behind means the failure repeats on every
 * launch. The caller falls back to asking for a signature.
 */
export async function restoreSession(
    deps: SessionCacheDeps,
    address: string,
    chainId: number
): Promise<string | null> {
    const key = sessionCacheKey(address, chainId);
    const cached = await deps.store.get(key);
    if (!cached) return null;

    try {
        const envelope: unknown = JSON.parse(cached);
        if (!isEnvelope(envelope)) throw new Error('unknown cache envelope');
        return (await decryptJson(deps.deviceKey, envelope.iv, envelope.ct)) as string;
    } catch {
        await deps.store.remove(key);
        return null;
    }
}

/**
 * Drops a cached identity.
 *
 * Without `chainId`, drops it on EVERY network — what disconnecting a wallet
 * means, since the user is leaving the account entirely rather than switching
 * chains. That sweep is why `SecretStore` has to expose its keys: the caller
 * cannot construct the key for a chain it does not know the user visited.
 */
export async function clearSession(
    store: SecretStore,
    address: string,
    chainId?: number
): Promise<void> {
    if (chainId !== undefined) {
        await store.remove(sessionCacheKey(address, chainId));
        return;
    }

    const suffix = `_${canonicalAccountId(address)}`;
    for (const key of await store.keys()) {
        if (key.startsWith(KEY_PREFIX) && key.endsWith(suffix)) await store.remove(key);
    }
}
