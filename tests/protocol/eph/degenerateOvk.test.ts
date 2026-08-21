/**
 * Una clave saliente degenerada es una secuencia PÚBLICA, no una débil.
 *
 * SHA256 responde a cualquier entrada, así que un ovk vacío o todo a ceros — la
 * forma que toma un campo ausente o un buffer sin inicializar — produce
 * efímeras que cualquiera recomputa. Eso hace cada pago reconocible como de
 * este wallet y abre su libreta de receptores, porque el keystream de la
 * libreta cuelga de la misma clave.
 *
 * Es el mismo fallo que tenía la ivk a ceros en una dirección de privacidad,
 * alcanzado desde el otro lado.
 */
import { describe, it, expect } from 'vitest';
import { deriveOutgoingEphSk, deriveOutgoingEphPk } from '../../../src/protocol/eph/outgoingEph';
import {
    sealRecipientBookEntry,
    openRecipientBookEntry,
} from '../../../src/protocol/note/recipientBook';
import { deriveOutgoingViewingKeyV3 } from '../../../src/protocol/keys/PrivacyKeys';

const ZERO = new Uint8Array(32);
const COMMITMENT = '0x' + 'ab'.repeat(32);
const GOOD = deriveOutgoingViewingKeyV3(new Uint8Array(32).fill(0x42));

describe('la secuencia saliente rechaza una clave degenerada', () => {
    it.each([
        ['todo ceros', ZERO],
        ['vacía', new Uint8Array(0)],
        ['16 bytes', new Uint8Array(16).fill(0x11)],
        ['33 bytes', new Uint8Array(33).fill(0x11)],
    ])('rechaza una ovk %s', (_label, ovk) => {
        expect(() => deriveOutgoingEphSk(ovk, 0)).toThrow();
        expect(() => deriveOutgoingEphPk(ovk, 0)).toThrow();
    });

    it('acepta una ovk real', () => {
        expect(() => deriveOutgoingEphSk(GOOD, 0)).not.toThrow();
    });
});

describe('la libreta rechaza la misma clave degenerada', () => {
    // Guardada por separado: las dos derivan de la misma clave por caminos
    // distintos, y una guarda en una no es una guarda en la otra.
    it.each([
        ['todo ceros', ZERO],
        ['vacía', new Uint8Array(0)],
        ['16 bytes', new Uint8Array(16).fill(0x11)],
    ])('no sella bajo una ovk %s', (_label, ovk) => {
        const ivk = new Uint8Array(32).fill(0x77);
        expect(() => sealRecipientBookEntry(ivk, ovk, COMMITMENT)).toThrow();
    });

    it('no abre bajo una ovk degenerada', () => {
        expect(() => openRecipientBookEntry(1n, ZERO, COMMITMENT)).toThrow();
    });

    it('LO QUE ESTO IMPIDE: con ovk cero, un tercero abría la libreta entera', () => {
        // Antes de la guarda: el keystream solo dependía de (ovk, commitment),
        // así que un atacante que supusiera ovk=ceros recomputaba el keystream y
        // leía la ivk del receptor en claro. XOR es su propia inversa.
        const ivk = new Uint8Array(32).fill(0x77);

        expect(() => {
            const sealed = sealRecipientBookEntry(ivk, ZERO, COMMITMENT);
            return sealRecipientBookEntry(sealed, ZERO, COMMITMENT);
        }).toThrow();
    });
});
