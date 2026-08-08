/**
 * The unlocked-vault session: the keys that exist only while a wallet is open.
 *
 * Deliberately holds keys and nothing else. An application's session state also
 * tracks the decrypted notes, because its UI re-renders off them — but that is
 * reactivity, and pulling it in here would drag a framework's update semantics
 * into the SDK. Notes belong to the vault store, which publishes changes; a
 * host mirrors them into whatever state container it uses.
 *
 * Keys are `CryptoKey`, so a non-extractable key stays non-extractable: the raw
 * bytes are never handled by this code and cannot be read back out of it.
 */
import { VaultLockedError } from './errors';

/** Read-only view of the session, which is all the SDK ever needs. */
export interface WalletSession {
    readonly unlocked: boolean;
    /** AES-GCM key for note bodies and tx history. Null while locked. */
    readonly cryptoKey: CryptoKey | null;
    /** HMAC key blinding note identifiers at rest. Null while locked. */
    readonly blindKey: CryptoKey | null;
}

/** A session the holder can also open and close. */
export interface MutableWalletSession extends WalletSession {
    open(cryptoKey: CryptoKey, blindKey: CryptoKey): void;
    /** Drops both keys. Anything still encrypted stays unreadable until the next open. */
    lock(): void;
}

/**
 * A plain in-memory session.
 *
 * Enough on its own for a consumer with no UI. An application with reactive
 * state implements `WalletSession` over its own store instead — the interface
 * is small precisely so that adapter is trivial.
 */
export function createWalletSession(): MutableWalletSession {
    let cryptoKey: CryptoKey | null = null;
    let blindKey: CryptoKey | null = null;

    return {
        get unlocked() {
            return cryptoKey !== null && blindKey !== null;
        },
        get cryptoKey() {
            return cryptoKey;
        },
        get blindKey() {
            return blindKey;
        },
        open(nextCryptoKey, nextBlindKey) {
            cryptoKey = nextCryptoKey;
            blindKey = nextBlindKey;
        },
        lock() {
            cryptoKey = null;
            blindKey = null;
        },
    };
}

/**
 * Both keys, or a thrown `VaultLockedError`.
 *
 * The single place that decides what "unlocked" means, so no caller has to
 * re-derive it — and so a half-open session (one key present) can never be
 * mistaken for a usable one.
 */
export function requireSessionKeys(session: WalletSession): {
    cryptoKey: CryptoKey;
    blindKey: CryptoKey;
} {
    const { cryptoKey, blindKey, unlocked } = session;
    if (!unlocked || !cryptoKey || !blindKey) throw new VaultLockedError();
    return { cryptoKey, blindKey };
}
