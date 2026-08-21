/**
 * The blind key and the tags it produces.
 *
 * This is the privacy property of storage at rest: a dump of the backend must
 * reveal no commitment, nullifier or asset that anyone could match against
 * chain data, while the wallet can still find its own note by comparing tags.
 *
 * Two properties carry it, and they pull in opposite directions — the tag must
 * be STABLE for the same identifier under the same wallet (or the note becomes
 * unfindable on the next unlock) and UNLINKABLE across wallets (or the tag is
 * just the identifier by another name).
 */
import { describe, it, expect } from 'vitest';
import {
    deriveVaultKey,
    deriveVaultBlindKey,
    blindTag,
} from '../../../../src/wallet/vault/crypto/keys';

const MASTER = new Uint8Array(32).fill(0x11);
const OTHER_MASTER = new Uint8Array(32).fill(0x22);
const COMMITMENT = '0xabc123';

describe('deriveVaultBlindKey', () => {
    it('returns an HMAC key', async () => {
        const key = await deriveVaultBlindKey(MASTER);

        expect(key.algorithm.name).toBe('HMAC');
        expect(key.usages).toEqual(['sign']);
    });

    it('is not extractable — the raw bytes can never be read back out', async () => {
        expect((await deriveVaultBlindKey(MASTER)).extractable).toBe(false);
    });

    it('differs from the cipher key derived from the SAME master bytes', async () => {
        // Different HKDF info strings. If one key were reused for both roles, a
        // tag would leak information about the ciphertext beside it.
        const cipherKey = await deriveVaultKey(MASTER);
        const blindKey = await deriveVaultBlindKey(MASTER);

        expect(cipherKey.algorithm.name).toBe('AES-GCM');
        expect(blindKey.algorithm.name).toBe('HMAC');
    });
});

describe('blindTag', () => {
    it('is stable for the same identifier and wallet', async () => {
        // The find-my-note path depends on this: an unstable tag would orphan
        // every stored note at the next unlock.
        const key = await deriveVaultBlindKey(MASTER);

        expect(await blindTag(key, COMMITMENT)).toBe(await blindTag(key, COMMITMENT));
    });

    it('survives re-deriving the key from the same master bytes', async () => {
        // Device-independent and reload-proof — the reason the key comes from
        // the master bytes rather than a random per-session salt.
        const first = await blindTag(await deriveVaultBlindKey(MASTER), COMMITMENT);
        const second = await blindTag(await deriveVaultBlindKey(MASTER), COMMITMENT);

        expect(first).toBe(second);
    });

    it('gives different wallets different tags for the SAME identifier', async () => {
        // Without this, two wallets holding notes from one transaction would
        // produce matching tags and be linkable from storage alone.
        const mine = await blindTag(await deriveVaultBlindKey(MASTER), COMMITMENT);
        const theirs = await blindTag(await deriveVaultBlindKey(OTHER_MASTER), COMMITMENT);

        expect(mine).not.toBe(theirs);
    });

    it('gives different identifiers different tags', async () => {
        const key = await deriveVaultBlindKey(MASTER);

        expect(await blindTag(key, '0xaaa')).not.toBe(await blindTag(key, '0xbbb'));
    });

    it('is case-insensitive, so one identifier never yields two tags', async () => {
        const key = await deriveVaultBlindKey(MASTER);

        expect(await blindTag(key, '0xABCDEF')).toBe(await blindTag(key, '0xabcdef'));
    });

    it('does not contain the identifier it tags', async () => {
        const key = await deriveVaultBlindKey(MASTER);

        expect(await blindTag(key, COMMITMENT)).not.toContain('abc123');
    });

    it('is a 0x-prefixed alphanumeric string', async () => {
        const key = await deriveVaultBlindKey(MASTER);

        expect(await blindTag(key, COMMITMENT)).toMatch(/^0x[a-z0-9]+$/);
    });

    it('tags an assetId the same way as a hex identifier', async () => {
        // assetId arrives as a decimal string, not hex — same function, and it
        // must stay stable for the asset filter to work.
        const key = await deriveVaultBlindKey(MASTER);

        expect(await blindTag(key, '0')).toBe(await blindTag(key, '0'));
        expect(await blindTag(key, '0')).not.toBe(await blindTag(key, '1'));
    });
});
