/**
 * Las rutas de importación contra entradas hostiles.
 *
 * Las dos que existen: un fichero de backup, que el usuario restaura de un
 * disco que ya no controla, y una cadena `orbslip1:` que pega de donde sea.
 * Todo lo que llega por ahí lo eligió otra persona.
 *
 * El códec de backup es anterior a la disciplina de validación del slip y no la
 * había adoptado: aceptaba «cualquier cadena no vacía» donde va un commitment
 * de 32 bytes, y `typeof number` donde va una posición de árbol — así que
 * `NaN` pasaba, y un `spent: "no"` (truthy) se copiaba literal al vault y
 * escondía los fondos.
 */
import { describe, it, expect } from 'vitest';
import { decodeNoteBackup, importNotesFromBackup } from '../../../src/wallet/ops/notes/noteBackup';
import { decodePaymentSlip } from '../../../src/protocol/memo/PaymentSlip';
import { deriveIdentity } from '../../../src/wallet/identity/walletIdentity';
import { base64UrlEncode } from '../../../src/foundation/encoding/base64url';

const me = deriveIdentity(new Uint8Array(32).fill(0xa1), 'v3');
const keys = () => ({
    viewingSecretKey: me.viewingSecretKey,
    spendingKey: me.spendingKey,
    ownerPk: me.ownerPk,
});

describe('un backup hostil', () => {
    const entry = (over: Record<string, unknown> = {}) => ({
        commitmentHex: '0x' + 'ab'.repeat(32),
        encryptedMemo: '0x' + 'cd'.repeat(180),
        ...over,
    });
    const backup = (notes: unknown[]) => JSON.stringify({ v: 1, ts: 0, notes });

    it.each([
        ['NaN', NaN],
        ['Infinity', Infinity],
        ['negativo', -1],
        ['fraccionario', 1.5],
        ['más allá de u32', 2 ** 32],
    ])('rechaza un leafIndex %s', (_label, leafIndex) => {
        expect(() => decodeNoteBackup(backup([entry({ leafIndex })]))).toThrow(/required fields/);
    });

    it('rechaza un commitment que no es hex de 32 bytes', () => {
        expect(() => decodeNoteBackup(backup([entry({ commitmentHex: '0xabcd' })]))).toThrow(
            /required fields/
        );
    });

    it('rechaza un memo de longitud equivocada', () => {
        expect(() => decodeNoteBackup(backup([entry({ encryptedMemo: '0x00' })]))).toThrow(
            /required fields/
        );
    });

    it('rechaza un `spent` que no es booleano', () => {
        // Se copiaba VERBATIM al vault, así que `"no"` — que es truthy —
        // marcaba como gastada una nota disponible y escondía los fondos.
        expect(() => decodeNoteBackup(backup([entry({ spent: 'no' })]))).toThrow(/required fields/);
    });

    it('rechaza un `spentAt` que no es número ni null', () => {
        expect(() => decodeNoteBackup(backup([entry({ spentAt: {} })]))).toThrow(/required fields/);
    });

    it('acepta una entrada bien formada, con y sin campos opcionales', () => {
        expect(() => decodeNoteBackup(backup([entry()]))).not.toThrow();
        expect(() =>
            decodeNoteBackup(backup([entry({ leafIndex: 7, spent: true, spentAt: 42 })]))
        ).not.toThrow();
        expect(() => decodeNoteBackup(backup([entry({ spentAt: null })]))).not.toThrow();
    });

    it('una entrada bien formada pero ajena simplemente no descifra', () => {
        // La última defensa: la propiedad se prueba descifrando, no confiando.
        const notMine = importNotesFromBackup(decodeNoteBackup(backup([entry()])), keys());

        expect(notMine).toEqual([]);
    });
});

describe('el slip decodifica con el mismo hex que el resto del SDK', () => {
    it('un payload con caracteres no-hex no se convierte en ceros', () => {
        // El bucle inline que había aquí usaba `parseInt` sin comprobar el
        // juego de caracteres, así que «casi-hex» se volvía byte 0 en vez de
        // fallar — justo lo que `fromHex` documenta que evita.
        const payload = base64UrlEncode('0xzzzz');

        expect(decodePaymentSlip(`orbslip1:${payload}:00000000`)).toBeNull();
    });

    it.each([
        ['vacío', ''],
        ['sin checksum', 'orbslip1:abc'],
        ['esquema ajeno', 'orbslip9:abc:0000'],
    ])('devuelve null ante %s, sin lanzar', (_label, text) => {
        expect(decodePaymentSlip(text)).toBeNull();
    });

    it('nada de esto lanza nunca', () => {
        // Es una cadena que el usuario PEGA: una excepción aquí tumba el
        // manejador de pegado, no una importación.
        for (const bad of ['', 'x', 'orbslip1:', 'orbslip1::', 'orbslip1:!!!:0000']) {
            expect(() => decodePaymentSlip(bad)).not.toThrow();
        }
    });
});
