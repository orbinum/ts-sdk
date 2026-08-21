/**
 * La dirección es una cadena PEGADA por el usuario, y el checksum no la
 * autentica: es SHA256 sin clave, así que cualquiera puede forjar uno que
 * cuadre. Lo único que separa un texto pegado del constructor de notas son las
 * comprobaciones de campo que se prueban aquí.
 */
import { describe, it, expect } from 'vitest';
import { sha256 } from '@noble/hashes/sha2.js';
import { PrivacyKeyManager } from '../../../src/protocol/keys/PrivacyKeyManager';
import { NoteBuilder } from '../../../src/protocol/note/NoteBuilder';
import { EncryptedMemo } from '../../../src/protocol/memo/EncryptedMemo';
import {
    deriveViewingSecretKey,
    deriveViewingPublicKey,
} from '../../../src/protocol/keys/PrivacyKeys';
import { bigintTo32Le } from '../../../src/foundation/encoding/bytes';
import { toHex, fromHex } from '../../../src/foundation/encoding/hex';

/** Una dirección con checksum VÁLIDO para el cuerpo que se le dé. */
function forge(scheme: string, ownerPkHex: string, ivkHex: string): string {
    const body = `${scheme}:${ownerPkHex}:${ivkHex}`;
    const checksum = toHex(sha256(new TextEncoder().encode(body)).slice(0, 4)).slice(2);
    return `${body}:${checksum}`;
}

const REAL_PK = toHex(bigintTo32Le(12345n));
const REAL_IVK = toHex(deriveViewingPublicKey(deriveViewingSecretKey(999n)));
const ZERO = toHex(new Uint8Array(32));

describe('una clave de visión CERO se rechaza', () => {
    it('el caso: es la convención de "nota pública" en el memo', async () => {
        // `EncryptedMemo.encrypt` lee una ivk de ceros como "sin destinatario":
        // secreto compartido cero, ephPk cero, memo legible por cualquiera. Una
        // dirección que anuncie eso hace que el emisor publique en claro
        // creyendo que pagó en privado.
        const note = await NoteBuilder.build({
            value: 777n,
            assetId: 0n,
            blinding: 1n,
            ownerPk: 12345n,
            viewingPublicKey: new Uint8Array(32),
            circuitVersion: 1,
        });

        const anyone = EncryptedMemo.decrypt(
            Uint8Array.from(note.memo),
            fromHex(note.commitmentHex),
            new Uint8Array(32)
        );

        expect(anyone?.value).toBe(777n); // así de expuesto queda
    });

    it('por eso la dirección no llega nunca al constructor', () => {
        expect(PrivacyKeyManager.decodePrivacyAddress(forge('orbpriv3', REAL_PK, ZERO))).toBeNull();
        expect(PrivacyKeyManager.decodePrivacyAddress(forge('orbpriv2', REAL_PK, ZERO))).toBeNull();
    });

    it('tampoco por la vía legacy, que no tiene checksum alguno', () => {
        // `orbpriv1` es la más fácil de forjar: ni siquiera hay suma que cuadrar.
        expect(PrivacyKeyManager.decodePrivacyAddress(`orbpriv1:${REAL_PK}:${ZERO}`)).toBeNull();
    });

    it('y un ownerPk cero tampoco, porque nadie podría gastar esa nota', () => {
        expect(
            PrivacyKeyManager.decodePrivacyAddress(forge('orbpriv3', ZERO, REAL_IVK))
        ).toBeNull();
    });
});

describe('los campos tienen que ser hex de 32 bytes', () => {
    it.each([
        ['texto que no es hex', 'NOT_HEX_AT_ALL', '<script>alert(1)</script>'],
        ['demasiado corto', '0xab', REAL_IVK],
        ['demasiado largo', '0x' + 'ab'.repeat(33), REAL_IVK],
        ['sin prefijo 0x', 'ab'.repeat(32), REAL_IVK],
    ])('rechaza %s aunque el checksum cuadre', (_label, pk, ivk) => {
        expect(PrivacyKeyManager.decodePrivacyAddress(forge('orbpriv3', pk, ivk))).toBeNull();
    });

    it('la vía legacy aplica las mismas reglas', () => {
        expect(PrivacyKeyManager.decodePrivacyAddress('orbpriv1:NOT_HEX:0xcd')).toBeNull();
    });
});

describe('una identidad tiene UNA dirección, no dos', () => {
    it('el hex en mayúsculas decodifica a los mismos campos, en minúsculas', () => {
        // Sin normalizar, `0xAB…` y `0xab…` serían dos direcciones válidas y
        // byte-distintas para la misma persona, y un host que deduplique por
        // cadena vería dos destinatarios.
        const upper = forge('orbpriv3', REAL_PK.toUpperCase(), REAL_IVK.toUpperCase());
        const lower = forge('orbpriv3', REAL_PK, REAL_IVK);

        const a = PrivacyKeyManager.decodePrivacyAddress(upper);
        const b = PrivacyKeyManager.decodePrivacyAddress(lower);

        expect(a).not.toBeNull();
        expect(a).toEqual(b);
    });
});

describe('lo válido sigue funcionando', () => {
    it('una dirección real decodifica', () => {
        const addr = forge('orbpriv3', REAL_PK, REAL_IVK);

        expect(PrivacyKeyManager.decodePrivacyAddress(addr)).toEqual({
            ownerPkHex: REAL_PK,
            viewingPublicKeyHex: REAL_IVK,
            scheme: 'orbpriv3',
        });
    });
});
