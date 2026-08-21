/**
 * La agregación del fan-out: N workers en paralelo, un resultado.
 *
 * `resultContract.test.ts` fija la misma promesa para el pool de hilo
 * principal, que no reparte nada. Esta es la otra mitad y la que corre en el
 * navegador: `createWorkerPool` parte el lote en tramos, los resuelve en
 * paralelo y vuelve a unirlos campo a campo.
 *
 * Unir campo a campo es justo la forma que ya falló una vez — un reenviador que
 * se dejó `sentNotes` — y aquí hay DIEZ campos con tres reglas distintas
 * (concatenar, deduplicar, quedarse con el máximo). Olvidar uno no da error:
 * da una lista vacía, indistinguible de un escaneo sin hallazgos.
 *
 * Por eso se comprueba la agregación con datos que DIFIEREN entre tramos: si
 * los dos workers devolvieran lo mismo, un merge que se quedara solo con el
 * primero pasaría igual.
 */
import { describe, it, expect } from 'vitest';
import { createWorkerPool } from '../../../../src/wallet/worker/pool/workerPool';
import { EMPTY_BATCH_RESULT } from '../../../../src/wallet/worker/kernel/types';
import type { WorkerLike } from '../../../../src/wallet/worker/pool/types';
import type { ScanCommitment } from '../../../../src/protocol/types';

const KEYS = {
    viewingKey: new Uint8Array(32).fill(1),
    spendingKey: 12345n,
    ownerPk: 3n,
};

/** Un hint mínimo: el worker es falso, así que nada de esto se descifra. */
const hint = (n: number): ScanCommitment => ({
    commitmentHex: '0x' + n.toString(16).padStart(64, '0'),
    leafIndex: n,
    encryptedMemo: '0x' + 'ab'.repeat(180),
});

/**
 * Workers falsos que responden por turno de la cola, sin descifrar nada.
 *
 * Cada uno devuelve lo que le toca de `replies`, en el orden en que el pool los
 * crea — que es el orden de los tramos. Así cada tramo puede traer datos
 * distintos y el merge tiene algo real que combinar.
 */
function poolOf(replies: Array<Partial<typeof EMPTY_BATCH_RESULT>>) {
    let created = 0;
    const factory = (): WorkerLike => {
        const reply = replies[created++] ?? {};
        const worker: WorkerLike = {
            postMessage() {
                // Asíncrono como el real: el pool instala su handler tras postear.
                queueMicrotask(() =>
                    worker.onmessage?.({ data: { ...EMPTY_BATCH_RESULT, ...reply } })
                );
            },
            onmessage: null,
            onerror: null,
            terminate() {},
        };
        return worker;
    };
    return createWorkerPool(factory, replies.length);
}

describe('createWorkerPool — unir lo que devuelven los workers', () => {
    it('CONCATENA los envíos recuperados de todos los tramos', async () => {
        // El campo que ya se perdió una vez. Quedarse con un solo tramo deja al
        // emisor sin la mitad de sus pagos, y sin un solo error.
        const pool = poolOf([
            { sentNotes: [{ value: 100n, commitmentHex: '0xaa' }] as never },
            { sentNotes: [{ value: 200n, commitmentHex: '0xbb' }] as never },
        ]);

        const result = await pool.decryptBatch([hint(1), hint(2)], KEYS as never);

        expect(result.sentNotes.map((s) => s.value)).toEqual([100n, 200n]);
        pool.terminate();
    });

    it('conserva el ORDEN de entrada al concatenar las notas', async () => {
        // Los tramos son rangos contiguos precisamente para que unirlos no
        // necesite etiquetar cada hint. Si el orden se perdiera, cada nota
        // quedaría emparejada con el leafIndex de otra.
        const pool = poolOf([
            { notes: [{ value: 1n }, { value: 2n }] as never },
            { notes: [{ value: 3n }, { value: 4n }] as never },
        ]);

        const result = await pool.decryptBatch([hint(1), hint(2), hint(3), hint(4)], KEYS as never);

        expect(result.notes.map((n) => n?.value)).toEqual([1n, 2n, 3n, 4n]);
        pool.terminate();
    });

    it('SUMA los contadores en vez de quedarse con uno', async () => {
        const pool = poolOf([
            { tagFiltered: 3, selfMatched: 1, pairwiseMatched: 2 },
            { tagFiltered: 4, selfMatched: 5, pairwiseMatched: 6 },
        ]);

        const result = await pool.decryptBatch([hint(1), hint(2)], KEYS as never);

        expect(result.tagFiltered).toBe(7);
        expect(result.selfMatched).toBe(6);
        expect(result.pairwiseMatched).toBe(8);
        pool.terminate();
    });

    it('se queda con el índice efímero MÁS ALTO, no con el último', async () => {
        // Este contador repara la ventana de descubrimiento. Quedarse con el
        // del último tramo la dejaría corta y las notas siguientes no se
        // encontrarían nunca.
        const pool = poolOf([
            { maxSelfEphIndex: 9, maxOutgoingEphIndex: 7 },
            { maxSelfEphIndex: 2, maxOutgoingEphIndex: 1 },
        ]);

        const result = await pool.decryptBatch([hint(1), hint(2)], KEYS as never);

        expect(result.maxSelfEphIndex).toBe(9);
        expect(result.maxOutgoingEphIndex).toBe(7);
        pool.terminate();
    });

    it('un índice nulo no borra el que otro tramo sí encontró', async () => {
        // `null` significa "este tramo no vio ninguno", no "no hay ninguno".
        // Un `Math.max` ingenuo con null lo convertiría en 0 o en NaN.
        const pool = poolOf([
            { maxSelfEphIndex: null, maxOutgoingEphIndex: null },
            { maxSelfEphIndex: 4, maxOutgoingEphIndex: 3 },
        ]);

        const result = await pool.decryptBatch([hint(1), hint(2)], KEYS as never);

        expect(result.maxSelfEphIndex).toBe(4);
        expect(result.maxOutgoingEphIndex).toBe(3);
        pool.terminate();
    });

    it('DEDUPLICA los receptores aprendidos', async () => {
        // Dos notas de cambio distintas pueden nombrar al mismo receptor, y esta
        // lista alimenta una retahíla de intentos por cada pago sin abrir.
        const pool = poolOf([
            { learnedRecipients: ['0xaa', '0xbb'] },
            { learnedRecipients: ['0xbb', '0xcc'] },
        ]);

        const result = await pool.decryptBatch([hint(1), hint(2)], KEYS as never);

        expect(result.learnedRecipients.sort()).toEqual(['0xaa', '0xbb', '0xcc']);
        pool.terminate();
    });

    it('DEDUPLICA las entradas de libreta selladas', async () => {
        const pool = poolOf([{ sealedBookEntries: ['1', '2'] }, { sealedBookEntries: ['2', '3'] }]);

        const result = await pool.decryptBatch([hint(1), hint(2)], KEYS as never);

        expect(result.sealedBookEntries.sort()).toEqual(['1', '2', '3']);
        pool.terminate();
    });

    it('concatena los pagos que ningún tramo pudo abrir', async () => {
        // Se reintentan luego contra la libreta completa del escaneo. Perder los
        // de un tramo pierde esos pagos para siempre.
        const pool = poolOf([
            { unmatchedSent: [{ hint: hint(1), ephIndex: 0 }] as never },
            { unmatchedSent: [{ hint: hint(2), ephIndex: 1 }] as never },
        ]);

        const result = await pool.decryptBatch([hint(1), hint(2)], KEYS as never);

        expect(result.unmatchedSent).toHaveLength(2);
        pool.terminate();
    });

    it('devuelve TODAS las claves del contrato, también al repartir', async () => {
        // La misma comprobación que fija el pool de hilo principal, sobre la
        // ruta que sí reparte: un campo que se añada mañana y que `mergeResults`
        // olvide se lee como vacío, nunca como error.
        const pool = poolOf([{}, {}]);

        const result = await pool.decryptBatch([hint(1), hint(2)], KEYS as never);

        expect(Object.keys(result).sort()).toEqual(Object.keys(EMPTY_BATCH_RESULT).sort());
        pool.terminate();
    });

    it('un lote vacío no arranca ningún worker', async () => {
        let spawned = 0;
        const pool = createWorkerPool(() => {
            spawned++;
            return { postMessage() {}, onmessage: null, onerror: null, terminate() {} };
        }, 2);

        const result = await pool.decryptBatch([], KEYS as never);

        expect(spawned).toBe(0);
        expect(result.notes).toEqual([]);
        pool.terminate();
    });
});
