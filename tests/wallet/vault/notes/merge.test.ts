/**
 * notesMerge — las reglas puras que deciden cómo queda la lista de notas tras
 * cada escritura del vault.
 *
 * Se prueban sin IDB ni Zustand a propósito: son la parte que el repositorio
 * aplica DESPUÉS de sus awaits, releyendo el estado, y ahí lo único que importa
 * es "dada esta lista y este cambio, cuál es la siguiente lista".
 */
import { describe, it, expect } from 'vitest';
import type { ZkNote } from '../../../../src/protocol/types';
import { upsertNote, applyBatch, removeByCommitment } from '../../../../src/wallet/vault/notes/merge';

const note = (commitmentHex: string, over: Partial<ZkNote> = {}) =>
    ({ commitmentHex, spent: false, spentAt: null, value: 100n, ...over }) as ZkNote;

describe('upsertNote', () => {
    it('añade una nota que no estaba', () => {
        const result = upsertNote([note('0xa')], note('0xb'));

        expect(result.map((n) => n.commitmentHex)).toEqual(['0xa', '0xb']);
    });

    it('reemplaza la nota existente con el mismo commitment', () => {
        const result = upsertNote([note('0xa'), note('0xb')], note('0xb', { spent: true }));

        expect(result).toHaveLength(2);
        expect(result.find((n) => n.commitmentHex === '0xb')?.spent).toBe(true);
    });

    // La lista se renderiza tal cual: mover una nota al final cuando cambia su
    // estado haría saltar la fila bajo el cursor del usuario.
    it('conserva la posición al reemplazar', () => {
        const result = upsertNote(
            [note('0xa'), note('0xb'), note('0xc')],
            note('0xb', { spent: true })
        );

        expect(result.map((n) => n.commitmentHex)).toEqual(['0xa', '0xb', '0xc']);
    });

    it('sobre una lista vacía deja sólo la nota nueva', () => {
        expect(upsertNote([], note('0xa'))).toHaveLength(1);
    });

    it('no muta la lista original', () => {
        const original = [note('0xa')];
        upsertNote(original, note('0xb'));

        expect(original).toHaveLength(1);
    });
});

describe('applyBatch', () => {
    it('reemplaza las notas del batch y añade las desconocidas', () => {
        const batch = new Map([
            ['0xb', note('0xb', { spent: true })],
            ['0xnueva', note('0xnueva')],
        ]);

        const result = applyBatch([note('0xa'), note('0xb')], batch);

        expect(result.map((n) => n.commitmentHex)).toEqual(['0xa', '0xb', '0xnueva']);
        expect(result.find((n) => n.commitmentHex === '0xb')?.spent).toBe(true);
    });

    // Lo que arregla el bug: el batch de un rescan no puede llevarse por delante
    // una nota guardada mientras ese batch se encriptaba.
    it('deja intactas las notas que el batch no menciona', () => {
        const batch = new Map([['0xa', note('0xa', { spent: true })]]);

        const result = applyBatch([note('0xa'), note('0xconcurrente')], batch);

        expect(result.map((n) => n.commitmentHex)).toContain('0xconcurrente');
    });

    it('un batch vacío devuelve la lista sin tocar', () => {
        const notes = [note('0xa')];

        expect(applyBatch(notes, new Map())).toBe(notes);
    });

    it('no muta la lista original', () => {
        const original = [note('0xa')];
        applyBatch(original, new Map([['0xb', note('0xb')]]));

        expect(original).toHaveLength(1);
    });
});

describe('removeByCommitment', () => {
    it('quita sólo los commitments indicados', () => {
        const result = removeByCommitment(
            [note('0xa'), note('0xb'), note('0xc')],
            new Set(['0xb'])
        );

        expect(result.map((n) => n.commitmentHex)).toEqual(['0xa', '0xc']);
    });

    it('ignora commitments que no están en la lista', () => {
        const result = removeByCommitment([note('0xa')], new Set(['0xausente']));

        expect(result.map((n) => n.commitmentHex)).toEqual(['0xa']);
    });

    it('un set vacío devuelve la lista sin tocar', () => {
        const notes = [note('0xa')];

        expect(removeByCommitment(notes, new Set())).toBe(notes);
    });
});
