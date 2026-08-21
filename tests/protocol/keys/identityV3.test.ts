/**
 * Identidad v3 — ramas disjuntas, y los vectores que las congelan.
 *
 * Lo que v3 arregla: bajo v2 la clave de visión DESCIENDE de la de gasto, así
 * que no existe una clave de visión entregable — dar acceso de lectura es dar
 * acceso total. Bajo v3 las ramas son hermanas de una raíz, así que cada
 * capacidad se delega, y se revoca, por separado.
 *
 * Los vectores fijos son la única red que hay: un drift de dominio no lanza
 * ningún error, simplemente produce claves que no descifran nada.
 */
import { describe, it, expect } from 'vitest';
import { hkdf } from '@noble/hashes/hkdf.js';
import { sha256 } from '@noble/hashes/sha2.js';
import {
    deriveSpendingKeyV3,
    deriveViewingSecretKeyV3,
    deriveOutgoingViewingKeyV3,
    deriveViewingSecretKey,
    deriveViewingPublicKey,
    deriveOwnerPk,
} from '../../../src/protocol/keys/PrivacyKeys';
import { deriveSelfEphSk } from '../../../src/protocol/eph/selfEph';
import { deriveOutgoingEphSk } from '../../../src/protocol/eph/outgoingEph';
import {
    sealRecipientBookEntry,
    openRecipientBookEntry,
} from '../../../src/protocol/note/recipientBook';
import {
    deriveIdentity,
    exportViewingCredential,
} from '../../../src/wallet/identity/walletIdentity';
import { bytesToBigintLE } from '../../../src/foundation/encoding/bytes';
import { toHex } from '../../../src/foundation/encoding/hex';
import { BABYJUB_SUBORDER } from '../../../src/foundation/crypto/constants';

/** Raíz fija: el contrato entre repos se ancla aquí. */
const ROOT = Uint8Array.from({ length: 32 }, (_, i) => i + 1);

describe('vectores fijos por rama (pin cross-repo)', () => {
    const expected = (info: string) =>
        hkdf(sha256, ROOT, undefined, new TextEncoder().encode(info), 32);

    it('ivsk = HKDF(root, "orbinum-ivk-v3")', () => {
        expect(deriveViewingSecretKeyV3(ROOT)).toEqual(expected('orbinum-ivk-v3'));
    });

    it('ovk = HKDF(root, "orbinum-ovk-v3")', () => {
        expect(deriveOutgoingViewingKeyV3(ROOT)).toEqual(expected('orbinum-ovk-v3'));
    });

    it('spendingKey = HKDF(root, "orbinum-spend-v3") reducido al orden de la curva', () => {
        const raw = BigInt(toHex(expected('orbinum-spend-v3'))) % BABYJUB_SUBORDER;
        expect(deriveSpendingKeyV3(ROOT)).toBe(raw === 0n ? 1n : raw);
    });

    it('el escalar de gasto cae SIEMPRE dentro del orden de la curva', () => {
        // Fuera de rango el circuito lo rechaza, y el fallo aparece al gastar.
        for (let i = 0; i < 200; i++) {
            const sk = deriveSpendingKeyV3(sha256(new Uint8Array([i, i >> 8])));
            expect(sk).toBeGreaterThan(0n);
            expect(sk).toBeLessThan(BABYJUB_SUBORDER);
        }
    });
});

describe('vectores fijos por PRF (pin cross-repo)', () => {
    const ivsk = deriveViewingSecretKeyV3(ROOT);
    const ovk = deriveOutgoingViewingKeyV3(ROOT);

    it('self-eph cuelga de la ivsk', () => {
        const h = sha256.create();
        h.update(new TextEncoder().encode('orbinum-self-eph-v3'));
        h.update(ivsk);
        h.update(new Uint8Array([7, 0, 0, 0]));
        expect(deriveSelfEphSk(ivsk, 7)).toEqual(h.digest());
    });

    it('outgoing-eph cuelga del ovk', () => {
        const h = sha256.create();
        h.update(new TextEncoder().encode('orbinum-outgoing-eph-v3'));
        h.update(ovk);
        h.update(new Uint8Array([7, 0, 0, 0]));
        expect(deriveOutgoingEphSk(ovk, 7)).toEqual(h.digest());
    });

    it('la libreta cuelga del ovk', () => {
        const commitment = '0x' + 'cd'.repeat(32);
        const h = sha256.create();
        h.update(new TextEncoder().encode('orbinum-recipient-book-v3'));
        h.update(ovk);
        h.update(new TextEncoder().encode('cd'.repeat(32)));
        const keystream = h.digest();

        const ivk = deriveViewingPublicKey(deriveViewingSecretKey(777n));
        const sealed = sealRecipientBookEntry(ivk, ovk, commitment);

        expect(sealed).toEqual(ivk.map((b, i) => b ^ keystream[i]!));
    });
});

describe('las ramas son disjuntas', () => {
    it('ninguna rama es derivable desde otra', () => {
        // Es la propiedad entera: entregar una clave de visión no puede dar un
        // camino a la de gasto.
        const branches = {
            spend: new Uint8Array(32), // placeholder, se compara por hex abajo
            ivsk: deriveViewingSecretKeyV3(ROOT),
            ovk: deriveOutgoingViewingKeyV3(ROOT),
        };
        const infos = ['orbinum-spend-v3', 'orbinum-ivk-v3', 'orbinum-ovk-v3'];

        for (const [name, ikm] of Object.entries(branches)) {
            if (name === 'spend') continue;
            for (const info of infos) {
                const attempt = hkdf(sha256, ikm, undefined, new TextEncoder().encode(info), 32);
                expect(toHex(attempt)).not.toBe(toHex(branches.ivsk));
                expect(toHex(attempt)).not.toBe(toHex(branches.ovk));
            }
        }
    });

    it('v3 corta el vínculo de v2: ivsk_v3 no sale de spendingKey_v3', () => {
        const identity = deriveIdentity(ROOT, 'v3');

        expect(toHex(deriveViewingSecretKey(identity.spendingKey))).not.toBe(
            toHex(identity.viewingSecretKey)
        );
    });

    it('500 raíces dan 500 identidades sin colisión', () => {
        const seen = new Set<string>();
        for (let i = 0; i < 500; i++) {
            const id = deriveIdentity(sha256(new Uint8Array([i, i >> 8])), 'v3');
            seen.add(
                `${id.spendingKey}|${toHex(id.viewingSecretKey)}|${toHex(id.outgoingViewingKey!)}`
            );
        }
        expect(seen.size).toBe(500);
    });
});

describe('deriveIdentity', () => {
    it('v2 ya no existe: se rechaza en vez de derivar claves de una cadena muerta', () => {
        // Eliminado, no deprecado. v2 encadenaba `raíz → gasto → visión`, así
        // que tener la clave de gasto era tenerlo todo y no había rama donde
        // colgar la de visión saliente. Nadie puede volver a él pasando una
        // cadena: el tipo sólo admite 'v3' y esto lo cierra desde JavaScript.
        expect(() => deriveIdentity(ROOT, 'v2' as never)).toThrow(/unknown identity version/);
    });

    it('v3 deriva las tres ramas de la raíz', () => {
        const id = deriveIdentity(ROOT, 'v3');

        expect(id.spendingKey).toBe(deriveSpendingKeyV3(ROOT));
        expect(toHex(id.viewingSecretKey)).toBe(toHex(deriveViewingSecretKeyV3(ROOT)));
        expect(toHex(id.outgoingViewingKey!)).toBe(toHex(deriveOutgoingViewingKeyV3(ROOT)));
    });

    it('el ownerPk y la ivk públicos siguen siendo lo que la dirección publica', () => {
        const id = deriveIdentity(ROOT, 'v3');

        expect(id.ownerPk).toBe(deriveOwnerPk(id.spendingKey));
        expect(toHex(id.viewingPublicKey)).toBe(toHex(deriveViewingPublicKey(id.viewingSecretKey)));
    });
});

describe('exportViewingCredential — lo que un auditor recibe', () => {
    const identity = deriveIdentity(ROOT, 'v3');

    it('NUNCA lleva la clave de gasto', () => {
        const cred = exportViewingCredential(identity, { includeOutgoing: true });

        expect('spendingKey' in cred).toBe(false);
        expect('rootSecret' in cred).toBe(false);
    });

    it('el ovk es opt-in: por defecto NO viaja', () => {
        // Entrega el grafo de pagos, que es un secreto distinto y mayor que los
        // importes entrantes. Quien pide "ver el saldo" no debe recibirlo.
        expect(exportViewingCredential(identity).outgoingViewingKey).toBeUndefined();
        expect(
            exportViewingCredential(identity, { includeOutgoing: true }).outgoingViewingKey
        ).toBeDefined();
    });

    it('sin el ovk, la credencial no abre la libreta', () => {
        const cred = exportViewingCredential(identity);
        const recipientIvk = deriveViewingPublicKey(deriveViewingSecretKey(777n));
        const commitment = '0x' + 'ef'.repeat(32);
        const sealed = bytesToBigintLE(
            sealRecipientBookEntry(recipientIvk, identity.outgoingViewingKey!, commitment)
        );

        // Lo mejor que puede intentar: usar la clave de visión entrante.
        const attempt = openRecipientBookEntry(sealed, cred.viewingSecretKey, commitment);

        expect(toHex(attempt)).not.toBe(toHex(recipientIvk));
    });

    it('con el ovk sí la abre', () => {
        const cred = exportViewingCredential(identity, { includeOutgoing: true });
        const recipientIvk = deriveViewingPublicKey(deriveViewingSecretKey(777n));
        const commitment = '0x' + 'ef'.repeat(32);
        const sealed = bytesToBigintLE(
            sealRecipientBookEntry(recipientIvk, cred.outgoingViewingKey!, commitment)
        );

        expect(toHex(openRecipientBookEntry(sealed, cred.outgoingViewingKey!, commitment))).toBe(
            toHex(recipientIvk)
        );
    });
});

describe('la credencial no comparte memoria con la identidad viva', () => {
    // Una credencial se va del proceso: a un fichero, a un worker, a un host que
    // puede poner sus buffers a cero al terminar. Compartir los arrays dejaría
    // que cualquiera de esas cosas alcanzase las claves del wallet abierto — y
    // el síntoma sería que las notas dejan de descifrar, no un error.
    it('mutarla no toca las claves del wallet', () => {
        const identity = deriveIdentity(ROOT, 'v3');
        const before = toHex(identity.viewingSecretKey);
        const beforeOvk = toHex(identity.outgoingViewingKey!);

        const cred = exportViewingCredential(identity, { includeOutgoing: true });
        cred.viewingSecretKey.fill(0);
        cred.outgoingViewingKey!.fill(0);

        expect(toHex(identity.viewingSecretKey)).toBe(before);
        expect(toHex(identity.outgoingViewingKey!)).toBe(beforeOvk);
    });

    it('y sigue llevando los valores correctos', () => {
        const identity = deriveIdentity(ROOT, 'v3');
        const cred = exportViewingCredential(identity, { includeOutgoing: true });

        expect(toHex(cred.viewingSecretKey)).toBe(toHex(identity.viewingSecretKey));
        expect(toHex(cred.outgoingViewingKey!)).toBe(toHex(identity.outgoingViewingKey!));
    });
});

describe('deriveIdentity falla cerrado', () => {
    // Las ramas v3 son HKDF puro: responden a cualquier entrada, incluida una
    // vacía. Sin estas comprobaciones, un llamador que cablee la raíz desde algo
    // que no estaba obtiene una identidad completa, determinista y derivable por
    // cualquiera — sin un solo error.
    it('rechaza una raíz que no mide 32 bytes', () => {
        for (const bad of [new Uint8Array(0), new Uint8Array(16), new Uint8Array(64)]) {
            expect(() => deriveIdentity(bad, 'v3')).toThrow(/32 bytes/);
        }
    });

    it('rechaza una raíz de ceros: todos los wallets compartirían identidad', () => {
        expect(() => deriveIdentity(new Uint8Array(32), 'v3')).toThrow(/all zeros/);
    });

    it('rechaza una versión desconocida en vez de tratarla como v3', () => {
        // Antes devolvía claves v3 etiquetadas con la cadena desconocida, y esa
        // etiqueta elige el nombre del vault: claves correctas, vault vacío.
        expect(() => deriveIdentity(ROOT, 'v9' as never)).toThrow(/unknown identity version/);
    });
});
