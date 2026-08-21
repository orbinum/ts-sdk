/**
 * Intentos de robo de identidad, ejecutados de verdad.
 *
 * Todo lo de aquí es un ATAQUE con criptografía real: no se comprueba que
 * falte un campo, se intenta la acción y se exige que no funcione. La
 * diferencia importa — que una credencial no lleve `spendingKey` es una
 * propiedad del tipo; que con ella no se pueda gastar es la propiedad de
 * seguridad, y sólo la segunda es la que protege al usuario.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { NoteBuilder } from '../../../src/protocol/note/NoteBuilder';
import { decryptHintBatch } from '../../../src/wallet/worker/kernel/decryptBatch';
import { clearKnownEphWindow } from '../../../src/wallet/worker/kernel/ephWindow';
import {
    deriveIdentity,
    exportViewingCredential,
} from '../../../src/wallet/identity/walletIdentity';
import { PrivacyKeyManager } from '../../../src/protocol/keys/PrivacyKeyManager';
import { sealPaymentSlip, encodePaymentSlip } from '../../../src/protocol/memo/PaymentSlip';
import { importPaymentSlip } from '../../../src/wallet/ops/notes/paymentSlipImport';
import {
    sealRecipientBookEntry,
    openRecipientBookEntry,
} from '../../../src/protocol/note/recipientBook';
import { checkSpendableInputs } from '../../../src/wallet/ops/spend/guards';
import { bigintTo32Le, bytesToBigintLE } from '../../../src/foundation/encoding/bytes';
import { toHex } from '../../../src/foundation/encoding/hex';

const victim = deriveIdentity(new Uint8Array(32).fill(0xa1), 'v3');
const thief = deriveIdentity(new Uint8Array(32).fill(0xb0), 'v3');

/** Una clave de visión del subgrupo pequeño: parece clave, no oculta nada. */
const LOW_ORDER = bigintTo32Le(2n);
const ZEROS = new Uint8Array(32);

describe('una dirección de privacidad envenenada no pasa', () => {
    // La dirección es lo único de este sistema que elige un DESCONOCIDO. Si
    // lleva una clave de orden bajo, el memo sellado hacia ella se abre
    // probando 8 secretos, sin conocer nada.
    const ownerPk = toHex(bigintTo32Le(victim.ownerPk));

    it.each([
        ['orden bajo', toHex(LOW_ORDER)],
        ['todo ceros', toHex(ZEROS)],
    ])('rechaza una dirección con ivk %s', (_label, ivk) => {
        expect(PrivacyKeyManager.decodePrivacyAddress(`orbpriv1:${ownerPk}:${ivk}`)).toBeNull();
    });

    it('y el sellado la rechaza aunque alguien salte el decodificador', async () => {
        await expect(
            NoteBuilder.build({
                value: 100n,
                assetId: 0n,
                ownerPk: victim.ownerPk,
                recipientOwnerPk: victim.ownerPk,
                viewingPublicKey: LOW_ORDER,
            })
        ).rejects.toThrow(/viewing public key/);

        expect(() =>
            sealPaymentSlip(LOW_ORDER, {
                commitmentHex: '0x' + 'ab'.repeat(32),
                encryptedMemo: '0x' + 'cd'.repeat(180),
            })
        ).toThrow(/viewing public key/);
    });
});

describe('el ladrón no puede leer lo que no es suyo', () => {
    beforeEach(() => clearKnownEphWindow());

    it('un pago dirigido a la víctima no se abre con las claves del ladrón', async () => {
        const note = await NoteBuilder.build({
            value: 4200n,
            assetId: 0n,
            ownerPk: victim.ownerPk,
            recipientOwnerPk: victim.ownerPk,
            viewingPublicKey: victim.viewingPublicKey,
        });

        const asThief = decryptHintBatch(
            [
                {
                    leafIndex: 0,
                    commitmentHex: note.commitmentHex,
                    ephPkHex: null,
                    encryptedMemo: toHex(Uint8Array.from(note.memo)),
                },
            ] as never,
            {
                viewingKey: thief.viewingSecretKey,
                spendingKey: thief.spendingKey,
                ownerPk: thief.ownerPk,
                selfEph: true,
                pairwiseCounterparties: [],
            } as never
        );

        expect(asThief.notes[0]).toBeNull();
    });

    it('la libreta de la víctima no se abre con el ovk del ladrón', async () => {
        // La libreta es «a quién pagué». Está sellada bajo el ovk justamente
        // para que entregar una clave de visión no entregue el grafo de pagos.
        const paymentCommitment = '0x' + 'ab'.repeat(32);
        const sealed = sealRecipientBookEntry(
            thief.viewingPublicKey,
            victim.outgoingViewingKey!,
            paymentCommitment
        );

        const opened = openRecipientBookEntry(
            bytesToBigintLE(sealed),
            thief.outgoingViewingKey!,
            paymentCommitment
        );

        expect(toHex(opened)).not.toBe(toHex(thief.viewingPublicKey));
    });

    it('con el ovk correcto sí se abre — la prueba de que el test mide algo', () => {
        const paymentCommitment = '0x' + 'ab'.repeat(32);
        const sealed = sealRecipientBookEntry(
            thief.viewingPublicKey,
            victim.outgoingViewingKey!,
            paymentCommitment
        );

        const opened = openRecipientBookEntry(
            bytesToBigintLE(sealed),
            victim.outgoingViewingKey!,
            paymentCommitment
        );

        expect(toHex(opened)).toBe(toHex(thief.viewingPublicKey));
    });
});

describe('una credencial de sólo lectura no gasta', () => {
    beforeEach(() => clearKnownEphWindow());

    it('ve el importe y NO obtiene una nota gastable', async () => {
        // El ataque real: alguien con la credencial watch-only intenta
        // reconstruir una nota que pueda mover. Ve lo que llegó — para eso
        // está — pero la clave que lo gasta no se deriva sin la de gasto.
        const note = await NoteBuilder.build({
            value: 4200n,
            assetId: 0n,
            ownerPk: victim.ownerPk,
            recipientOwnerPk: victim.ownerPk,
            viewingPublicKey: victim.viewingPublicKey,
        });
        const cred = exportViewingCredential(victim, { includeOutgoing: true });

        // `spendingKey: 0n` es lo máximo que puede aportar quien sólo tiene la
        // credencial: el campo no existe en ella.
        const seen = decryptHintBatch(
            [
                {
                    leafIndex: 0,
                    commitmentHex: note.commitmentHex,
                    ephPkHex: null,
                    encryptedMemo: toHex(Uint8Array.from(note.memo)),
                },
            ] as never,
            {
                viewingKey: cred.viewingSecretKey,
                spendingKey: 0n,
                ownerPk: cred.ownerPk,
                selfEph: true,
                pairwiseCounterparties: [],
            } as never
        );

        const recovered = seen.notes[0];
        expect(recovered).not.toBeNull();
        expect(recovered!.value).toBe(4200n);

        // Y esa nota NO sirve para gastar. Comparada contra la MISMA nota
        // abierta con la clave de gasto real: mismo commitment — es la misma
        // nota — pero distinta clave de gasto y distinto nullifier, y el
        // nullifier es lo que la cadena exige para moverla.
        const withSpendKey = decryptHintBatch(
            [
                {
                    leafIndex: 0,
                    commitmentHex: note.commitmentHex,
                    ephPkHex: null,
                    encryptedMemo: toHex(Uint8Array.from(note.memo)),
                },
            ] as never,
            {
                viewingKey: victim.viewingSecretKey,
                spendingKey: victim.spendingKey,
                ownerPk: victim.ownerPk,
                selfEph: true,
                pairwiseCounterparties: [],
            } as never
        ).notes[0]!;

        expect(withSpendKey.commitmentHex).toBe(recovered!.commitmentHex);
        expect(withSpendKey.spendingKey).not.toBe(recovered!.spendingKey);
        expect(withSpendKey.nullifierHex).not.toBe(recovered!.nullifierHex);
    });

    it('la credencial no lleva la clave de gasto ni por accidente', () => {
        const cred = exportViewingCredential(victim, { includeOutgoing: true });

        expect('spendingKey' in cred).toBe(false);
        expect(Object.values(cred)).not.toContain(victim.spendingKey);
    });

    it('y el ovk sólo viaja si se pide explícitamente', () => {
        expect(exportViewingCredential(victim).outgoingViewingKey).toBeUndefined();
    });
});

describe('un slip no otorga poder de gasto', () => {
    it('el ladrón que intercepta un slip de la víctima no saca nada', async () => {
        const note = await NoteBuilder.build({
            value: 4200n,
            assetId: 0n,
            ownerPk: victim.ownerPk,
            recipientOwnerPk: victim.ownerPk,
            viewingPublicKey: victim.viewingPublicKey,
        });
        const slip = encodePaymentSlip(
            sealPaymentSlip(victim.viewingPublicKey, {
                commitmentHex: note.commitmentHex,
                encryptedMemo: toHex(Uint8Array.from(note.memo)),
            })
        );

        const stolen = importPaymentSlip(slip, {
            viewingSecretKey: thief.viewingSecretKey,
            spendingKey: thief.spendingKey,
            ownerPk: thief.ownerPk,
        });

        expect(stolen).toBeNull();
    });

    it('la víctima sí lo abre, y lo que saca es gastable', async () => {
        const note = await NoteBuilder.build({
            value: 4200n,
            assetId: 0n,
            ownerPk: victim.ownerPk,
            recipientOwnerPk: victim.ownerPk,
            viewingPublicKey: victim.viewingPublicKey,
        });
        const slip = encodePaymentSlip(
            sealPaymentSlip(victim.viewingPublicKey, {
                commitmentHex: note.commitmentHex,
                encryptedMemo: toHex(Uint8Array.from(note.memo)),
            })
        );

        const mine = importPaymentSlip(slip, {
            viewingSecretKey: victim.viewingSecretKey,
            spendingKey: victim.spendingKey,
            ownerPk: victim.ownerPk,
        });

        expect(mine).not.toBeNull();
        expect(checkSpendableInputs([mine!]).ok).toBe(true);
    });
});
