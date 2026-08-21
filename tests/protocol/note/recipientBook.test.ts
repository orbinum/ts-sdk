/**
 * La libreta de destinatarios — a quién pagó este wallet, dentro de su cambio.
 *
 * Lo que se prueba aquí es la separación de poderes. Tres capacidades, tres
 * claves distintas:
 *
 *   - la clave de GASTO mueve el dinero y no abre esta libreta
 *   - la clave de visión ENTRANTE ve los importes y tampoco la abre
 *   - la clave de visión SALIENTE (ovk) la abre, y no gasta nada
 *
 * "A quién pagué" es un secreto distinto de "cuánto recibí" y de "puedo gastar",
 * así que vive en su propia rama y se delega —o se revoca— por separado.
 */
import { describe, it, expect } from 'vitest';
import {
    sealRecipientBookEntry,
    openRecipientBookEntry,
} from '../../../src/protocol/note/recipientBook';
import {
    deriveViewingSecretKey,
    deriveViewingPublicKey,
    deriveViewingSecretKeyV3,
    deriveOutgoingViewingKeyV3,
} from '../../../src/protocol/keys/PrivacyKeys';
import { bytesToBigintLE, bigintTo32Le } from '../../../src/foundation/encoding/bytes';
import { toHex } from '../../../src/foundation/encoding/hex';

// La libreta se sella bajo la clave de visión SALIENTE. Bajo la de gasto ataría
// "a quién pagué" con "puedo mover el dinero" — dos capacidades sin razón para
// viajar juntas, y pondría el grafo de pagos en manos de quien robe la de gasto.
const OVK = deriveOutgoingViewingKeyV3(new Uint8Array(32).fill(0x11));
const OTHER_OVK = deriveOutgoingViewingKeyV3(new Uint8Array(32).fill(0x99));
const RECIPIENT_IVK = deriveViewingPublicKey(deriveViewingSecretKey(777n));

/** El commitment del pago, que es la clave bajo la que viaja una entrada. */
const commitmentOf = (n: number) => '0x' + n.toString(16).padStart(64, '0');

/** El viaje completo: sellar, transportar como bigint, recuperar. */
const roundTrip = (ivk: Uint8Array, ovk: Uint8Array, commitment: string) =>
    openRecipientBookEntry(
        bytesToBigintLE(sealRecipientBookEntry(ivk, ovk, commitment)),
        ovk,
        commitment
    );

describe('ida y vuelta', () => {
    it('el portador del ovk recupera la clave de visión del receptor', () => {
        expect(toHex(roundTrip(RECIPIENT_IVK, OVK, commitmentOf(0)))).toBe(toHex(RECIPIENT_IVK));
    });

    it('sella de verdad: el resultado no es la clave en claro', () => {
        const sealed = sealRecipientBookEntry(RECIPIENT_IVK, OVK, commitmentOf(0));

        expect(toHex(sealed)).not.toBe(toHex(RECIPIENT_IVK));
    });

    it('funciona con cualquier commitment', () => {
        for (const index of [0, 1, 63, 65535, 0xffff_fffe]) {
            expect(toHex(roundTrip(RECIPIENT_IVK, OVK, commitmentOf(index)))).toBe(
                toHex(RECIPIENT_IVK)
            );
        }
    });

    it('sobrevive un ciphertext por encima del módulo BN254', () => {
        // `sourcePk` viaja como 32 bytes crudos sin reducción de campo. Si el
        // transporte redujera, la mayoría de las entradas se corromperían: la
        // salida de un XOR de 32 bytes excede el módulo casi siempre.
        const FIELD =
            21888242871839275222246405745257275088548364400416034343698204186575808495617n;
        const overField = Array.from({ length: 64 }, (_, i) => i).filter(
            (i) =>
                bytesToBigintLE(sealRecipientBookEntry(RECIPIENT_IVK, OVK, commitmentOf(i))) >=
                FIELD
        );

        expect(overField.length).toBeGreaterThan(0); // el caso existe de verdad
        for (const index of overField) {
            expect(toHex(roundTrip(RECIPIENT_IVK, OVK, commitmentOf(index)))).toBe(
                toHex(RECIPIENT_IVK)
            );
        }
    });
});

describe('la forma del hex no decide nada', () => {
    // El commitment llega de un feed, y la forma en que lo sirve es una decisión
    // suya: mayúsculas, minúsculas, con prefijo o sin él. Hashear la cadena tal
    // cual haría que una diferencia cosmética derivara otro keystream — y el
    // fallo sería invisible, porque un keystream equivocado da 32 bytes
    // plausibles que sencillamente no abren ningún memo.
    const CANON = '0x' + 'ab'.repeat(32);
    const sealed = bytesToBigintLE(sealRecipientBookEntry(RECIPIENT_IVK, OVK, CANON));

    it.each([
        ['idéntico', CANON],
        ['MAYÚSCULAS', CANON.toUpperCase()],
        ['sin prefijo 0x', CANON.slice(2)],
        ['mayúsculas mezcladas', '0x' + 'aB'.repeat(32)],
        ['sin prefijo y en mayúsculas', CANON.slice(2).toUpperCase()],
    ])('abre con el commitment %s', (_label, form) => {
        expect(toHex(openRecipientBookEntry(sealed, OVK, form))).toBe(toHex(RECIPIENT_IVK));
    });
});

describe('la separación de poderes', () => {
    it('la clave de visión ENTRANTE no abre la libreta', () => {
        // Un auditor con la clave de visión lee todos los importes. No debe leer
        // ni una contraparte: el grafo de pagos es un secreto mayor.
        const sealed = bytesToBigintLE(sealRecipientBookEntry(RECIPIENT_IVK, OVK, commitmentOf(0)));
        // Un auditor de ENTRANTES tiene la ivsk. No debe abrir la libreta: el
        // grafo de pagos es un secreto distinto y mayor que los importes.
        const incomingViewingKey = deriveViewingSecretKeyV3(new Uint8Array(32).fill(0x11));

        const attempt = openRecipientBookEntry(sealed, incomingViewingKey, commitmentOf(0));

        expect(toHex(attempt)).not.toBe(toHex(RECIPIENT_IVK));
    });

    it('el ovk de otro wallet tampoco', () => {
        const sealed = bytesToBigintLE(sealRecipientBookEntry(RECIPIENT_IVK, OVK, commitmentOf(0)));

        expect(toHex(openRecipientBookEntry(sealed, OTHER_OVK, commitmentOf(0)))).not.toBe(
            toHex(RECIPIENT_IVK)
        );
    });

    it('el commitment de OTRO pago tampoco', () => {
        const sealed = bytesToBigintLE(sealRecipientBookEntry(RECIPIENT_IVK, OVK, commitmentOf(0)));

        expect(toHex(openRecipientBookEntry(sealed, OVK, commitmentOf(1)))).not.toBe(
            toHex(RECIPIENT_IVK)
        );
    });
});

describe('el mismo receptor en pagos distintos', () => {
    it('produce entradas distintas', () => {
        // Con un ciphertext estable, quien viera los plaintexts de los cambios
        // agruparía los pagos al mismo receptor sin descifrar ninguno.
        const entries = [0, 1, 2, 3].map((i) =>
            toHex(sealRecipientBookEntry(RECIPIENT_IVK, OVK, commitmentOf(i)))
        );

        expect(new Set(entries).size).toBe(4);
    });

    it('y todas abren a la misma clave', () => {
        for (const index of [0, 1, 2, 3]) {
            expect(toHex(roundTrip(RECIPIENT_IVK, OVK, commitmentOf(index)))).toBe(
                toHex(RECIPIENT_IVK)
            );
        }
    });
});

describe('entradas malformadas', () => {
    it('una clave que no mide 32 bytes se devuelve sin tocar', () => {
        // Cifrar una clave truncada la haría irrecuperable en silencio; devolver
        // la entrada tal cual deja que el consumidor la rechace al usarla.
        for (const bad of [new Uint8Array(0), new Uint8Array(31), new Uint8Array(33)]) {
            expect(sealRecipientBookEntry(bad, OVK, commitmentOf(0))).toBe(bad);
        }
    });

    it('un sourcePk de cero abre a algo que no es una clave válida', () => {
        // El caso de una nota de cambio antigua, sin libreta. Lo que importa es
        // que no lance: el consumidor lo descartará al fallar el memo del pago.
        expect(() => openRecipientBookEntry(0n, OVK, commitmentOf(0))).not.toThrow();
        expect(openRecipientBookEntry(0n, OVK, commitmentOf(0)).length).toBe(32);
    });
});
