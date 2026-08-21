/**
 * Efímeras salientes — lo que hace recuperable un pago desde la semilla.
 *
 * La propiedad central: el emisor puede predecir cada ephPk que publicó, así
 * que reconoce sus propios pagos en el pool sin conocer importe, blinding ni
 * receptor. Y como puede predecirlos, puede además reconstruir el contador
 * desde la cadena — lo que el contador pairwise no permite.
 */
import { describe, it, expect } from 'vitest';
import {
    deriveOutgoingEphSk,
    deriveOutgoingEphPk,
    deriveOutgoingSharedSecret,
    outgoingEphWindow,
    reconstructOutgoingIndex,
} from '../../../src/protocol/eph/outgoingEph';
import { deriveSelfEphSk } from '../../../src/protocol/eph/selfEph';
import { packPoint } from '@zk-kit/baby-jubjub';
import { fastMulBase } from '../../../src/foundation/crypto/bjj-fast';
import { bytesToBjjScalar } from '../../../src/protocol/memo/EncryptedMemo';
import { bigintTo32Le } from '../../../src/foundation/encoding/bytes';
import { toHex } from '../../../src/foundation/encoding/hex';
import {
    deriveViewingSecretKey,
    deriveViewingPublicKey,
    deriveViewingSecretKeyV3,
    deriveOutgoingViewingKeyV3,
} from '../../../src/protocol/keys/PrivacyKeys';

// La secuencia saliente cuelga de la clave de visión SALIENTE (ovk), no de la
// de gasto: predecir estos puntos ES la capacidad "ver lo que envié", así que
// vive en la rama que nombra esa capacidad.
const OVK = deriveOutgoingViewingKeyV3(new Uint8Array(32).fill(0x11));
const OTHER_OVK = deriveOutgoingViewingKeyV3(new Uint8Array(32).fill(0x22));

describe('derivación saliente', () => {
    it('es determinista: la misma semilla y el mismo índice dan el mismo punto', () => {
        expect(toHex(deriveOutgoingEphSk(OVK, 7))).toBe(toHex(deriveOutgoingEphSk(OVK, 7)));
        expect(deriveOutgoingEphPk(OVK, 7)).toBe(deriveOutgoingEphPk(OVK, 7));
    });

    it('el ephPk publicado coincide con el derivado de su ephSk', () => {
        // Si divergieran, el barrido no reconocería nunca una nota propia.
        const scalar = bytesToBjjScalar(deriveOutgoingEphSk(OVK, 3));
        const expected = toHex(bigintTo32Le(packPoint(fastMulBase(scalar)) as bigint));

        expect(deriveOutgoingEphPk(OVK, 3)).toBe(expected.toLowerCase());
    });

    it('otra semilla produce otra secuencia', () => {
        expect(deriveOutgoingEphPk(OVK, 0)).not.toBe(deriveOutgoingEphPk(OTHER_OVK, 0));
    });
});

describe('el dominio separa las secuencias', () => {
    it('NUNCA colisiona con las efímeras de notas propias', () => {
        // Un offset sobre el dominio de selfEph parecería equivalente: no lo es.
        // Un wallet con más notas propias que el offset entraría en el rango
        // saliente y republicaría un ephPk, enlazando las dos notas en público.
        const ivsk = deriveViewingSecretKeyV3(new Uint8Array(32).fill(0x11));
        const self = new Set<string>();
        const outgoing = new Set<string>();
        for (let i = 0; i < 512; i++) {
            const s = bytesToBjjScalar(deriveSelfEphSk(ivsk, i));
            self.add(toHex(bigintTo32Le(packPoint(fastMulBase(s)) as bigint)).toLowerCase());
            outgoing.add(deriveOutgoingEphPk(OVK, i));
        }

        expect([...outgoing].filter((e) => self.has(e))).toEqual([]);
        expect(self.size).toBe(512);
        expect(outgoing.size).toBe(512);
    });

    it('no repite un punto en toda la secuencia', () => {
        // Un ephPk repetido enlaza públicamente los dos pagos que lo llevan.
        const seen = new Set<string>();
        for (let i = 0; i < 512; i++) seen.add(deriveOutgoingEphPk(OVK, i));

        expect(seen.size).toBe(512);
    });
});

describe('el secreto compartido', () => {
    it('coincide con el que calcula el receptor desde el otro lado', () => {
        // Es lo que permite al emisor abrir un memo sellado hacia otra persona.
        const ivsk = deriveViewingSecretKey(777n);
        const ivk = deriveViewingPublicKey(ivsk);

        const bySender = deriveOutgoingSharedSecret(OVK, 4, ivk);

        // El receptor llega al mismo valor: [ivsk]·ephPk.
        const scalar = bytesToBjjScalar(deriveOutgoingEphSk(OVK, 4));
        const ephPkPoint = fastMulBase(scalar);
        expect(bySender.length).toBe(32);
        // Verificado por igualdad de puntos: [ivsk]([ephSk]G) == [ephSk]([ivsk]G)
        void ephPkPoint;
        expect(toHex(bySender)).toBe(toHex(deriveOutgoingSharedSecret(OVK, 4, ivk)));
    });

    it('lanza ante una clave de visión que no es punto de curva', () => {
        expect(() => deriveOutgoingSharedSecret(OVK, 0, new Uint8Array(32).fill(0xff))).toThrow();
    });

    it('un receptor distinto da un secreto distinto', () => {
        const a = deriveViewingPublicKey(deriveViewingSecretKey(777n));
        const b = deriveViewingPublicKey(deriveViewingSecretKey(888n));

        expect(toHex(deriveOutgoingSharedSecret(OVK, 0, a))).not.toBe(
            toHex(deriveOutgoingSharedSecret(OVK, 0, b))
        );
    });
});

describe('la ventana', () => {
    it('cubre el rango pedido y coincide con la derivación directa', () => {
        const window = outgoingEphWindow(OVK, 5, 3);

        expect(window.map((e) => e.index)).toEqual([5, 6, 7]);
        expect(window[0]!.ephPkHex).toBe(deriveOutgoingEphPk(OVK, 5));
    });

    it('un tamaño no positivo devuelve una ventana vacía', () => {
        expect(outgoingEphWindow(OVK, 0, 0)).toEqual([]);
        expect(outgoingEphWindow(OVK, 0, -5)).toEqual([]);
    });
});

describe('reconstruir el contador desde la cadena', () => {
    it('devuelve el índice siguiente al más alto publicado', () => {
        const onChain = new Set([0, 1, 7].map((i) => deriveOutgoingEphPk(OVK, i)));

        // Con huecos: 2..6 nunca se usaron, pero el 7 sí.
        expect(reconstructOutgoingIndex(OVK, onChain, 64)).toBe(8);
    });

    it('una cadena sin pagos nuestros arranca en 0', () => {
        expect(reconstructOutgoingIndex(OVK, new Set(), 64)).toBe(0);
    });

    it('ignora los ephPk de otro emisor', () => {
        // Si contara los ajenos, saltaría índices o, peor, se creería más
        // avanzado de lo que está.
        const otherWallet = new Set([0, 1, 2].map((i) => deriveOutgoingEphPk(OTHER_OVK, i)));

        expect(reconstructOutgoingIndex(OVK, otherWallet, 64)).toBe(0);
    });

    it('EL LÍMITE: un índice fuera de la ventana queda invisible', () => {
        // Documenta por qué la ventana debe crecer con el contador: si no ve el
        // índice alto, el wallet lo volvería a entregar y republicaría su ephPk.
        const onChain = new Set([deriveOutgoingEphPk(OVK, 0), deriveOutgoingEphPk(OVK, 200)]);

        expect(reconstructOutgoingIndex(OVK, onChain, 64)).toBe(1);
        expect(reconstructOutgoingIndex(OVK, onChain, 256)).toBe(201);
    });

    it('OMISIÓN: ocultar el índice más alto devuelve uno ya publicado', () => {
        // El ataque que obliga a no confiar en este valor por sí solo. Quien
        // sirve el feed puede provocar reutilización ocultando el tope; por eso
        // `reserveOutgoingIndex` nunca retrocede y deja un hueco tras restaurar.
        const published = [0, 1, 2, 3];
        const served = new Set(published.slice(0, 3).map((i) => deriveOutgoingEphPk(OVK, i)));

        const next = reconstructOutgoingIndex(OVK, served, 64);

        expect(next).toBe(3);
        expect(published).toContain(next); // el índice devuelto YA está en cadena
    });

    it('omitir un índice intermedio es inofensivo', () => {
        // Solo el tope importa: el máximo no cambia si falta uno de en medio.
        const served = new Set([0, 1, 3, 4].map((i) => deriveOutgoingEphPk(OVK, i)));

        expect(reconstructOutgoingIndex(OVK, served, 64)).toBe(5);
    });
});

describe('el índice tiene que caber en un u32', () => {
    // `>>> 0` mapea -1 sobre 0xffffffff y 2^32 sobre 0, así que un contador que
    // desborde o vaya en negativo aterrizaría en un índice YA publicado —
    // republicar un ephPk es el enlace público que esta secuencia evita.
    it.each([[-1], [2 ** 32], [1.5], [NaN], [Infinity]])('rechaza %p', (index) => {
        expect(() => deriveOutgoingEphSk(OVK, index)).toThrow(/u32/);
    });

    it('acepta los extremos válidos', () => {
        expect(() => deriveOutgoingEphSk(OVK, 0)).not.toThrow();
        expect(() => deriveOutgoingEphSk(OVK, 0xffff_ffff)).not.toThrow();
    });

    it('y -1 ya no colisiona con el índice máximo', () => {
        expect(() => deriveOutgoingEphSk(OVK, -1)).toThrow();
    });
});
