/**
 * `recoverSentNote` — el emisor lee lo que envió.
 *
 * La propiedad bajo prueba es que el importe y el destinatario de un envío, que
 * viven dentro de un memo sellado hacia otra persona, son recuperables por quien
 * lo mandó **sin nada nuevo en cadena y sin contador**.
 *
 * Todo aquí usa criptografía real: se construye la nota con `NoteBuilder`, se
 * comprueba que el receptor la abre, y solo entonces se intenta la recuperación.
 * Un test que no verificara el lado del receptor podría estar probando una nota
 * que nadie puede gastar.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { NoteBuilder } from '../../../src/protocol/note/NoteBuilder';
import { recoverSentNote, SENT_NOTE_WINDOW } from '../../../src/protocol/note/recoverSent';
import { tryDecryptNote } from '../../../src/protocol/note/NoteDecryptor';
import {
    deriveViewingSecretKey,
    deriveViewingPublicKey,
    deriveOwnerPk,
} from '../../../src/protocol/keys/PrivacyKeys';
import {
    derivePairwiseSharedSecret,
    derivePairwiseEphSk,
} from '../../../src/protocol/eph/index';
import { toHex } from '../../../src/foundation/encoding/hex';
import type { ScanCommitment, ZkNote } from '../../../src/protocol/types';

const SENDER_SK = 111n;
const RECIPIENT_SK = 222n;
const STRANGER_SK = 999n;

let senderIvsk: Uint8Array;
let recipientIvsk: Uint8Array;
let recipientIvk: Uint8Array;
let recipientOwnerPk: bigint;
let pairSecret: Uint8Array;

beforeAll(() => {
    senderIvsk = deriveViewingSecretKey(SENDER_SK);
    recipientIvsk = deriveViewingSecretKey(RECIPIENT_SK);
    recipientIvk = deriveViewingPublicKey(recipientIvsk);
    recipientOwnerPk = deriveOwnerPk(RECIPIENT_SK);
    pairSecret = derivePairwiseSharedSecret(senderIvsk, recipientIvk);
});

/** Un pago real al índice `i`, tal como lo construye el wallet. */
async function payment(i: number, value = 4200n): Promise<ZkNote> {
    return NoteBuilder.build({
        value,
        assetId: 0n,
        blinding: 777n,
        ownerPk: recipientOwnerPk,
        sourcePk: deriveOwnerPk(SENDER_SK),
        viewingPublicKey: recipientIvk,
        recipientOwnerPk,
        ephSkOverride: derivePairwiseEphSk(pairSecret, i),
    });
}

/** La forma en que el indexer sirve una salida. */
const asHint = (note: ZkNote, leafIndex = 3): ScanCommitment => ({
    commitmentHex: note.commitmentHex,
    leafIndex,
    encryptedMemo: toHex(Uint8Array.from(note.memo)),
});

const recover = (hint: ScanCommitment, over: Partial<Parameters<typeof recoverSentNote>[0]> = {}) =>
    recoverSentNote({
        hint,
        myViewingSecretKey: senderIvsk,
        theirViewingPublicKey: recipientIvk,
        ...over,
    });

// ─── La propiedad central ────────────────────────────────────────────────────

describe('el emisor recupera lo que envió', () => {
    it('devuelve importe, blinding y contraparte del memo sellado hacia otro', async () => {
        const note = await payment(7);

        const facts = recover(asHint(note));

        expect(facts).not.toBeNull();
        expect(facts!.value).toBe(4200n);
        expect(facts!.blinding).toBe(777n);
        expect(facts!.assetId).toBe(0n);
        expect(facts!.sourcePk).toBe(deriveOwnerPk(SENDER_SK));
        expect(facts!.ephIndex).toBe(7);
    });

    it('el receptor sigue abriendo la misma nota', async () => {
        // Si esto fallara, la recuperación estaría leyendo una nota que nadie
        // puede gastar — correcta en apariencia y sin valor.
        const note = await payment(7);

        const opened = tryDecryptNote(asHint(note), recipientIvsk, RECIPIENT_SK, recipientOwnerPk);

        expect(opened).not.toBeNull();
        expect(opened!.value).toBe(4200n);
    });

    it('el ownerPk recuperado es la clave sigilosa, no la identidad global', async () => {
        // Confundirlas haría que una interfaz mostrara como dirección estable
        // algo que existe para un solo pago.
        const note = await payment(2);

        const facts = recover(asHint(note))!;

        expect(facts.recipientStealthPk).toBe(note.ownerPk);
        expect(facts.recipientStealthPk).not.toBe(recipientOwnerPk);
    });

    it('no entrega clave de gasto ni nullifier', async () => {
        // El emisor no posee la nota del receptor, solo la memoria de haberla
        // enviado. Un campo de más aquí sería una nota falsamente gastable.
        const facts = recover(asHint(await payment(1)))! as Record<string, unknown>;

        expect('spendingKey' in facts).toBe(false);
        expect('nullifier' in facts).toBe(false);
        expect('spent' in facts).toBe(false);
    });
});

// ─── Sin contador, que es el caso tras restaurar ─────────────────────────────

describe('tras restaurar desde semilla', () => {
    it('recupera aunque los índices tengan huecos', async () => {
        // Una reserva que no se gastó salta un índice. El emisor no sabe cuáles
        // publicó — por eso busca, en vez de asumir una secuencia.
        const notes = await Promise.all([0, 1, 5, 31].map((i) => payment(i, 100n)));

        const found = notes.map((n) => recover(asHint(n)));

        expect(found.every((f) => f !== null)).toBe(true);
        expect(found.map((f) => f!.ephIndex)).toEqual([0, 1, 5, 31]);
    });

    it('recupera el índice 0, que es el primero de una secuencia nueva', async () => {
        expect(recover(asHint(await payment(0)))!.ephIndex).toBe(0);
    });

    it('recupera el último índice de la ventana', async () => {
        const note = await payment(SENT_NOTE_WINDOW - 1);

        expect(recover(asHint(note))!.ephIndex).toBe(SENT_NOTE_WINDOW - 1);
    });
});

// ─── Lo que NO debe recuperar ────────────────────────────────────────────────

describe('una nota que no es de este par', () => {
    it('un índice más allá de la ventana devuelve null, no un valor equivocado', async () => {
        // El fallo peligroso sería devolver los datos de OTRO índice. Una
        // ventana corta tiene que quedarse callada.
        const note = await payment(SENT_NOTE_WINDOW + 5);

        expect(recover(asHint(note))).toBeNull();
    });

    it('barrer con la clave de otra contraparte no recupera nada', async () => {
        // Un emisor con varias contrapartes prueba cada una: la equivocada debe
        // fallar, o atribuiría el pago a la persona incorrecta.
        const note = await payment(3);
        const strangerIvk = deriveViewingPublicKey(deriveViewingSecretKey(STRANGER_SK));

        expect(recover(asHint(note), { theirViewingPublicKey: strangerIvk })).toBeNull();
    });

    it('la clave de visión de otro emisor no abre el pago', async () => {
        const note = await payment(3);
        const otherSender = deriveViewingSecretKey(STRANGER_SK);

        expect(recover(asHint(note), { myViewingSecretKey: otherSender })).toBeNull();
    });

    it('un pago con efímera aleatoria no se recupera', async () => {
        // El primer pago a una contraparte nueva no lleva contador, así que su
        // efímera es aleatoria y queda fuera de esta vía por diseño.
        const note = await NoteBuilder.build({
            value: 4200n,
            blinding: 777n,
            ownerPk: recipientOwnerPk,
            viewingPublicKey: recipientIvk,
            recipientOwnerPk,
        });

        expect(recover(asHint(note))).toBeNull();
    });
});

// ─── Entradas que vienen de un servidor ──────────────────────────────────────

describe('recoverSentNote nunca lanza', () => {
    it('devuelve null ante hints malformados', async () => {
        const note = await payment(4);
        const good = asHint(note);

        const malos: ScanCommitment[] = [
            { ...good, commitmentHex: '0xzz' },
            { ...good, commitmentHex: '' },
            { ...good, commitmentHex: '0x' + 'aa'.repeat(31) },
            { ...good, encryptedMemo: '0x' + 'bb'.repeat(179) },
            { ...good, encryptedMemo: '' },
            { ...good, encryptedMemo: '0xnothex' },
        ];

        for (const hint of malos) {
            expect(() => recover(hint)).not.toThrow();
            expect(recover(hint)).toBeNull();
        }
    });

    it('devuelve null ante una clave de visión que no es punto de curva', async () => {
        const hint = asHint(await payment(4));

        for (const bad of [new Uint8Array(32).fill(0xff), new Uint8Array(31)]) {
            expect(() => recover(hint, { theirViewingPublicKey: bad })).not.toThrow();
            expect(recover(hint, { theirViewingPublicKey: bad })).toBeNull();
        }
    });

    it('una ventana no positiva devuelve null en vez de barrer al revés', async () => {
        const hint = asHint(await payment(0));

        for (const windowSize of [0, -1, -1000]) {
            expect(recover(hint, { windowSize })).toBeNull();
        }
    });

    it('un leafIndex inválido se omite sin invalidar la recuperación', async () => {
        // El índice de hoja es informativo: el gasto vuelve a pedir la prueba.
        // Uno corrupto no puede costar el importe, que es lo irrecuperable.
        const note = await payment(6);

        const facts = recover({ ...asHint(note), leafIndex: -1 })!;

        expect(facts).not.toBeNull();
        expect(facts.value).toBe(4200n);
        expect('leafIndex' in facts).toBe(false);
    });

    it('un memo emparejado con el commitment de otra nota no se abre', async () => {
        // El commitment entra en la clave de cifrado del memo, así que el par
        // incoherente falla el MAC antes de entregar nada.
        const [a, b] = await Promise.all([payment(1, 100n), payment(2, 999n)]);

        const cruzado = { ...asHint(a), commitmentHex: b.commitmentHex };

        expect(recover(cruzado)).toBeNull();
    });
});
