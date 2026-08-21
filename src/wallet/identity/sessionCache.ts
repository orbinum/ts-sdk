/**
 * Caching a derived privacy identity between sessions.
 *
 * Not just to skip a prompt: sr25519 signatures are RANDOMISED, so signing the
 * same message twice yields a different key and a different vault. The cache is
 * what makes a Substrate identity stable across restarts at all.
 *
 * Encrypted at rest under a device key the host supplies, non-extractable where
 * the platform allows it, so a storage dump or a synced profile exposes nothing.
 *
 * Threat-model limit, stated plainly: code in the same context can still call
 * decrypt. That boundary is not defendable from here — this is a strict
 * improvement over storing the key in the clear, not a guarantee.
 */
import { encryptJson, decryptJson } from '../vault/index';
import { canonicalAccountId } from '../../protocol/keys/accountIdentity';
import type { IdentityVersion } from './vaultName';
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
 * Storage key for one cached identity — same three parts as the vault name, for
 * the same reason (see `vaultName`).
 *
 * The chain is PART of the identity: the derivation's `info` carries the chain
 * id, so one wallet yields a different key per network. The account goes through
 * `canonicalAccountId` so this matches what the derivation keys by — an address
 * re-listed under another SS58 prefix would otherwise file one identity under
 * two names.
 */
export function sessionCacheKey(
    address: string,
    chainId: number,
    version: IdentityVersion = 'v3'
): string {
    // Same rule as the vault name, and the same placement: the marker goes
    // BEFORE the account, so no address can spell its way into another
    // version's slot.
    const marker = `${version}_`;
    return `${KEY_PREFIX}${marker}${chainId}_${canonicalAccountId(address)}`;
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
