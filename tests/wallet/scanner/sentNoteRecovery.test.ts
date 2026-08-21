/**
 * Recuperación del historial de envíos desde la semilla — extremo a extremo.
 *
 * Todo lo demás prueba una pieza; esto prueba la promesa: tras restaurar con
 * SOLO la clave de gasto, el emisor vuelve a saber cuánto envió, a quién, y
 * puede reemitir el slip. Sin vault previo, sin contador guardado, sin libreta
 * local, y sin pedirle nada al receptor.
 *
 * El flujo real, con criptografía real:
 *
 *   1. el cambio se abre con selfEph (deriva de la clave de gasto)
 *   2. su `sourcePk` lleva la ivk del receptor, sellada bajo la clave de gasto
 *   3. el ephPk saliente identifica el pago, sin conocer importe ni receptor
 *   4. la ivk aprendida abre el memo que el emisor selló hacia otro
 */
import { describe, it, expect } from 'vitest';
import { NoteBuilder } from '../../../src/protocol/note/NoteBuilder';
import { decryptHintBatch } from '../../../src/wallet/worker/kernel/decryptBatch';
import { recoverSentNote } from '../../../src/protocol/note/recoverSent';
import { clearKnownEphWindow } from '../../../src/wallet/worker/kernel/ephWindow';
import { deriveOutgoingEphSk } from '../../../src/protocol/eph/outgoingEph';
import { deriveSelfEphSk } from '../../../src/protocol/eph/selfEph';
import {
    sealRecipientBookEntry,
    openRecipientBookEntry,
} from '../../../src/protocol/note/recipientBook';
import { regeneratePaymentSlip } from '../../../src/wallet/provenance/regenerateSlip';
import { importPaymentSlip } from '../../../src/wallet/ops/notes/paymentSlipImport';
import {
    deriveViewingSecretKey,
    deriveViewingPublicKey,
    deriveOwnerPk,
    deriveOutgoingViewingKeyV3,
} from '../../../src/protocol/keys/PrivacyKeys';
import { bytesToBigintLE } from '../../../src/foundation/encoding/bytes';
import { toHex } from '../../../src/foundation/encoding/hex';
import type { ScanKeys } from '../../../src/wallet/worker/kernel/types';
import type { ScanCommitment, ZkNote } from '../../../src/protocol/types';

const SENDER_SK = 111n;
const RECIPIENT_SK = 777n;

const senderIvsk = deriveViewingSecretKey(SENDER_SK);
// Las tres ramas que un wallet v3 usa aquí. La saliente es la que reconoce los
// pagos propios y abre la libreta; la de gasto no participa en ninguna de las dos.
const SENDER_OVK = deriveOutgoingViewingKeyV3(new Uint8Array(32).fill(0x3e));
const senderIvk = deriveViewingPublicKey(senderIvsk);
const senderOwnerPk = deriveOwnerPk(SENDER_SK);

/** Una transferencia tal como la publica el wallet: pago + cambio. */
async function transfer(params: {
    recipientSk: bigint;
    value: bigint;
    outIndex: number;
    selfIndex: number;
}): Promise<{ sent: ZkNote; change: ZkNote }> {
    const { recipientSk, value, outIndex, selfIndex } = params;
    const recipientIvk = deriveViewingPublicKey(deriveViewingSecretKey(recipientSk));

    const sent = await NoteBuilder.build({
        value,
        assetId: 0n,
        blinding: 31337n + BigInt(outIndex),
        ownerPk: deriveOwnerPk(recipientSk),
        sourcePk: senderOwnerPk,
        viewingPublicKey: recipientIvk,
        recipientOwnerPk: deriveOwnerPk(recipientSk),
        ephSkOverride: deriveOutgoingEphSk(SENDER_OVK, outIndex),
    });

    const change = await NoteBuilder.build({
        value: 800n,
        assetId: 0n,
        blinding: 999n + BigInt(selfIndex),
        ownerPk: senderOwnerPk,
        spendingKey: SENDER_SK,
        // La libreta: la ivk del receptor, sellada bajo la clave de GASTO y
        // ligada al commitment DEL PAGO, que es lo que ambos lados comparten.
        sourcePk: bytesToBigintLE(
            sealRecipientBookEntry(recipientIvk, SENDER_OVK, sent.commitmentHex)
        ),
        viewingPublicKey: senderIvk,
        ephSkOverride: deriveSelfEphSk(senderIvsk, selfIndex),
    });
    return { sent, change };
}

const asHint = (note: ZkNote, leafIndex: number): ScanCommitment => ({
    commitmentHex: note.commitmentHex,
    leafIndex,
    encryptedMemo: toHex(Uint8Array.from(note.memo)),
});

/** Las claves de un wallet RESTAURADO: solo lo que deriva de la semilla. */
const restoredKeys = (): ScanKeys => ({
    viewingKey: senderIvsk,
    spendingKey: SENDER_SK,
    ownerPk: senderOwnerPk,
    selfEph: true,
    outgoingEph: true,
    outgoingViewingKey: SENDER_OVK,
    // Sin contrapartes: es exactamente lo que una restauración pierde.
    pairwiseCounterparties: [],
});

describe('el emisor recupera su historial desde la semilla', () => {
    it('recupera importe y receptor de un pago, sin estado local', async () => {
        clearKnownEphWindow();
        const { sent, change } = await transfer({
            recipientSk: RECIPIENT_SK,
            value: 4200n,
            outIndex: 0,
            selfIndex: 0,
        });
        // El cambio va PRIMERO, que es el orden en que el árbol los inserta:
        // la libreta tiene que estar disponible antes de abrir el pago.
        const pool = [asHint(change, 10), asHint(sent, 11)];

        const result = decryptHintBatch(pool, restoredKeys());

        expect(result.sentNotes).toHaveLength(1);
        expect(result.sentNotes[0]!.value).toBe(4200n);
        expect(result.sentNotes[0]!.counterpartyIvkHex).toBe(
            toHex(deriveViewingPublicKey(deriveViewingSecretKey(RECIPIENT_SK)))
        );
    });

    it('EL ORDEN REAL: el pago llega ANTES que su cambio', async () => {
        // No es un caso raro, es el único: una transferencia publica el pago
        // como salida 0 y el cambio como salida 1, así que la clave que abre el
        // pago SIEMPRE tiene un índice de hoja mayor. Sin una segunda pasada
        // dentro del lote no se recuperaría ni un solo pago.
        clearKnownEphWindow();
        const { sent, change } = await transfer({
            recipientSk: RECIPIENT_SK,
            value: 4200n,
            outIndex: 0,
            selfIndex: 0,
        });

        const result = decryptHintBatch([asHint(sent, 10), asHint(change, 11)], restoredKeys());

        expect(result.sentNotes).toHaveLength(1);
        expect(result.sentNotes[0]!.value).toBe(4200n);
    });

    it('varias transferencias intercaladas en orden de cadena', async () => {
        // pago₀, cambio₀, pago₁, cambio₁, … tal como los inserta el árbol.
        clearKnownEphWindow();
        const txs = await Promise.all(
            [777n, 888n, 999n].map((recipientSk, i) =>
                transfer({
                    recipientSk,
                    value: BigInt(100 * (i + 1)),
                    outIndex: i,
                    selfIndex: i,
                })
            )
        );
        const pool = txs.flatMap((t, i) => [asHint(t.sent, i * 2), asHint(t.change, i * 2 + 1)]);

        const result = decryptHintBatch(pool, restoredKeys());

        expect(result.sentNotes.map((s) => s.value).sort((a, b) => Number(a - b))).toEqual([
            100n,
            200n,
            300n,
        ]);
    });

    it('LOS CONTADORES SE DESINCRONIZAN, y la libreta sigue abriendo', async () => {
        // El fallo que cerró esto: la entrada se sellaba bajo el índice
        // SALIENTE y se abría bajo el índice SELF. Coinciden solo mientras las
        // dos secuencias avanzan juntas — un shield adelanta la self por su
        // cuenta y desde ahí no vuelve a abrirse ninguna libreta.
        //
        // Con la clave ligada al commitment del pago no hay dos secuencias que
        // puedan separarse: es el mismo dato en ambos lados.
        clearKnownEphWindow();
        const { sent, change } = await transfer({
            recipientSk: RECIPIENT_SK,
            value: 4200n,
            outIndex: 0,
            selfIndex: 9, // nueve shields de por medio
        });

        const result = decryptHintBatch([asHint(sent, 10), asHint(change, 11)], restoredKeys());

        expect(result.sentNotes).toHaveLength(1);
        expect(result.sentNotes[0]!.value).toBe(4200n);
    });

    it('CRUZANDO PÁGINAS: pago en un lote, cambio en el siguiente', async () => {
        // Un límite de página entre el pago y su cambio deja las dos mitades
        // incomunicadas: el lote del pago aún no vio la entrada, y el lote de la
        // entrada ya pasó el pago. Ninguno de los dos basta por sí solo, así que
        // ambos se reportan para que el llamador los cruce al final.
        clearKnownEphWindow();
        const { sent, change } = await transfer({
            recipientSk: RECIPIENT_SK,
            value: 4200n,
            outIndex: 0,
            selfIndex: 0,
        });

        const page1 = decryptHintBatch([asHint(sent, 10)], restoredKeys());
        const page2 = decryptHintBatch([asHint(change, 11)], restoredKeys());

        // Ninguna página lo abre por su cuenta…
        expect(page1.sentNotes).toHaveLength(0);
        expect(page2.sentNotes).toHaveLength(0);
        // …pero cada una reporta su mitad.
        expect(page1.unmatchedSent).toHaveLength(1);
        expect(page2.sealedBookEntries).toHaveLength(1);

        // Y cruzarlas lo recupera, que es lo que hace `runScan` al terminar.
        const entry = BigInt(page2.sealedBookEntries[0]!);
        const { hint, ephIndex } = page1.unmatchedSent[0]!;
        const recovered = recoverSentNote({
            hint,
            outgoingViewingKey: SENDER_OVK,
            ephIndex,
            recipientCandidates: [openRecipientBookEntry(entry, SENDER_OVK, hint.commitmentHex)],
        });

        expect(recovered).not.toBeNull();
        expect(recovered!.value).toBe(4200n);
    });

    it('recupera el PRIMER pago a una contraparte nueva', async () => {
        // El caso que el mecanismo pairwise no podía cubrir: sin historial no
        // había contador, así que la efímera era aleatoria y el pago quedaba
        // fuera para siempre. La secuencia saliente no depende del receptor.
        clearKnownEphWindow();
        const { sent, change } = await transfer({
            recipientSk: 424242n,
            value: 999n,
            outIndex: 0,
            selfIndex: 0,
        });

        const result = decryptHintBatch([asHint(change, 1), asHint(sent, 2)], restoredKeys());

        expect(result.sentNotes).toHaveLength(1);
        expect(result.sentNotes[0]!.value).toBe(999n);
    });

    it('recupera varios pagos a contrapartes distintas', async () => {
        clearKnownEphWindow();
        const txs = await Promise.all(
            [777n, 888n, 999n].map((recipientSk, i) =>
                transfer({
                    recipientSk,
                    value: BigInt(1000 * (i + 1)),
                    outIndex: i,
                    selfIndex: i,
                })
            )
        );
        // Los cambios primero: en una cadena real un pago y su cambio caen en el
        // mismo bloque, pero el orden dentro del lote no está garantizado.
        const pool = [
            ...txs.map((t, i) => asHint(t.change, i * 2)),
            ...txs.map((t, i) => asHint(t.sent, i * 2 + 1)),
        ];

        const result = decryptHintBatch(pool, restoredKeys());

        expect(result.sentNotes.map((s) => s.value).sort((a, b) => Number(a - b))).toEqual([
            1000n,
            2000n,
            3000n,
        ]);
    });

    it('reemite un slip que reconstruye la nota gastable del receptor', async () => {
        // El objetivo final: el receptor perdió su slip, y el emisor —que solo
        // tiene su semilla— puede volver a entregárselo.
        clearKnownEphWindow();
        const { sent, change } = await transfer({
            recipientSk: RECIPIENT_SK,
            value: 4200n,
            outIndex: 0,
            selfIndex: 0,
        });

        const { sentNotes } = decryptHintBatch(
            [asHint(change, 10), asHint(sent, 11)],
            restoredKeys()
        );
        const recovered = sentNotes[0]!;
        const slip = regeneratePaymentSlip(
            {
                commitmentHex: recovered.commitmentHex,
                encryptedMemo: recovered.encryptedMemo,
                leafIndex: recovered.leafIndex!,
            },
            deriveViewingPublicKey(deriveViewingSecretKey(RECIPIENT_SK))
        );

        const rebuilt = importPaymentSlip(slip, {
            viewingSecretKey: deriveViewingSecretKey(RECIPIENT_SK),
            spendingKey: RECIPIENT_SK,
            ownerPk: deriveOwnerPk(RECIPIENT_SK),
        });

        expect(rebuilt).not.toBeNull();
        expect(rebuilt!.value).toBe(4200n);
        expect(rebuilt!.commitmentHex).toBe(sent.commitmentHex);
    });

    it('la nota enviada NO entra en el vault del emisor', async () => {
        // Sería saldo que no tiene: la nota es del receptor. El emisor solo
        // guarda el recuerdo de haberla enviado.
        clearKnownEphWindow();
        const { sent, change } = await transfer({
            recipientSk: RECIPIENT_SK,
            value: 4200n,
            outIndex: 0,
            selfIndex: 0,
        });

        const result = decryptHintBatch([asHint(change, 10), asHint(sent, 11)], restoredKeys());

        const owned = result.notes.filter((n) => n !== null);
        expect(owned).toHaveLength(1); // solo el cambio
        expect(owned[0]!.value).toBe(800n);
    });
});

describe('el contador saliente vuelve del escaneo', () => {
    it('reporta el índice más alto que reconoció', async () => {
        // Es lo que repara el contador tras restaurar. Sin él, el siguiente pago
        // arrancaría en 0 y republicaría la efímera del primero.
        clearKnownEphWindow();
        const txs = await Promise.all(
            [0, 1, 7].map((i) =>
                transfer({ recipientSk: RECIPIENT_SK, value: 100n, outIndex: i, selfIndex: i })
            )
        );
        const pool = txs.flatMap((t, i) => [asHint(t.sent, i * 2), asHint(t.change, i * 2 + 1)]);

        const result = decryptHintBatch(pool, restoredKeys());

        // Con huecos: 2..6 no se usaron, pero el 7 sí.
        expect(result.maxOutgoingEphIndex).toBe(7);
    });

    it('cuenta un pago aunque su memo no se haya abierto', async () => {
        // El ephPk ya prueba que este wallet publicó ese índice; si solo se
        // contaran los pagos abiertos, un cambio en otra página dejaría el
        // contador corto y el índice volvería a repartirse.
        clearKnownEphWindow();
        const { sent } = await transfer({
            recipientSk: RECIPIENT_SK,
            value: 100n,
            outIndex: 3,
            selfIndex: 0,
        });

        const result = decryptHintBatch([asHint(sent, 1)], restoredKeys());

        expect(result.sentNotes).toHaveLength(0); // sin libreta, no abre
        expect(result.maxOutgoingEphIndex).toBe(3); // pero el índice sí cuenta
    });

    it('no reporta nada cuando no reconoció ningún pago', async () => {
        clearKnownEphWindow();
        const { change } = await transfer({
            recipientSk: RECIPIENT_SK,
            value: 100n,
            outIndex: 0,
            selfIndex: 0,
        });

        expect(
            decryptHintBatch([asHint(change, 1)], restoredKeys()).maxOutgoingEphIndex
        ).toBeNull();
    });
});

describe('lo que NO debe recuperar', () => {
    it('el mismo pago servido dos veces es UN solo registro', async () => {
        // Un feed que repite un commitment al cruzar una página — artefacto
        // corriente de paginación o reorg — inflaría el historial con pagos
        // fantasma que el usuario nunca hizo.
        clearKnownEphWindow();
        const { sent, change } = await transfer({
            recipientSk: RECIPIENT_SK,
            value: 4200n,
            outIndex: 0,
            selfIndex: 0,
        });

        const result = decryptHintBatch(
            [asHint(change, 10), asHint(sent, 11), asHint(sent, 12)],
            restoredKeys()
        );

        expect(result.sentNotes).toHaveLength(1);
    });

    it('y conserva el leafIndex de la PRIMERA copia, no el de la última', async () => {
        // El leafIndex sobreviviente acaba dentro de un slip reemitido. Uno
        // equivocado produce un slip AUTENTICADO que apunta a otra posición del
        // árbol: parece válido, y falla al pedir la prueba de Merkle en el
        // dispositivo del receptor sin nada que lo explique.
        clearKnownEphWindow();
        const { sent, change } = await transfer({
            recipientSk: RECIPIENT_SK,
            value: 4200n,
            outIndex: 0,
            selfIndex: 0,
        });

        const result = decryptHintBatch(
            [asHint(change, 10), asHint(sent, 11), asHint(sent, 999_999)],
            restoredKeys()
        );

        expect(result.sentNotes[0]!.leafIndex).toBe(11);
    });

    it('un pago repetido 200 veces no infla la lista de pendientes', async () => {
        // El ephPk de un pago viaja público en su memo, así que un feed hostil
        // puede reproducirlo a voluntad. Sin deduplicar en la recogida, cada
        // copia añadiría trabajo al reintento cuadrático del final del escaneo.
        clearKnownEphWindow();
        const { sent } = await transfer({
            recipientSk: RECIPIENT_SK,
            value: 4200n,
            outIndex: 0,
            selfIndex: 0,
        });

        const result = decryptHintBatch(
            Array.from({ length: 200 }, (_, i) => asHint(sent, i)),
            restoredKeys()
        );

        expect(result.unmatchedSent).toHaveLength(1);
    });

    it('el pago de otro emisor al mismo receptor', async () => {
        // La ventana saliente deriva de NUESTRA clave de gasto, así que un pago
        // ajeno no puede caer en ella.
        clearKnownEphWindow();
        const strangerNote = await NoteBuilder.build({
            value: 5000n,
            assetId: 0n,
            blinding: 1n,
            ownerPk: deriveOwnerPk(RECIPIENT_SK),
            sourcePk: deriveOwnerPk(333n),
            viewingPublicKey: deriveViewingPublicKey(deriveViewingSecretKey(RECIPIENT_SK)),
            recipientOwnerPk: deriveOwnerPk(RECIPIENT_SK),
            // Otro emisor, su propia secuencia saliente.
            ephSkOverride: deriveOutgoingEphSk(
                deriveOutgoingViewingKeyV3(new Uint8Array(32).fill(0xaa)),
                0
            ),
        });

        const result = decryptHintBatch([asHint(strangerNote, 1)], restoredKeys());

        expect(result.sentNotes).toHaveLength(0);
    });

    it('un pago cuya libreta no ha aparecido todavía', async () => {
        // Sin la ivk del receptor el memo no abre. No se inventa nada: el pago
        // simplemente no se reporta hasta que el cambio que lo nombra aparezca.
        clearKnownEphWindow();
        const { sent } = await transfer({
            recipientSk: RECIPIENT_SK,
            value: 4200n,
            outIndex: 0,
            selfIndex: 0,
        });

        const result = decryptHintBatch([asHint(sent, 11)], restoredKeys());

        expect(result.sentNotes).toHaveLength(0);
        expect(result.notes.filter((n) => n !== null)).toHaveLength(0);
    });

    it('no reporta nada cuando la recuperación está apagada', async () => {
        // En un tick incremental el historial ya está: la ventana saliente
        // costaría trabajo EC para nada.
        clearKnownEphWindow();
        const { sent, change } = await transfer({
            recipientSk: RECIPIENT_SK,
            value: 4200n,
            outIndex: 0,
            selfIndex: 0,
        });

        const result = decryptHintBatch([asHint(change, 10), asHint(sent, 11)], {
            ...restoredKeys(),
            outgoingEph: false,
        });

        expect(result.sentNotes).toHaveLength(0);
    });
});

describe('la libreta no se filtra a una clave de visión', () => {
    it('un auditor con la clave de visión ve el importe pero no al receptor', async () => {
        // Una clave de visión se comparte: auditor, dispositivo de solo lectura.
        // El grafo de pagos es un secreto mayor que los importes, así que la
        // libreta va cifrada bajo la clave de GASTO.
        clearKnownEphWindow();
        const { change } = await transfer({
            recipientSk: RECIPIENT_SK,
            value: 4200n,
            outIndex: 0,
            selfIndex: 0,
        });
        const recipientIvk = deriveViewingPublicKey(deriveViewingSecretKey(RECIPIENT_SK));

        // El auditor abre el memo del cambio: ve el importe.
        const result = decryptHintBatch([asHint(change, 10)], restoredKeys());
        const opened = result.notes[0]!;
        expect(opened.value).toBe(800n);

        // Pero el sourcePk que lee es ruido: sin la clave de gasto no hay
        // keystream, así que el campo no revela a quién se pagó.
        expect(opened.sourcePk).not.toBe(bytesToBigintLE(recipientIvk));
    });

    it('el dueño, con la clave de gasto, SÍ abre la libreta', async () => {
        // El contraste que da sentido al test anterior: la misma nota, la misma
        // lectura, y la clave de gasto es lo único que cambia el resultado.
        clearKnownEphWindow();
        const { sent, change } = await transfer({
            recipientSk: RECIPIENT_SK,
            value: 4200n,
            outIndex: 0,
            selfIndex: 0,
        });
        const recipientIvk = deriveViewingPublicKey(deriveViewingSecretKey(RECIPIENT_SK));

        const opened = decryptHintBatch([asHint(change, 10)], restoredKeys()).notes[0]!;

        expect(
            toHex(openRecipientBookEntry(opened.sourcePk!, SENDER_OVK, sent.commitmentHex))
        ).toBe(toHex(recipientIvk));
    });
});

/**
 * El ephPk sale del MEMO, no del campo que sirve el feed.
 *
 * El resto de la suite pasa `ephPkHex: null`, que es la rama buena — y por eso
 * ninguna prueba veía la que corre en producción, donde el indexer SÍ manda el
 * campo. Un indexer que lo calculaba con un desplazamiento de 4 bytes servía 32
 * bytes bien formados que no casaban con nada: el pago no se reconocía, el
 * escaneo devolvía `sentNotes: []` y la fila `out` del historial quedaba sin
 * destinatario. Sin un solo error por ningún lado.
 *
 * El memo es dato de cadena y lleva el ephPk en sus últimos 32 bytes, así que
 * el campo no aporta nada que no se pueda derivar aquí.
 */
describe('el ephPk se deriva del memo, no del feed', () => {
    /** Un hint como lo sirve el indexer: con el campo `ephPkHex` poblado. */
    const asServedHint = (note: ZkNote, leafIndex: number, ephPkHex: string | null) => ({
        ...asHint(note, leafIndex),
        ephPkHex,
    });

    it('recupera el pago aunque el feed mande un ephPk EQUIVOCADO', async () => {
        // El fallo real: el indexer leía bytes 144..176 de un memo de 180, así
        // que el valor era plausible y estaba desplazado 4 bytes.
        clearKnownEphWindow();
        const { sent, change } = await transfer({
            recipientSk: RECIPIENT_SK,
            value: 4200n,
            outIndex: 0,
            selfIndex: 0,
        });
        const shifted = (note: ZkNote) => {
            const memo = toHex(Uint8Array.from(note.memo)).slice(2);
            return '0x' + memo.slice(288, 352); // el offset de 176 bytes, obsoleto
        };

        const result = decryptHintBatch(
            [asServedHint(change, 10, shifted(change)), asServedHint(sent, 11, shifted(sent))],
            restoredKeys()
        );

        expect(result.sentNotes).toHaveLength(1);
        expect(result.sentNotes[0]!.value).toBe(4200n);
    });

    it('y el campo del feed no cambia nada cuando SÍ es correcto', async () => {
        // El contraste: con el campo bien puesto el resultado es el mismo, que
        // es lo que hace seguro dejar de leerlo.
        clearKnownEphWindow();
        const { sent, change } = await transfer({
            recipientSk: RECIPIENT_SK,
            value: 4200n,
            outIndex: 0,
            selfIndex: 0,
        });
        const realEphPk = (note: ZkNote) =>
            '0x' + toHex(Uint8Array.from(note.memo)).slice(2).slice(-64);

        const result = decryptHintBatch(
            [asServedHint(change, 10, realEphPk(change)), asServedHint(sent, 11, realEphPk(sent))],
            restoredKeys()
        );

        expect(result.sentNotes).toHaveLength(1);
        expect(result.sentNotes[0]!.value).toBe(4200n);
    });

    it('las notas PROPIAS nunca dependieron del campo', async () => {
        // Por qué el saldo se veía bien y sólo faltaba el historial de envíos:
        // el cambio se recupera por trial-decrypt, que no mira este campo.
        clearKnownEphWindow();
        const { change } = await transfer({
            recipientSk: RECIPIENT_SK,
            value: 4200n,
            outIndex: 0,
            selfIndex: 0,
        });

        const result = decryptHintBatch(
            [asServedHint(change, 10, '0x' + 'ff'.repeat(32))],
            restoredKeys()
        );

        expect(result.notes[0]).not.toBeNull();
        expect(result.notes[0]!.value).toBe(800n);
    });
});
