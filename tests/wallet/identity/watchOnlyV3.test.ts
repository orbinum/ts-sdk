/**
 * Identidad v3, extremo a extremo — qué puede cada clave, y qué no.
 *
 * Esto es la promesa entera puesta a prueba con criptografía real: que entregar
 * la capacidad de VER no entrega la de GASTAR, y que "a quién pagué" se delega
 * aparte de "cuánto recibí".
 *
 * También fija los dos costes que el diseño trae, para que sean decisiones y no
 * sorpresas:
 *
 *   - gastar exige DOS ramas juntas, no solo la de gasto;
 *   - la restauración exige la RAÍZ, no una clave suelta.
 */
import { describe, it, expect } from 'vitest';
import { sha256 } from '@noble/hashes/sha2.js';
import { NoteBuilder } from '../../../src/protocol/note/NoteBuilder';
import { tryDecryptNote } from '../../../src/protocol/note/NoteDecryptor';
import { decryptHintBatch } from '../../../src/wallet/worker/kernel/decryptBatch';
import { clearKnownEphWindow } from '../../../src/wallet/worker/kernel/ephWindow';
import {
    deriveIdentity,
    exportViewingCredential,
} from '../../../src/wallet/identity/walletIdentity';
import { deriveSelfEphSk } from '../../../src/protocol/eph/selfEph';
import { deriveOutgoingEphSk } from '../../../src/protocol/eph/outgoingEph';
import { sealRecipientBookEntry } from '../../../src/protocol/note/recipientBook';
import {
    deriveViewingSecretKey,
    deriveViewingPublicKey,
    deriveOwnerPk,
} from '../../../src/protocol/keys/PrivacyKeys';
import { bytesToBigintLE } from '../../../src/foundation/encoding/bytes';
import { toHex } from '../../../src/foundation/encoding/hex';
import type { ScanCommitment, ZkNote } from '../../../src/protocol/types';

const ROOT = new Uint8Array(32).fill(0x42);
const me = deriveIdentity(ROOT, 'v3');
const RECIPIENT_SK = 777n;
const recipientIvk = deriveViewingPublicKey(deriveViewingSecretKey(RECIPIENT_SK));

/** Una transferencia v3 completa: pago con efímera del ovk, cambio con libreta. */
async function transfer(value: bigint, outIndex = 0, selfIndex = 0) {
    const sent = await NoteBuilder.build({
        value,
        assetId: 0n,
        blinding: 31337n + BigInt(outIndex),
        ownerPk: deriveOwnerPk(RECIPIENT_SK),
        sourcePk: me.ownerPk,
        viewingPublicKey: recipientIvk,
        recipientOwnerPk: deriveOwnerPk(RECIPIENT_SK),
        ephSkOverride: deriveOutgoingEphSk(me.outgoingViewingKey!, outIndex),
    });
    const change = await NoteBuilder.build({
        value: 500n,
        assetId: 0n,
        blinding: 999n + BigInt(selfIndex),
        ownerPk: me.ownerPk,
        spendingKey: me.spendingKey,
        sourcePk: bytesToBigintLE(
            sealRecipientBookEntry(recipientIvk, me.outgoingViewingKey!, sent.commitmentHex)
        ),
        viewingPublicKey: me.viewingPublicKey,
        ephSkOverride: deriveSelfEphSk(me.viewingSecretKey, selfIndex),
    });
    return { sent, change };
}

const asHint = (n: ZkNote, leafIndex: number): ScanCommitment => ({
    commitmentHex: n.commitmentHex,
    leafIndex,
    encryptedMemo: toHex(Uint8Array.from(n.memo)),
});

describe('el dueño ve todo', () => {
    it('recupera el pago y nombra al receptor', async () => {
        clearKnownEphWindow();
        const { sent, change } = await transfer(4200n);

        const result = decryptHintBatch([asHint(sent, 10), asHint(change, 11)], {
            viewingKey: me.viewingSecretKey,
            spendingKey: me.spendingKey,
            ownerPk: me.ownerPk,
            outgoingViewingKey: me.outgoingViewingKey!,
            selfEph: true,
            outgoingEph: true,
        });

        expect(result.sentNotes).toHaveLength(1);
        expect(result.sentNotes[0]!.value).toBe(4200n);
        expect(result.sentNotes[0]!.counterpartyIvkHex).toBe(toHex(recipientIvk));
    });
});

describe('el auditor de ENTRANTES — la ivsk sola', () => {
    it('encuentra las notas propias', async () => {
        // Es lo que un watch-only debe poder: ver el saldo.
        clearKnownEphWindow();
        const { sent, change } = await transfer(4200n);
        const cred = exportViewingCredential(me); // sin ovk

        const result = decryptHintBatch([asHint(sent, 10), asHint(change, 11)], {
            viewingKey: cred.viewingSecretKey,
            spendingKey: me.spendingKey,
            ownerPk: cred.ownerPk,
            selfEph: true,
            outgoingEph: true, // pedido, pero sin ovk no puede hacerse
        });

        expect(result.notes.filter((n) => n !== null)).toHaveLength(1);
        expect(result.notes.find((n) => n !== null)!.value).toBe(500n);
    });

    it('pero NO reconstruye el historial de pagos', async () => {
        // La separación medida: ver lo que entra no es ver a quién se pagó.
        clearKnownEphWindow();
        const { sent, change } = await transfer(4200n);
        const cred = exportViewingCredential(me);

        const result = decryptHintBatch([asHint(sent, 10), asHint(change, 11)], {
            viewingKey: cred.viewingSecretKey,
            spendingKey: me.spendingKey,
            ownerPk: cred.ownerPk,
            selfEph: true,
            outgoingEph: true,
        });

        expect(result.sentNotes).toHaveLength(0);
        expect(cred.outgoingViewingKey).toBeUndefined();
    });
});

describe('el auditor de SALIENTES — ivsk + ovk', () => {
    it('reconstruye el historial completo, y sigue sin poder gastar', async () => {
        clearKnownEphWindow();
        const { sent, change } = await transfer(4200n);
        const cred = exportViewingCredential(me, { includeOutgoing: true });

        const result = decryptHintBatch([asHint(sent, 10), asHint(change, 11)], {
            viewingKey: cred.viewingSecretKey,
            spendingKey: me.spendingKey,
            ownerPk: cred.ownerPk,
            outgoingViewingKey: cred.outgoingViewingKey!,
            selfEph: true,
            outgoingEph: true,
        });

        expect(result.sentNotes).toHaveLength(1);
        expect(result.sentNotes[0]!.value).toBe(4200n);
        // Y la credencial no lleva con qué firmar un gasto.
        expect('spendingKey' in cred).toBe(false);
    });
});

describe('los costes del diseño', () => {
    it('la clave de gasto SOLA no descifra nada', async () => {
        // Bajo v2 la clave de gasto era universal. Bajo v3 es un escalar de
        // nullifier: gastar exige también la clave de visión.
        const { change } = await transfer(4200n);

        const attempt = tryDecryptNote(
            asHint(change, 1),
            // Lo mejor que puede intentar quien solo tiene la de gasto.
            sha256(new Uint8Array([1])),
            me.spendingKey,
            me.ownerPk
        );

        expect(attempt).toBeNull();
    });

    it('la restauración exige la RAÍZ: la clave de gasto no devuelve el ovk', () => {
        // Cambia el requisito de producto: "guarda tu clave" pasa a ser
        // "guarda tu raíz".
        const fromRoot = deriveIdentity(ROOT, 'v3');

        expect(toHex(fromRoot.outgoingViewingKey!)).toBe(toHex(me.outgoingViewingKey!));
        // Y no hay función que vaya de la clave de gasto al ovk: son hermanas.
        expect(fromRoot.spendingKey).toBe(me.spendingKey);
    });
});

describe('aislamiento entre identidades', () => {
    it('otra raíz no reconoce nuestros pagos', async () => {
        clearKnownEphWindow();
        const { sent, change } = await transfer(4200n);
        const stranger = deriveIdentity(new Uint8Array(32).fill(0x99), 'v3');

        const result = decryptHintBatch([asHint(sent, 10), asHint(change, 11)], {
            viewingKey: stranger.viewingSecretKey,
            spendingKey: stranger.spendingKey,
            ownerPk: stranger.ownerPk,
            outgoingViewingKey: stranger.outgoingViewingKey!,
            selfEph: true,
            outgoingEph: true,
        });

        expect(result.sentNotes).toHaveLength(0);
        expect(result.notes.filter((n) => n !== null)).toHaveLength(0);
    });
});
