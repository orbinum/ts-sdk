/**
 * Vault naming.
 *
 * Both halves of the name protect against a silent failure. Sharing a name
 * across chains mixes notes whose commitments only exist on one of them; keying
 * by a non-canonical address opens a different vault under the same key, and the
 * user sees an empty balance with the real notes orphaned elsewhere.
 */
import { describe, it, expect } from 'vitest';
import { vaultStorageName } from '../../../src/wallet/identity/vaultName';
import { canonicalAccountId } from '../../../src/protocol/keys/accountIdentity';

const EVM = '0x1234567890abcdef1234567890abcdef12345678';
const GENESIS = '0xABCDEF0123456789';

describe('vaultStorageName', () => {
    it('separates chains', () => {
        expect(vaultStorageName(EVM, '0xaaa')).not.toBe(vaultStorageName(EVM, '0xbbb'));
    });

    it('separates accounts', () => {
        const other = '0xfedcba9876543210fedcba9876543210fedcba98';

        expect(vaultStorageName(EVM, GENESIS)).not.toBe(vaultStorageName(other, GENESIS));
    });

    it('canonicalises the account the way the key derivation does', () => {
        // A wallet that re-lists an account under different casing or a different
        // SS58 prefix derives the SAME key. A name keyed off the raw string would
        // send it to a different vault.
        expect(vaultStorageName(EVM.toUpperCase(), GENESIS)).toBe(vaultStorageName(EVM, GENESIS));
        expect(vaultStorageName(EVM, GENESIS)).toContain(canonicalAccountId(EVM));
    });

    it('lowercases the fingerprint so casing cannot fork a vault', () => {
        expect(vaultStorageName(EVM, GENESIS)).toBe(vaultStorageName(EVM, GENESIS.toLowerCase()));
    });

    it('falls back to account-only scoping before the fingerprint is known', () => {
        // Early in a connect flow the genesis hash may not have arrived yet.
        // Opening under the short name and later the long one is safe: unlock
        // detects the fingerprint change and resets rather than mixing chains.
        const short = vaultStorageName(EVM);

        expect(short).toContain(canonicalAccountId(EVM));
        expect(short).not.toBe(vaultStorageName(EVM, GENESIS));
    });

    it('is stable across calls', () => {
        expect(vaultStorageName(EVM, GENESIS)).toBe(vaultStorageName(EVM, GENESIS));
    });
});
