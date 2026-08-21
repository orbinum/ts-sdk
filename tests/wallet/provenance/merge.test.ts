/**
 * mergeProvenance — what a rescan is allowed to overwrite.
 *
 * The failure this guards against is silent and unrecoverable: reconstruction
 * runs after every scan over records the wallet wrote itself, and a payment
 * slip is cheap to re-issue, but the amount and recipient are not. Losing them
 * loses it for good.
 */
import { describe, it, expect } from 'vitest';
import { mergeProvenance, outranks } from '../../../src/wallet/provenance/index';
import type { NoteProvenanceRecord, ProvenanceSource } from '../../../src/wallet/provenance/index';

function record(over: Partial<NoteProvenanceRecord> = {}): NoteProvenanceRecord {
    return {
        id: '0xtx',
        hash: '0xtx',
        blockNumber: 100,
        timestampMs: 1_000,
        direction: 'out',
        kind: 'private_transfer',
        origin: 'transfer-change',
        source: 'inferred',
        peer: { pk: 0xabcn, scope: 'stealth' },
        amount: { value: 500n, exact: false },
        assetId: 0n,
        status: 'success',
        ...over,
    };
}

describe('outranks', () => {
    it('ranks witnessed above every recovered source', () => {
        expect(outranks('witnessed', 'memo')).toBe(true);
        expect(outranks('witnessed', 'chain')).toBe(true);
        expect(outranks('witnessed', 'inferred')).toBe(true);
    });

    it('ranks a decrypted fact above a public lookup, and both above arithmetic', () => {
        expect(outranks('memo', 'chain')).toBe(true);
        expect(outranks('memo', 'inferred')).toBe(true);
        expect(outranks('chain', 'inferred')).toBe(true);
    });

    it('is strict — an equal source does not outrank itself', () => {
        expect(outranks('memo', 'memo')).toBe(false);
    });

    it('ranks a source this build does not know below every known one', () => {
        // `source` is runtime data: records come back from encrypted storage,
        // so an older record or a foreign writer can carry a value this build
        // has no rank for. Without the fallback the comparison is against
        // `undefined`, which is false BOTH ways — an unknown source would then
        // silently keep whichever side happened to be the existing one.
        const unknown = 'from-a-later-build' as ProvenanceSource;

        expect(outranks(unknown, 'inferred')).toBe(false);
        expect(outranks('inferred', unknown)).toBe(true);
    });
});

describe('mergeProvenance', () => {
    it('a stronger incoming record replaces a weaker one', () => {
        const existing = record({ source: 'inferred', amount: { value: 500n, exact: false } });
        const incoming = record({ source: 'memo', amount: { value: 512n, exact: true } });

        const merged = mergeProvenance(existing, incoming);

        expect(merged.source).toBe('memo');
        expect(merged.amount).toEqual({ value: 512n, exact: true });
    });

    it('a weaker incoming record never overwrites what the wallet witnessed', () => {
        const witnessed = record({ source: 'witnessed', amount: { value: 512n, exact: true } });
        const backfill = record({ source: 'inferred', amount: { value: 500n, exact: false } });

        const merged = mergeProvenance(witnessed, backfill);

        expect(merged.source).toBe('witnessed');
        expect(merged.amount).toEqual({ value: 512n, exact: true });
    });

    it('KEEPS a payment slip a backfill knows nothing about', () => {
        // The regression that motivates this function: a slip is sealed toward
        // the recipient; the local record is the only one carrying the amount.
        const witnessed = record({ source: 'witnessed', slip: { encoded: 'orbslip1:abc' } });
        const backfill = record({ source: 'inferred' });

        expect(mergeProvenance(witnessed, backfill).slip).toEqual({ encoded: 'orbslip1:abc' });
    });

    it('keeps the slip even when the INCOMING record is the stronger one', () => {
        // Rank decides the facts; absence never overwrites presence.
        const existing = record({ source: 'inferred', slip: { encoded: 'orbslip1:abc' } });
        const stronger = record({ source: 'memo' });

        const merged = mergeProvenance(existing, stronger);

        expect(merged.source).toBe('memo');
        expect(merged.slip).toEqual({ encoded: 'orbslip1:abc' });
    });

    it('fills a gap the winner left — fee, public recipient, note facts', () => {
        const existing = record({
            source: 'inferred',
            feePlanck: 42n,
            publicRecipient: '5Grwva',
        });
        const stronger = record({ source: 'memo' });

        const merged = mergeProvenance(existing, stronger);

        expect(merged.feePlanck).toBe(42n);
        expect(merged.publicRecipient).toBe('5Grwva');
    });

    it('backfills an unknown peer — the whole point of re-running reconstruction', () => {
        const existing = record({ source: 'witnessed', peer: null });
        const backfill = record({ source: 'inferred', peer: { pk: 0xdefn, scope: 'stealth' } });

        expect(mergeProvenance(existing, backfill).peer).toEqual({ pk: 0xdefn, scope: 'stealth' });
    });

    it('a record whose source this build cannot rank never overwrites facts', () => {
        // The amount and the recipient of an outgoing transfer live inside a
        // memo sealed toward someone else, so a `witnessed` record is the only
        // copy the sender has. An unrankable incoming record must not take its
        // place — losing that is not recoverable by re-running anything.
        const existing = record({
            source: 'witnessed',
            amount: { value: 100n, exact: true },
            peer: { pk: 0xaaan, scope: 'global' },
        });
        const strange = record({
            source: 'from-a-later-build' as ProvenanceSource,
            amount: { value: 1n, exact: false },
            peer: { pk: 0xbbbn, scope: 'stealth' },
        });

        const merged = mergeProvenance(existing, strange);

        expect(merged.amount).toEqual({ value: 100n, exact: true });
        expect(merged.peer).toEqual({ pk: 0xaaan, scope: 'global' });
    });

    it('omits absent optionals instead of writing undefined into them', () => {
        // exactOptionalPropertyTypes: an explicit `undefined` would make "no fee
        // recovered" indistinguishable from "the fee is undefined".
        const merged = mergeProvenance(record(), record({ source: 'memo' }));

        expect('feePlanck' in merged).toBe(false);
        expect('slip' in merged).toBe(false);
        expect('note' in merged).toBe(false);
    });
});

describe('mergeProvenance — registros que no deberían fusionarse', () => {
    it('rechaza fusionar dos transacciones distintas', () => {
        // El `id` es la clave de almacenamiento. Fusionar filas con ids
        // distintos produce una fila que describe una transacción que nunca
        // ocurrió, con el importe de una y el hash de otra. El llamador
        // habitual filtra por id antes de llamar, pero eso es disciplina suya,
        // no una garantía de esta función.
        const a = record({ id: 'tx-A', source: 'witnessed' });
        const b = record({ id: 'tx-B', source: 'inferred' });

        expect(() => mergeProvenance(a, b)).toThrow(/id/);
    });

    it('un resultado en cadena no se sobreescribe por rango', () => {
        // `status` es un hecho de la cadena, no algo que una fuente conozca
        // mejor que otra: cualquiera que lo mire ve lo mismo. Dejar que el
        // rango decida haría que una fila `witnessed` escrita al enviar
        // marcase como fallida una transacción que la cadena aceptó.
        const enCadena = record({ source: 'inferred', status: 'success' });
        const local = record({ source: 'witnessed', status: 'failed' });

        expect(mergeProvenance(enCadena, local).status).toBe('success');
        expect(mergeProvenance(local, enCadena).status).toBe('success');
    });

    it('un importe exacto gana a uno aproximado aunque la fuente sea menor', () => {
        // `exact` es una propiedad de la CIFRA, no de la fuente: una fila
        // `witnessed` cuya cifra se marcó aproximada no es mejor dato que una
        // `memo` exacta. Preferir el rango aquí degrada un importe correcto.
        const exacto = record({ source: 'memo', amount: { value: 42n, exact: true } });
        const aprox = record({ source: 'witnessed', amount: { value: 7n, exact: false } });

        expect(mergeProvenance(exacto, aprox).amount).toEqual({ value: 42n, exact: true });
        expect(mergeProvenance(aprox, exacto).amount).toEqual({ value: 42n, exact: true });
    });

    it('entre dos importes igual de exactos manda el rango', () => {
        const fuerte = record({ source: 'witnessed', amount: { value: 100n, exact: true } });
        const debil = record({ source: 'inferred', amount: { value: 1n, exact: true } });

        expect(mergeProvenance(debil, fuerte).amount.value).toBe(100n);
        expect(mergeProvenance(fuerte, debil).amount.value).toBe(100n);
    });
});

describe('mergeProvenance — un hueco no es un dato', () => {
    it('no deja que un blockNumber cero pise uno real', () => {
        // Cero es "todavía no lo sé", no el bloque génesis: `RECOVERED_TX_RESULT`
        // y el resultado de un envío fallido lo usan como hueco, y su propio
        // comentario dice que quien los necesite debe consultarlos aparte.
        const conBloque = record({ source: 'inferred', blockNumber: 500 });
        const sinBloque = record({ source: 'witnessed', blockNumber: 0 });

        expect(mergeProvenance(conBloque, sinBloque).blockNumber).toBe(500);
        expect(mergeProvenance(sinBloque, conBloque).blockNumber).toBe(500);
    });

    it('no deja que un timestamp cero pise uno real', () => {
        const conFecha = record({ source: 'inferred', timestampMs: 1_700_000_000_000 });
        const sinFecha = record({ source: 'witnessed', timestampMs: 0 });

        expect(mergeProvenance(conFecha, sinFecha).timestampMs).toBe(1_700_000_000_000);
    });

    it('no deja que un hash vacío pise uno real', () => {
        // La reconstrucción escribe `hash: ''` cuando la extrinsic no se decodificó.
        const conHash = record({ source: 'inferred', hash: '0xreal' });
        const sinHash = record({ source: 'witnessed', hash: '' });

        expect(mergeProvenance(conHash, sinHash).hash).toBe('0xreal');
    });

    it('no deja que un slip vacío pise uno bueno', () => {
        // `'' ?? x` no salta: la cadena `??` solo mira null/undefined, así que
        // una cadena vacía contaba como slip presente.
        const bueno = record({ source: 'inferred', slip: { encoded: 'orbslip1:bueno' } });
        const vacio = record({ source: 'witnessed', slip: { encoded: '' } });

        expect(mergeProvenance(bueno, vacio).slip).toEqual({ encoded: 'orbslip1:bueno' });
    });

    it('un peer sin contraparte no cuenta como contraparte conocida', () => {
        // `scope: 'none'` es justamente "esta operación no tiene contraparte".
        // Tratarlo como conocido impide que un backfill posterior la rellene.
        const sinPeer = record({ source: 'witnessed', peer: null });
        const peerNulo = record({ source: 'inferred', peer: { pk: 0n, scope: 'none' } });
        const peerReal = record({ source: 'inferred', peer: { pk: 0xabcn, scope: 'stealth' } });

        // Un peer con scope 'none' se conserva —registra que no hay contraparte—
        // pero no debe impedir que un backfill posterior traiga uno real.
        expect(mergeProvenance(sinPeer, peerNulo).peer?.scope).toBe('none');
        expect(mergeProvenance(sinPeer, peerReal).peer).toEqual({ pk: 0xabcn, scope: 'stealth' });
        expect(mergeProvenance(peerNulo, peerReal).peer).toEqual({ pk: 0xabcn, scope: 'stealth' });
    });

    it('los valores reales siguen ganando cuando ambos lados los tienen', () => {
        // El arreglo no puede invertir la regla de rango sobre datos buenos.
        const debil = record({ source: 'inferred', blockNumber: 100, timestampMs: 1 });
        const fuerte = record({ source: 'witnessed', blockNumber: 200, timestampMs: 2 });

        const m = mergeProvenance(debil, fuerte);
        expect(m.blockNumber).toBe(200);
        expect(m.timestampMs).toBe(2);
    });
});

describe('mergeProvenance — el resultado no comparte estado con la entrada', () => {
    it('mutar el registro devuelto no toca los originales', () => {
        // El merge devuelve `{...base}`, una copia superficial: los objetos
        // anidados siguen siendo los MISMOS. Quien reciba el resultado y toque
        // un campo anidado corrompe la fila que sigue viva en memoria — y esa
        // fila es la única copia del importe y del destinatario.
        // El lado que GANA es el que aporta los objetos anidados al resultado,
        // así que es el suyo el que hay que poder mutar sin dañar el original.
        const existing = record({
            source: 'witnessed',
            slip: { encoded: 'orbslip1:original' },
            amount: { value: 500n, exact: false },
            peer: { pk: 0xaaan, scope: 'stealth' },
        });
        const incoming = record({ source: 'inferred', peer: null });

        const merged = mergeProvenance(existing, incoming);
        (merged.slip as { encoded: string }).encoded = 'MUTADO';
        (merged.amount as { value: bigint }).value = 1n;
        (merged.peer as { pk: bigint }).pk = 0n;

        expect(existing.slip).toEqual({ encoded: 'orbslip1:original' });
        expect(existing.amount).toEqual({ value: 500n, exact: false });
        expect(existing.peer).toEqual({ pk: 0xaaan, scope: 'stealth' });
    });

    it('mutar el original después no cambia lo ya fusionado', () => {
        const existing = record({ source: 'inferred', slip: { encoded: 'orbslip1:a' } });
        const merged = mergeProvenance(existing, record({ source: 'witnessed' }));

        (existing.slip as { encoded: string }).encoded = 'CAMBIADO';

        expect(merged.slip).toEqual({ encoded: 'orbslip1:a' });
    });
});

describe('mergeProvenance — cero no es lo mismo que ausente', () => {
    it('un fee cero no borra uno real', () => {
        // Cero es un fee legítimo (transferencia sin comisión), así que no se
        // puede tratar como hueco — pero tampoco puede ganar por rango sobre un
        // valor recuperado cuando el lado fuerte simplemente no lo tenía.
        const conFee = record({ source: 'inferred', feePlanck: 42n });
        const sinFee = record({ source: 'witnessed' });

        expect(mergeProvenance(conFee, sinFee).feePlanck).toBe(42n);
    });

    it('un fee cero explícito se conserva cuando es el único dato', () => {
        const cero = record({ source: 'witnessed', feePlanck: 0n });
        const nada = record({ source: 'inferred' });

        expect(mergeProvenance(nada, cero).feePlanck).toBe(0n);
    });
});

describe('mergeProvenance — campos que este build no conoce', () => {
    /** Una fila con un campo del host, como la escribe la reconstrucción. */
    const conExtra = (over: Partial<NoteProvenanceRecord> = {}) =>
        ({ ...record(over), amountApproximate: true }) as NoteProvenanceRecord &
            Record<string, unknown>;

    it('conserva un campo del host cuando su fila gana', () => {
        // `ReconstructedTxRecord` lleva `amountApproximate`, que marca un
        // importe deducido sin restar la comisión. No existe en
        // `NoteProvenanceRecord`, y perderlo hace que una cifra aproximada
        // parezca exacta — el aviso desaparece, el número no.
        const merged = mergeProvenance(
            conExtra({ source: 'witnessed' }),
            record({ source: 'inferred' })
        ) as NoteProvenanceRecord & Record<string, unknown>;

        expect(merged['amountApproximate']).toBe(true);
    });

    it('conserva un campo del host aunque gane la otra fila', () => {
        // La reconstrucción documenta que "anything extra on an EXISTING record
        // survives the backfill". El rango decide los hechos que ambas conocen,
        // no borra los que solo una de ellas tiene.
        const merged = mergeProvenance(
            conExtra({ source: 'inferred' }),
            record({ source: 'witnessed' })
        ) as NoteProvenanceRecord & Record<string, unknown>;

        expect(merged['amountApproximate']).toBe(true);
    });

    it('el ganador manda cuando ambas filas traen el mismo campo extra', () => {
        const existing = { ...record({ source: 'inferred' }), etiqueta: 'vieja' } as never;
        const incoming = { ...record({ source: 'witnessed' }), etiqueta: 'nueva' } as never;

        const merged = mergeProvenance(existing, incoming) as never as Record<string, unknown>;

        expect(merged['etiqueta']).toBe('nueva');
    });
});
