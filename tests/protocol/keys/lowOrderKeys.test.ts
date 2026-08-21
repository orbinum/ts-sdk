/**
 * Claves de visión de orden bajo — el memo y el slip legibles sin ninguna clave.
 *
 * BabyJubJub tiene cofactor 8, así que la curva contiene un subgrupo pequeño.
 * Un punto de ese subgrupo tiene orden 1, 2, 4 u 8, y entonces `[ephSk]·P` toma
 * como mucho 8 valores por aleatorio que sea `ephSk`. Quien intercepte el
 * ciphertext los prueba todos.
 *
 * Sin la guarda, un memo sellado hacia la clave empaquetada de ceros —que es un
 * punto REAL de orden 4, no el neutro— suelta `value`, `blinding` y `sourcePk`
 * probando esos ocho candidatos, y un payment slip descifra igual.
 *
 * La comprobación de bytes a cero que protege las direcciones no lo cubre: ese
 * valor empaquetado no es degenerado a la vista, es un punto legítimo con y=0.
 */
import { describe, it, expect } from 'vitest';
import { mulPointEscalar, unpackPoint } from '@zk-kit/baby-jubjub';
import { hkdf } from '@noble/hashes/hkdf.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { chacha20poly1305 } from '@noble/ciphers/chacha.js';
import { NoteBuilder } from '../../../src/protocol/note/NoteBuilder';
import { sealPaymentSlip } from '../../../src/protocol/memo/PaymentSlip';
import { EncryptedMemo } from '../../../src/protocol/memo/EncryptedMemo';
import { PrivacyKeyManager } from '../../../src/protocol/keys/PrivacyKeyManager';
import { unpackUsableViewingKey } from '../../../src/foundation/crypto/bjj';
import {
    deriveViewingSecretKey,
    deriveViewingPublicKey,
    deriveOwnerPk,
} from '../../../src/protocol/keys/PrivacyKeys';
import { bytesToBigintLE, bigintTo32Le } from '../../../src/foundation/encoding/bytes';
import { fromHex, toHex } from '../../../src/foundation/encoding/hex';

/** El valor empaquetado de ceros: un punto de orden 4, no el elemento neutro. */
const LOW_ORDER_PACKED = new Uint8Array(32);
/** El neutro (0,1), cuyo "secreto" es constante para todo escalar. */
const IDENTITY_PACKED = bigintTo32Le(1n);

const realIvk = (sk: bigint): Uint8Array => deriveViewingPublicKey(deriveViewingSecretKey(sk));

describe('el validador reconoce el subgrupo pequeño', () => {
    it('rechaza la clave empaquetada de ceros, que es de orden 4', () => {
        // Se desempaqueta bien — por eso `unpackPoint` a secas no basta.
        expect(unpackPoint(bytesToBigintLE(LOW_ORDER_PACKED))).not.toBeNull();
        expect(unpackUsableViewingKey(bytesToBigintLE(LOW_ORDER_PACKED))).toBeNull();
    });

    it('rechaza el elemento neutro', () => {
        expect(unpackUsableViewingKey(bytesToBigintLE(IDENTITY_PACKED))).toBeNull();
    });

    it('acepta claves de visión reales', () => {
        for (const sk of [777n, 111n, 12345n]) {
            expect(unpackUsableViewingKey(bytesToBigintLE(realIvk(sk)))).not.toBeNull();
        }
    });

    it('el punto rechazado tiene de verdad orden 4', () => {
        // Documenta POR QUÉ se rechaza: [k]P sólo toma cuatro valores.
        const point = unpackPoint(bytesToBigintLE(LOW_ORDER_PACKED))!;
        const seen = new Set<string>();
        for (let k = 1n; k <= 64n; k++) {
            const r = mulPointEscalar(point, k);
            seen.add(`${r[0]},${r[1]}`);
        }

        expect(seen.size).toBe(4);
    });
});

describe('las tres fronteras rechazan una clave de orden bajo', () => {
    it('NoteBuilder no sella un memo hacia ella', async () => {
        await expect(
            NoteBuilder.build({
                value: 424242n,
                assetId: 0n,
                ownerPk: deriveOwnerPk(111n),
                recipientOwnerPk: deriveOwnerPk(111n),
                viewingPublicKey: LOW_ORDER_PACKED,
                sourcePk: 7n,
            })
        ).rejects.toThrow(/viewing public key/);
    });

    it('sealPaymentSlip no sella un slip hacia ella', () => {
        expect(() =>
            sealPaymentSlip(LOW_ORDER_PACKED, {
                commitmentHex: '0x' + 'ab'.repeat(32),
                encryptedMemo: '0x' + 'cd'.repeat(180),
            })
        ).toThrow(/viewing public key/);
    });

    it('una dirección de privacidad que la lleve no decodifica', () => {
        // La frontera que más importa: una dirección es lo que entrega un
        // desconocido, la única de las tres que el atacante elige libremente.
        const pk = toHex(bigintTo32Le(deriveOwnerPk(111n)));
        const ivk = toHex(LOW_ORDER_PACKED);

        expect(PrivacyKeyManager.decodePrivacyAddress(`orbpriv1:${pk}:${ivk}`)).toBeNull();
    });

    it('y una dirección con una ivk real sí decodifica', () => {
        const pk = toHex(bigintTo32Le(deriveOwnerPk(111n)));
        const ivk = toHex(realIvk(777n));

        expect(PrivacyKeyManager.decodePrivacyAddress(`orbpriv1:${pk}:${ivk}`)).not.toBeNull();
    });
});

describe('EL ATAQUE que esto cierra', () => {
    /** Los 8 secretos posibles contra un punto del subgrupo pequeño. */
    const candidateSecrets = (packed: Uint8Array): Uint8Array[] => {
        const point = unpackPoint(bytesToBigintLE(packed))!;
        return Array.from({ length: 8 }, (_, i) =>
            bigintTo32Le(mulPointEscalar(point, BigInt(i + 1))[0])
        );
    };

    it('un memo sellado hacia orden bajo se abría probando 8 secretos', async () => {
        // Construido saltándose la guarda, para que el ataque siga siendo
        // ejecutable y el test demuestre que la guarda es lo único que lo para.
        const memo = EncryptedMemo.encrypt(
            424242n,
            bigintTo32Le(deriveOwnerPk(111n)),
            bigintTo32Le(99n),
            0,
            fromHex('0x' + 'ab'.repeat(32)),
            LOW_ORDER_PACKED,
            bigintTo32Le(7n),
            1
        );

        let recovered: bigint | null = null;
        for (const secret of candidateSecrets(LOW_ORDER_PACKED)) {
            const plaintext = EncryptedMemo.decryptWithSharedSecret(
                memo,
                fromHex('0x' + 'ab'.repeat(32)),
                secret
            );
            if (plaintext) {
                recovered = plaintext.value;
                break;
            }
        }

        // El ataque FUNCIONA sobre el primitivo — por eso la puerta está arriba,
        // en quien elige la clave, y no aquí.
        expect(recovered).toBe(424242n);
    });

    it('pero NoteBuilder ya no deja construir esa nota', async () => {
        await expect(
            NoteBuilder.build({
                value: 424242n,
                assetId: 0n,
                ownerPk: deriveOwnerPk(111n),
                recipientOwnerPk: deriveOwnerPk(111n),
                viewingPublicKey: LOW_ORDER_PACKED,
            })
        ).rejects.toThrow();
    });

    it('un slip hacia una ivk REAL no cae con esos 8 secretos', () => {
        // El contraste: con una clave del subgrupo grande, los 8 candidatos no
        // sirven de nada.
        const envelope = sealPaymentSlip(realIvk(777n), {
            commitmentHex: '0x' + 'ab'.repeat(32),
            encryptedMemo: '0x' + 'cd'.repeat(180),
        });

        const nonce = new Uint8Array(12);
        nonce.set(new TextEncoder().encode('SLP1'), 0);
        nonce.set(envelope.slice(32, 40), 4);
        const domain = new TextEncoder().encode('orbinum-payment-slip-v1');

        let opened = false;
        for (const secret of candidateSecrets(LOW_ORDER_PACKED)) {
            try {
                chacha20poly1305(hkdf(sha256, secret, undefined, domain, 32), nonce).decrypt(
                    envelope.slice(40)
                );
                opened = true;
            } catch {
                // Secreto equivocado: es lo que debe pasar.
            }
        }

        expect(opened).toBe(false);
    });
});

/**
 * La dirección de LECTURA, que era la que faltaba.
 *
 * Sellar hacia una clave de orden bajo ya estaba cerrado. Abrir un memo o un
 * slip cuyo ephPk lo es, no: `unpackPoint` los acepta, y ese punto lo elige
 * QUIEN ENVÍA — llega por un feed que nadie controla. El secreto compartido
 * colapsa entonces a ocho valores enumerables.
 *
 * Devolver null es lo correcto: un ephPk así no es una clave utilizable, y
 * seguir adelante con él es hacer criptografía con un secreto público.
 */
describe('la ruta de ENTRADA también rechaza el orden bajo', () => {
    it('extractSharedSecret devuelve null ante un ephPk de orden bajo', () => {
        // El NEUTRO, no la codificación de ceros: ésa cae antes en la rama del
        // memo público (ephPk cero = "sin destinatario"). El neutro empaquetado
        // es `0x01`, así que llega hasta el guard — y su "secreto compartido"
        // es constante para cualquier escalar.
        const memo = new Uint8Array(180);
        memo.set(IDENTITY_PACKED, 148);

        expect(EncryptedMemo.extractSharedSecret(memo, bigintTo32Le(777n))).toBeNull();
    });

    it('y un ephPk REAL sigue dando secreto', () => {
        // El contraste: sin él, un `return null` incondicional pasaría el test
        // anterior y rompería el escaneo entero.
        const memo = new Uint8Array(180);
        memo.set(realIvk(777n), 148);

        expect(EncryptedMemo.extractSharedSecret(memo, bigintTo32Le(111n))).not.toBeNull();
    });

    it('un memo público (ephPk todo ceros) sigue devolviendo el secreto cero', () => {
        // Convención de wire: ephPk cero significa "sin destinatario". Tiene que
        // seguir distinguiéndose de un rechazo.
        const memo = new Uint8Array(180);

        expect(EncryptedMemo.extractSharedSecret(memo, bigintTo32Le(111n))).toEqual(
            new Uint8Array(32)
        );
    });
});
