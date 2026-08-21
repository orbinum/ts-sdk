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

describe('el marcador de versión no se puede falsificar', () => {
    // Que dos identidades compartan nombre de vault no es un choque cosmético:
    // `unlock` no distingue un vault ajeno de uno corrupto, así que RESETEA y se
    // lleva por delante las notas de la otra versión, en silencio.
    //
    // Mover el marcador al prefijo cerró la falsificación por sufijo, pero no
    // ésta: la versión ocupa un segmento fijo del nombre, así que un
    // componente que empiece por ese token cae en su sitio y se lee como la
    // versión. Con una sola versión viva no hay con qué colisionar HOY — la
    // guarda existe para que añadir la siguiente no reabra el agujero.
    it('rechaza una cuenta que empieza por el marcador', () => {
        // `canonicalAccountId` deja pasar una dirección no-SS58 en minúsculas,
        // así que este nombre de cuenta llega literal.
        expect(() => vaultStorageName('v3-0xabc', undefined)).toThrow(/must not start with/);
    });

    it('rechaza un fingerprint de cadena que empieza por el marcador', () => {
        expect(() => vaultStorageName('0xabc', 'v3-chain1')).toThrow(/must not start with/);
    });

    it('lo comprueba en minúsculas, que es la forma que llega al nombre', () => {
        expect(() => vaultStorageName('0xabc', 'V3-chain1')).toThrow(/must not start with/);
    });

    it('LA COLISIÓN QUE IMPIDE: dos versiones bajo un solo nombre', () => {
        // Antes de la guarda ambos daban `orbinum-vault-v3-0xabc`.
        expect(() => vaultStorageName('v3-0xabc', undefined)).toThrow();
        expect(vaultStorageName('0xabc', undefined, 'v3')).toBe('orbinum-vault-v3-0xabc');
    });

    it('no molesta a las entradas normales', () => {
        expect(() => vaultStorageName('0xabc', 'chain1')).not.toThrow();
        expect(() => vaultStorageName('0xv3abc', undefined, 'v3')).not.toThrow();
    });
});
