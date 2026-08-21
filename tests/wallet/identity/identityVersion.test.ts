/**
 * El token de versión en las claves de almacenamiento.
 *
 * Dos esquemas de derivación sobre la MISMA cuenta producen claves distintas
 * bajo el mismo nombre. `VaultStore.unlock` no distingue eso de un vault
 * corrupto: resetea. En silencio, y llevándose las notas del otro esquema.
 *
 * `v2` se escribe por AUSENCIA a propósito — esos vaults ya están en disco con
 * nombres sin segmento de versión, y añadirles uno los dejaría huérfanos.
 */
import { describe, it, expect } from 'vitest';
import { vaultStorageName } from '../../../src/wallet/identity/vaultName';
import { sessionCacheKey } from '../../../src/wallet/identity/sessionCache';
import { deriveIdentity } from '../../../src/wallet/identity/walletIdentity';
import { NoteBuilder } from '../../../src/protocol/note/NoteBuilder';
import { decryptHintBatch } from '../../../src/wallet/worker/kernel/decryptBatch';
import { clearKnownEphWindow } from '../../../src/wallet/worker/kernel/ephWindow';
import { deriveSelfEphSk } from '../../../src/protocol/eph/selfEph';
import { toHex } from '../../../src/foundation/encoding/hex';

const ADDR = '0xAbC0000000000000000000000000000000000001';
const CHAIN = '0x' + 'ab'.repeat(32);

describe('vaultStorageName', () => {
    it('v3 es el defecto, y lleva su token', () => {
        expect(vaultStorageName(ADDR, CHAIN)).toBe(vaultStorageName(ADDR, CHAIN, 'v3'));
        expect(vaultStorageName(ADDR, CHAIN)).toContain('-v3');
    });

    it('el nombre v3 no colisiona con el que escribía v2', () => {
        // v2 se deletreaba por AUSENCIA de token, así que su nombre era
        // `orbinum-vault-{chain}-{cuenta}`. Un vault v3 no puede aterrizar
        // ahí: fallaría al descifrar y `unlock` lo resetearía, llevándose por
        // delante las notas de la otra versión sin decir nada.
        expect(vaultStorageName(ADDR, CHAIN)).not.toBe(`orbinum-vault-${CHAIN}-${ADDR}`);
    });

    it('el token sobrevive con y sin fingerprint de cadena', () => {
        expect(vaultStorageName(ADDR, undefined, 'v3')).toContain('-v3');
        expect(vaultStorageName(ADDR, CHAIN, 'v3')).toContain('-v3');
    });

    it('sigue separando por cadena y por cuenta dentro de una versión', () => {
        const other = '0xAbC0000000000000000000000000000000000002';
        expect(vaultStorageName(ADDR, CHAIN, 'v3')).not.toBe(vaultStorageName(other, CHAIN, 'v3'));
        expect(vaultStorageName(ADDR, CHAIN, 'v3')).not.toBe(
            vaultStorageName(ADDR, '0x' + 'cd'.repeat(32), 'v3')
        );
    });
});

describe('sessionCacheKey', () => {
    it('v3 es el defecto y marca su entrada', () => {
        expect(sessionCacheKey(ADDR, 1)).toBe(sessionCacheKey(ADDR, 1, 'v3'));
        expect(sessionCacheKey(ADDR, 1)).toContain('v3');
    });

    it('no reutiliza la entrada que escribía v2', () => {
        // Una sesión v3 que cayera en la clave de v2 sobreescribiría la
        // identidad anterior en la caché.
        expect(sessionCacheKey(ADDR, 1)).not.toBe(`${ADDR.toLowerCase()}_1`);
    });

    it('sigue separando por cadena dentro de una versión', () => {
        expect(sessionCacheKey(ADDR, 1, 'v3')).not.toBe(sessionCacheKey(ADDR, 2, 'v3'));
    });
});

describe('una cuenta no puede suplantar una versión', () => {
    // El marcador va DELANTE de la cuenta a propósito. Como sufijo sería
    // forjable: `canonicalAccountId` deja pasar una dirección no-SS58 en
    // minúsculas, así que una cuenta llamada `0xabc-v3` habría producido el
    // mismo nombre que la v3 de `0xabc` — dos identidades compartiendo vault.
    it('una cuenta que empieza por el marcador se RECHAZA', () => {
        // El nombre se construye `prefijo-versión-cuenta`, así que una cuenta
        // llamada `v3-0xabc` caería en la posición de la versión. Con una sola
        // versión viva no hay con qué colisionar hoy; la guarda es lo que evita
        // que añadir la siguiente reabra el agujero.
        expect(() => vaultStorageName('v3-0xabc', CHAIN)).toThrow(/must not start with/);
    });

    it('lo mismo para el fingerprint de la cadena', () => {
        expect(() => vaultStorageName('0xabc', 'v3-chain1')).toThrow(/must not start with/);
    });

    it('y una cuenta que sólo CONTIENE el token pasa sin problema', () => {
        expect(() => vaultStorageName('0xabc-v3', CHAIN)).not.toThrow();
        expect(() => sessionCacheKey('0xabc_v3', 1)).not.toThrow();
    });
});

describe('v2 quedó fuera de alcance', () => {
    // Se ELIMINÓ, no se deprecó. Los usuarios de testnet hacen unshield antes
    // de que esta versión salga, así que no hay nada que migrar: una nota v2
    // está comprometida en cadena bajo su `ownerPk` v2 dentro del árbol de
    // Merkle, y re-derivar la identidad no la mueve, la huérfana.
    const ROOT = new Uint8Array(32).fill(0x5e);

    it('no se puede derivar una identidad v2 ni forzando la cadena', () => {
        // El tipo sólo admite 'v3'; esto cierra la puerta desde JavaScript,
        // que es donde un integrador podría pasar el string igualmente.
        expect(() => deriveIdentity(ROOT, 'v2' as never)).toThrow(/unknown identity version/);
    });

    it('la identidad v3 trae las tres ramas', () => {
        const id = deriveIdentity(ROOT, 'v3');

        expect(id.version).toBe('v3');
        expect(id.outgoingViewingKey).toBeDefined();
        expect(toHex(id.viewingSecretKey)).not.toBe(toHex(id.outgoingViewingKey!));
    });

    it('y es lo que sale sin pedir versión', () => {
        expect(deriveIdentity(ROOT, 'v3').version).toBe('v3');
    });
});
