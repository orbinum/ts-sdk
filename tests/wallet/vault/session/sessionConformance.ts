/**
 * The `WalletSession` conformance suite.
 *
 * Exported so the app's Zustand-backed adapter runs the same assertions as the
 * SDK's plain implementation. The interface is small, but the invariant it
 * carries is not: a half-open session — one key present, the other missing —
 * must never read as unlocked, or a caller reaches for a key that is null and
 * fails somewhere far from the cause.
 */
import { describe, it, expect } from 'vitest';
import { requireSessionKeys } from '../../../../src/wallet/vault/session/WalletSession';
import { VaultLockedError } from '../../../../src/wallet/vault/session/errors';
import type { MutableWalletSession } from '../../../../src/wallet/vault/session/WalletSession';

/** Distinct keys, so a test can tell which slot a value came from. */
export async function testKeys(): Promise<{ cryptoKey: CryptoKey; blindKey: CryptoKey }> {
    const cryptoKey = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, [
        'encrypt',
        'decrypt',
    ]);
    const blindKey = await crypto.subtle.generateKey({ name: 'HMAC', hash: 'SHA-256' }, false, [
        'sign',
    ]);
    return { cryptoKey, blindKey };
}

export function testWalletSessionConformance(
    name: string,
    create: () => MutableWalletSession
): void {
    describe(`WalletSession conformance — ${name}`, () => {
        it('starts locked with no keys', () => {
            const session = create();

            expect(session.unlocked).toBe(false);
            expect(session.cryptoKey).toBeNull();
            expect(session.blindKey).toBeNull();
        });

        it('exposes both keys once opened', async () => {
            const session = create();
            const { cryptoKey, blindKey } = await testKeys();

            session.open(cryptoKey, blindKey);

            expect(session.unlocked).toBe(true);
            expect(session.cryptoKey).toBe(cryptoKey);
            expect(session.blindKey).toBe(blindKey);
        });

        it('drops both keys on lock', async () => {
            const session = create();
            const { cryptoKey, blindKey } = await testKeys();
            session.open(cryptoKey, blindKey);

            session.lock();

            // Leaving either behind would keep encrypted data readable after a
            // lock the user asked for.
            expect(session.unlocked).toBe(false);
            expect(session.cryptoKey).toBeNull();
            expect(session.blindKey).toBeNull();
        });

        it('reports the keys of the most recent open', async () => {
            const session = create();
            const first = await testKeys();
            const second = await testKeys();

            session.open(first.cryptoKey, first.blindKey);
            session.open(second.cryptoKey, second.blindKey);

            expect(session.cryptoKey).toBe(second.cryptoKey);
        });

        describe('requireSessionKeys', () => {
            it('returns both keys from an open session', async () => {
                const session = create();
                const { cryptoKey, blindKey } = await testKeys();
                session.open(cryptoKey, blindKey);

                expect(requireSessionKeys(session)).toEqual({ cryptoKey, blindKey });
            });

            it('throws VaultLockedError while locked', () => {
                expect(() => requireSessionKeys(create())).toThrow(VaultLockedError);
            });

            it('throws on a half-open session rather than returning a null key', async () => {
                const { cryptoKey } = await testKeys();
                // An adapter that sets `unlocked` before both keys land would
                // otherwise hand a caller a null it is typed not to expect.
                const halfOpen = { unlocked: true, cryptoKey, blindKey: null };

                expect(() => requireSessionKeys(halfOpen)).toThrow(VaultLockedError);
            });
        });
    });
}
