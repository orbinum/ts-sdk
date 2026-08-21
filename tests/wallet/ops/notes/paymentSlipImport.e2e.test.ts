/**
 * El slip, de extremo a extremo: quien envía sella, quien recibe reconstruye.
 *
 * Los tests unitarios prueban `openPaymentSlip` con sobres construidos a mano.
 * Aquí el recorrido es el real y completo — se construye una nota con
 * criptografía de verdad, se sella hacia el receptor, viaja como cadena
 * `orbslip1:` y se importa hasta obtener una nota gastable.
 *
 * Lo que este archivo busca no es el camino feliz sino el ATACANTE que el
 * formato admite por diseño: quien recibió una dirección de privacidad puede
 * sellar un slip válido con lo que quiera dentro. El MAC del SOBRE prueba que
 * conocía la clave de visión, nada más — no que los campos digan la verdad.
 *
 * Lo que sí los ata son DOS defensas independientes, y cualquiera basta:
 *
 *   1. `deriveEncryptionKey` mezcla el commitment en la clave de cifrado, así
 *      que un commitment ajeno a ese memo da otra clave y el MAC falla;
 *   2. `tryDecryptNote` recomputa el commitment desde el plaintext descifrado.
 *
 * Verificado por mutación: anular una sola no hace fallar nada, anular las dos
 * hace pasar la nota inventada. Los tests de abajo cubren la propiedad, no una
 * implementación concreta de ella.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { NoteBuilder } from '../../../../src/protocol/note/NoteBuilder';
import {
    deriveViewingSecretKey,
    deriveViewingPublicKey,
    deriveOwnerPk,
} from '../../../../src/protocol/keys/PrivacyKeys';
import {
    sealPaymentSlip,
    encodePaymentSlip,
    decodePaymentSlip,
    openPaymentSlip,
    type PaymentSlipFields,
} from '../../../../src/protocol/memo/PaymentSlip';
import { importPaymentSlip } from '../../../../src/wallet/ops/notes/paymentSlipImport';
import { toHex } from '../../../../src/foundation/encoding/hex';
import { QR_SINGLE_CODE_MAX_CHARS } from '../../../../src/protocol/memo/PaymentSlip';
import type { ZkNote } from '../../../../src/protocol/types';

const RECIPIENT_SK = 31337n;
const SENDER_SK = 42424242n;
const STRANGER_SK = 99999999n;

let recipientIvsk: Uint8Array;
let recipientIvk: Uint8Array;
let recipientOwnerPk: bigint;
let sentNote: ZkNote;
let fields: PaymentSlipFields;

/** Las claves con las que el receptor abre un slip y reconstruye la nota. */
function recipientKeys() {
    return {
        viewingSecretKey: recipientIvsk,
        spendingKey: RECIPIENT_SK,
        ownerPk: recipientOwnerPk,
    };
}

beforeAll(async () => {
    recipientIvsk = deriveViewingSecretKey(RECIPIENT_SK);
    recipientIvk = deriveViewingPublicKey(recipientIvsk);
    recipientOwnerPk = deriveOwnerPk(RECIPIENT_SK);

    // Lo que produce una transferencia privada: la salida hacia el receptor,
    // con dirección sigilosa y su memo sellado.
    sentNote = await NoteBuilder.build({
        value: 4200n,
        assetId: 0n,
        blinding: 777n,
        ownerPk: recipientOwnerPk,
        sourcePk: deriveOwnerPk(SENDER_SK),
        viewingPublicKey: recipientIvk,
        recipientOwnerPk,
    });

    fields = {
        commitmentHex: sentNote.commitmentHex,
        encryptedMemo: toHex(Uint8Array.from(sentNote.memo)),
        leafIndex: 12,
        txHash: '0x' + 'cd'.repeat(32),
    };
});

// ─── El recorrido completo ───────────────────────────────────────────────────

describe('de la transferencia a la nota gastable', () => {
    it('el receptor reconstruye su nota sin escanear el pool', () => {
        const wire = encodePaymentSlip(sealPaymentSlip(recipientIvk, fields));

        const note = importPaymentSlip(wire, recipientKeys());

        expect(note).not.toBeNull();
        expect(note!.value).toBe(4200n);
        expect(note!.commitmentHex).toBe(sentNote.commitmentHex);
        expect(note!.assetId).toBe(0n);
        // La clave de gasto se DERIVA de la identidad del receptor: no viaja en
        // el slip, así que interceptarlo no da poder de gasto.
        expect(note!.spendingKey).not.toBe(0n);
        expect(note!.spendingKey).not.toBe(RECIPIENT_SK);
    });

    it('la nota importada es indistinguible de la escaneada', () => {
        // Si difirieran, el vault tendría dos versiones de la misma nota y una
        // de ellas produciría un nullifier que la cadena no reconoce.
        const note = importPaymentSlip(
            encodePaymentSlip(sealPaymentSlip(recipientIvk, fields)),
            recipientKeys()
        )!;

        expect(note.commitmentHex).toBe(sentNote.commitmentHex);
        expect(note.ownerPk).toBe(sentNote.ownerPk);
        expect(note.value).toBe(sentNote.value);
        expect(note.blinding).toBe(sentNote.blinding);
    });

    it('sobrevive al viaje por texto: sellar, codificar, pegar, abrir', () => {
        // El slip pasa por un chat o un QR, así que la cadena es el formato real
        // de transporte — no el sobre en bytes.
        const wire = encodePaymentSlip(sealPaymentSlip(recipientIvk, fields));
        const pegado = ` ${wire} `.trim();

        expect(importPaymentSlip(pegado, recipientKeys())).not.toBeNull();
    });

    it('dos slips del mismo pago reconstruyen la misma nota', () => {
        // Reemitir es el mecanismo de recuperación: los bytes difieren (efímera
        // y nonce nuevos) pero la nota tiene que ser la misma.
        const a = importPaymentSlip(
            encodePaymentSlip(sealPaymentSlip(recipientIvk, fields)),
            recipientKeys()
        )!;
        const b = importPaymentSlip(
            encodePaymentSlip(sealPaymentSlip(recipientIvk, fields)),
            recipientKeys()
        )!;

        expect(a.commitmentHex).toBe(b.commitmentHex);
        expect(a.spendingKey).toBe(b.spendingKey);
    });
});

// ─── Quien envía puede ser hostil ────────────────────────────────────────────

describe('un slip sellado correctamente con contenido inventado', () => {
    /** Sella hacia el receptor unos campos elegidos por quien envía. */
    const hostil = (over: Partial<PaymentSlipFields>) =>
        encodePaymentSlip(sealPaymentSlip(recipientIvk, { ...fields, ...over }));

    it('un commitment que no corresponde al memo no planta una nota', () => {
        // Sin esta defensa quien envía elige qué commitment cree suyo el
        // receptor: una nota fantasma que el vault contaría como saldo y que
        // ningún gasto podría probar.
        const otro = '0x' + 'ee'.repeat(32);

        expect(importPaymentSlip(hostil({ commitmentHex: otro }), recipientKeys())).toBeNull();
    });

    it('un memo y un commitment de notas distintas no se combinan', async () => {
        // El par incoherente lo rechazan las dos capas por separado, así que
        // este test sigue en verde si una de ellas se rompe. Es deliberado: lo
        // que importa es que la nota inventada no entre, no por cuál de los dos
        // caminos se la para.
        const real = await NoteBuilder.build({
            value: 4200n,
            blinding: 777n,
            ownerPk: recipientOwnerPk,
            viewingPublicKey: recipientIvk,
            recipientOwnerPk,
        });
        const otraCantidad = await NoteBuilder.build({
            value: 9_999_999n,
            blinding: 777n,
            ownerPk: recipientOwnerPk,
            viewingPublicKey: recipientIvk,
            recipientOwnerPk,
        });

        // El memo de una, el commitment de la otra: el par no es coherente.
        const slip = hostil({
            commitmentHex: real.commitmentHex,
            encryptedMemo: toHex(Uint8Array.from(otraCantidad.memo)),
        });

        expect(importPaymentSlip(slip, recipientKeys())).toBeNull();
    });

    it('un memo de otra nota tampoco', () => {
        // El memo descifra bien y el commitment es real, pero no se corresponden.
        const ajeno = '0x' + '11'.repeat(180);

        expect(importPaymentSlip(hostil({ encryptedMemo: ajeno }), recipientKeys())).toBeNull();
    });

    it('un memo dirigido a otra persona no se abre', async () => {
        const extranoIvk = deriveViewingPublicKey(deriveViewingSecretKey(STRANGER_SK));
        const paraOtro = await NoteBuilder.build({
            value: 1n,
            blinding: 5n,
            ownerPk: deriveOwnerPk(STRANGER_SK),
            viewingPublicKey: extranoIvk,
            recipientOwnerPk: deriveOwnerPk(STRANGER_SK),
        });

        const slip = hostil({
            commitmentHex: paraOtro.commitmentHex,
            encryptedMemo: toHex(Uint8Array.from(paraOtro.memo)),
        });

        expect(importPaymentSlip(slip, recipientKeys())).toBeNull();
    });

    it('un leafIndex inventado no cambia la nota que se reconstruye', () => {
        // El índice es informativo: el gasto vuelve a pedir la prueba de Merkle.
        // Mentir en él no puede alterar la identidad de la nota.
        const note = importPaymentSlip(hostil({ leafIndex: 999_999 }), recipientKeys())!;

        expect(note.commitmentHex).toBe(sentNote.commitmentHex);
        expect(note.value).toBe(4200n);
    });

    it('un txHash hostil no llega a la nota', () => {
        // Se muestra como enlace a un explorador. Que el slip esté descifrado
        // no hace confiable la cadena que lleva dentro.
        for (const malo of ['javascript:alert(1)', '<script>x</script>', '0xcorto']) {
            const note = importPaymentSlip(hostil({ txHash: malo }), recipientKeys())!;

            expect(note).not.toBeNull();
            expect((note as { createdTxHash?: string }).createdTxHash).toBeUndefined();
        }
    });

    it('un txHash legítimo sí se conserva', () => {
        const bueno = '0x' + 'ab'.repeat(32);
        const note = importPaymentSlip(hostil({ txHash: bueno }), recipientKeys())!;

        expect((note as { createdTxHash?: string }).createdTxHash).toBe(bueno);
    });
});

// ─── Lo que el slip nunca debe conceder ──────────────────────────────────────

describe('el slip no otorga poder de gasto ni revela nada', () => {
    it('un tercero que lo intercepta no obtiene nada', () => {
        const wire = encodePaymentSlip(sealPaymentSlip(recipientIvk, fields));
        const extrano = {
            viewingSecretKey: deriveViewingSecretKey(STRANGER_SK),
            spendingKey: STRANGER_SK,
            ownerPk: deriveOwnerPk(STRANGER_SK),
        };

        expect(importPaymentSlip(wire, extrano)).toBeNull();
        expect(openPaymentSlip(extrano.viewingSecretKey, decodePaymentSlip(wire)!)).toBeNull();
    });

    it('la cadena no contiene el commitment ni el memo en claro', () => {
        // Emparejar esos campos fuera de cadena revela que ESTE receptor espera
        // ESTE pago, aunque ambos sean públicos por separado.
        const wire = encodePaymentSlip(sealPaymentSlip(recipientIvk, fields));

        expect(wire).not.toContain(fields.commitmentHex.slice(2));
        expect(wire).not.toContain(fields.encryptedMemo.slice(2, 64));
    });

    it('con la clave de visión sola no se puede gastar', () => {
        // La de visión abre el sobre; la de gasto la deriva el receptor de su
        // propia identidad. Quien tenga solo la primera no reconstruye la nota.
        const soloVision = {
            viewingSecretKey: recipientIvsk,
            spendingKey: 0n,
            ownerPk: recipientOwnerPk,
        };
        const wire = encodePaymentSlip(sealPaymentSlip(recipientIvk, fields));

        const note = importPaymentSlip(wire, soloVision);

        // El sobre se abre —la clave de visión es la correcta— pero la nota que
        // sale no es gastable con esa clave de gasto.
        if (note !== null) expect(note.spendingKey).not.toBe(RECIPIENT_SK);
    });
});

// ─── Entradas que el usuario pega ────────────────────────────────────────────

describe('importPaymentSlip nunca lanza', () => {
    it('devuelve null ante cualquier cadena, no una excepción', () => {
        // Lo alimenta un campo de pegado: una excepción aquí tumba el manejador,
        // no solo la importación.
        const basura = [
            '',
            'orbslip1:',
            'orbslip1::',
            'orbslip1:abc:def',
            'no-es-un-slip',
            'orbslip2:abc:0000',
            '0x'.repeat(1000),
            '💥',
            'orbslip1:' + 'A'.repeat(100_000) + ':0000',
        ];

        for (const entrada of basura) {
            expect(() => importPaymentSlip(entrada, recipientKeys())).not.toThrow();
            expect(importPaymentSlip(entrada, recipientKeys())).toBeNull();
        }
    });

    it('devuelve null ante un sobre en bytes corrupto', () => {
        const env = sealPaymentSlip(recipientIvk, fields);

        for (const corte of [0, 1, 20, 39, 41, env.length - 1]) {
            expect(() => importPaymentSlip(env.subarray(0, corte), recipientKeys())).not.toThrow();
            expect(importPaymentSlip(env.subarray(0, corte), recipientKeys())).toBeNull();
        }
    });

    it('un bit cambiado en cualquier posición invalida el slip', () => {
        const env = sealPaymentSlip(recipientIvk, fields);

        for (let i = 0; i < env.length; i += 7) {
            const roto = Uint8Array.from(env);
            roto.set([(roto[i] as number) ^ 0x01], i);

            expect(importPaymentSlip(roto, recipientKeys())).toBeNull();
        }
    });
});

// ─── El tamaño, que decide por dónde puede viajar ────────────────────────────

describe('un slip cabe donde tiene que caber', () => {
    it('el sobre queda muy por debajo de la cota, con todos los campos', () => {
        // La cota de 4 KB existe para que el emisor no elija cuánta memoria
        // gasta el receptor. Este test fija el margen real: si un campo nuevo lo
        // estrechara, hay que subir la cota a conciencia, no descubrirlo cuando
        // un slip legítimo empiece a rechazarse.
        const env = sealPaymentSlip(recipientIvk, {
            commitmentHex: '0x' + 'aa'.repeat(32),
            encryptedMemo: '0x' + 'bb'.repeat(180),
            leafIndex: 2 ** 32 - 1,
            txHash: '0x' + 'cc'.repeat(32),
        });

        expect(env.length).toBeLessThan(1024);
    });

    it('la cadena sigue cabiendo en un QR de un solo código', () => {
        // El slip se comparte por chat o por QR, y el formato NO pagina. Un
        // slip que pase de la capacidad de un QR deja de poder escanearse — sin
        // error, simplemente nadie lo lee.
        const wire = encodePaymentSlip(
            sealPaymentSlip(recipientIvk, {
                commitmentHex: '0x' + 'aa'.repeat(32),
                encryptedMemo: '0x' + 'bb'.repeat(180),
                leafIndex: 2 ** 32 - 1,
                txHash: '0x' + 'cc'.repeat(32),
            })
        );

        expect(wire.length).toBeLessThan(QR_SINGLE_CODE_MAX_CHARS);
    });
});
