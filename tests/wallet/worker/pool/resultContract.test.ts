/**
 * El contrato de resultado: ningún campo puede perderse al cruzar el pool.
 *
 * Este es el fallo que originó toda la recuperación de envíos: un shim de
 * worker reenviaba el resultado campo a campo y se dejaba `sentNotes`. El pool
 * lee un campo ausente como "no había nada", así que un resultado incompleto es
 * indistinguible de un escaneo vacío — no hay error, no hay aviso, solo un
 * usuario sin payment slips.
 *
 * Un test por campo no sirve: el riesgo es el campo que se AÑADA mañana y que
 * el reenviador olvide. Así que se compara la forma completa contra la del
 * kernel, y añadir un campo sin reenviarlo rompe esto.
 */
import { describe, it, expect } from 'vitest';
import { createMainThreadPool } from '../../../../src/wallet/worker/pool/mainThreadPool';
import { EMPTY_BATCH_RESULT } from '../../../../src/wallet/worker/kernel/types';

const KEYS = {
    viewingKey: new Uint8Array(32).fill(1),
    spendingKey: 12345n,
    ownerPk: 3n,
};

describe('el resultado del pool conserva la forma del kernel', () => {
    it('un lote vacío devuelve TODAS las claves que declara el kernel', async () => {
        const pool = createMainThreadPool();

        const result = await pool.decryptBatch([], KEYS as never);

        // Cada clave del contrato tiene que estar presente, no solo las que
        // este test conozca por su nombre.
        for (const key of Object.keys(EMPTY_BATCH_RESULT)) {
            expect(result, `el pool no reenvía "${key}"`).toHaveProperty(key);
        }
        pool.terminate();
    });

    it('no inventa claves que el kernel no declara', async () => {
        // La otra dirección: un campo que solo exista en el pool es un contrato
        // que el worker real no cumple, y falla únicamente en producción.
        const pool = createMainThreadPool();

        const result = await pool.decryptBatch([], KEYS as never);

        expect(Object.keys(result).sort()).toEqual(Object.keys(EMPTY_BATCH_RESULT).sort());
        pool.terminate();
    });

    it('los campos de recuperación de envíos existen y son listas', async () => {
        // Nombrados explícitamente porque son los que se perdieron: si alguno
        // volviera a llegar como `undefined`, el escaneo lo leería como vacío.
        const pool = createMainThreadPool();

        const result = await pool.decryptBatch([], KEYS as never);

        expect(Array.isArray(result.sentNotes)).toBe(true);
        expect(Array.isArray(result.learnedRecipients)).toBe(true);
        expect(Array.isArray(result.unmatchedSent)).toBe(true);
        expect(Array.isArray(result.sealedBookEntries)).toBe(true);
        pool.terminate();
    });
});
