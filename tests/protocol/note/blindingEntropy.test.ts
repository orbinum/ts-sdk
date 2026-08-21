/**
 * El blinding por defecto tiene que venir de un CSPRNG.
 *
 * Es el ÚNICO valor desconocido de `Poseidon4(value, assetId, ownerPk,
 * blinding)` en cuanto un observador acierta el importe, así que es lo que hace
 * que un commitment oculte algo. Con `BigInt(Date.now())` tenía ~41 bits y la
 * marca de tiempo del bloque es pública: el espacio real caía a unos miles de
 * candidatos y el commitment se rompía por fuerza bruta en segundos — medido,
 * 14 437 candidatos en 2,4 s.
 */
import { describe, it, expect } from 'vitest';
import { poseidon4 } from 'poseidon-lite';
import { NoteBuilder } from '../../../src/protocol/note/NoteBuilder';

/** El rango que ocupa un milisegundo de reloj de pared, con holgura. */
const CLOCK_LOW = 1_600_000_000_000n;
const CLOCK_HIGH = 4_000_000_000_000n;

describe('entropía del blinding por defecto', () => {
    it('NO es una marca de tiempo', async () => {
        // La regresión concreta: un blinding en el rango del reloj es adivinable
        // desde la hora del bloque, que es pública.
        const note = await NoteBuilder.build({ value: 1000n, assetId: 0n, ownerPk: 12345n });

        const looksLikeClock = note.blinding > CLOCK_LOW && note.blinding < CLOCK_HIGH;
        expect(looksLikeClock).toBe(false);
    });

    it('usa el ancho del campo, no 41 bits', async () => {
        // Una sola muestra podría salir baja por azar; con veinte, que TODAS
        // queden por debajo de 2^200 tiene probabilidad despreciable.
        const notes = await Promise.all(
            Array.from({ length: 20 }, () => NoteBuilder.build({ value: 1n, ownerPk: 1n }))
        );

        const widest = notes.reduce((m, n) => (n.blinding > m ? n.blinding : m), 0n);
        expect(widest).toBeGreaterThan(2n ** 200n);
    });

    it('EL ATAQUE: barrer el reloj alrededor del bloque ya no encuentra nada', async () => {
        // Reproduce el ataque que funcionaba. El original barría ±2 s sobre la
        // hora del bloque contra cinco importes plausibles — 20 000 candidatos,
        // 2,4 s — y acertaba. Aquí basta una ventana más corta: con el importe
        // REAL fijado y el milisegundo exacto de la construcción dentro del
        // barrido, un blinding de reloj cae seguro, y uno del CSPRNG no.
        const before = BigInt(Date.now());
        const note = await NoteBuilder.build({ value: 1000n, assetId: 0n, ownerPk: 12345n });
        const after = BigInt(Date.now());

        let found = false;
        for (let t = before - 5n; t <= after + 5n && !found; t++) {
            if (poseidon4([1000n, 0n, 12345n, t]) === note.commitment) found = true;
        }

        expect(found).toBe(false);
    });

    it('dos notas idénticas no comparten commitment', async () => {
        // Sin blinding fresco por nota, dos pagos iguales al mismo destino
        // producirían el mismo commitment y serían enlazables en público.
        const a = await NoteBuilder.build({ value: 5n, assetId: 0n, ownerPk: 7n });
        const b = await NoteBuilder.build({ value: 5n, assetId: 0n, ownerPk: 7n });

        expect(a.commitmentHex).not.toBe(b.commitmentHex);
    });
});
