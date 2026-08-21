/**
 * El ciclo de vida completo, con criptografía real y el pipeline real.
 *
 * Todo lo demás prueba una pieza. Esto prueba la promesa entera, desde la
 * semilla: derivar identidad v3 → pagar → perderlo todo → restaurar con solo la
 * raíz → recuperar importe, receptor e historial → reemitir el slip.
 *
 * Y prueba lo que NO debe poder hacerse en cada paso, que es la mitad que
 * importa: quien tiene la clave entrante no ve a quién se pagó, y quien tiene
 * la credencial watch-only no puede gastar.
 *
 * Corre `runScan` de verdad contra un vault de verdad. Un fallo de cableado
 * entre fases — un contador que no avanza, una libreta que no cruza el límite
 * de página — aparece aquí y en ningún test unitario.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { runScan } from '../../../src/wallet/scanner/pipeline';
import { NoteBuilder } from '../../../src/protocol/note/NoteBuilder';
import { decryptHintBatch } from '../../../src/wallet/worker/kernel/decryptBatch';
import { clearKnownEphWindow } from '../../../src/wallet/worker/kernel/ephWindow';
import {
    deriveIdentity,
    exportViewingCredential,
} from '../../../src/wallet/identity/walletIdentity';
import {
    deriveOutgoingEphSk,
    deriveOutgoingEphPk,
    reconstructOutgoingIndex,
} from '../../../src/protocol/eph/outgoingEph';
import { deriveSelfEphSk } from '../../../src/protocol/eph/selfEph';
import { sealRecipientBookEntry } from '../../../src/protocol/note/recipientBook';
import { regeneratePaymentSlip } from '../../../src/wallet/provenance/regenerateSlip';
import {
    VaultStore,
    MemoryVaultStorage,
    createNotesCache,
    createWalletSession,
    deriveVaultKey,
    deriveVaultBlindKey,
} from '../../../src/index';
import { bytesToBigintLE } from '../../../src/foundation/encoding/bytes';
import { toHex } from '../../../src/foundation/encoding/hex';
import type { DecryptPool } from '../../../src/index';
import type {
    ScanHint,
    ScanHintSource,
    NullifierSource,
} from '../../../src/wallet/scanner/feed/sources';
import type { ZkNote } from '../../../src/protocol/types';

/** La semilla. Todo lo demás del emisor cuelga de aquí. */
const SENDER_ROOT = new Uint8Array(32).fill(0x5e);
const sender = deriveIdentity(SENDER_ROOT, 'v3');
const SENDER_OVK = sender.outgoingViewingKey!;

/** Dos receptores, para comprobar que la libreta distingue contrapartes. */
const ALICE = deriveIdentity(new Uint8Array(32).fill(0xa1), 'v3');
const BOB = deriveIdentity(new Uint8Array(32).fill(0xb0), 'v3');

/** Una transferencia tal como la publica el wallet: pago sellado + cambio con libreta. */
async function transfer(params: {
    to: typeof ALICE;
    value: bigint;
    outIndex: number;
    selfIndex: number;
    change: bigint;
}): Promise<{ sent: ZkNote; change: ZkNote }> {
    const { to, value, outIndex, selfIndex, change } = params;

    const sent = await NoteBuilder.build({
        value,
        assetId: 0n,
        ownerPk: to.ownerPk,
        recipientOwnerPk: to.ownerPk,
        viewingPublicKey: to.viewingPublicKey,
        sourcePk: sender.ownerPk,
        ephSkOverride: deriveOutgoingEphSk(SENDER_OVK, outIndex),
    });

    // La ivk del receptor viaja en el `sourcePk` del CAMBIO, sellada bajo el ovk
    // y con el commitment del PAGO como clave. Es lo que devuelve la libreta
    // tras un restore, sin campo nuevo en cadena.
    const changeNote = await NoteBuilder.build({
        value: change,
        assetId: 0n,
        ownerPk: sender.ownerPk,
        spendingKey: sender.spendingKey,
        viewingPublicKey: sender.viewingPublicKey,
        sourcePk: bytesToBigintLE(
            sealRecipientBookEntry(to.viewingPublicKey, SENDER_OVK, sent.commitmentHex)
        ),
        ephSkOverride: deriveSelfEphSk(sender.viewingSecretKey, selfIndex),
    });

    return { sent, change: changeNote };
}

const asHint = (note: ZkNote, leafIndex: number): ScanHint => ({
    leafIndex,
    commitmentHex: note.commitmentHex,
    ephPkHex: null,
    encryptedMemo: toHex(Uint8Array.from(note.memo)),
    timestampMs: null,
    txHash: null,
});

const hintSource = (hints: ScanHint[]): ScanHintSource => ({
    async listHints({ limit }) {
        return { data: hints, pagination: { limit, total: hints.length } };
    },
});

const nullifierSource = (): NullifierSource => ({
    async manifest() {
        return { generation: '1', chunks: [] };
    },
    async chunk() {
        return { data: [] };
    },
    async tail() {
        return { afterChunks: 0, data: [], timestampsMs: [], txHashes: [] };
    },
});

/** El pool real: el mismo kernel que corre en el worker, sin worker. */
const realPool = (): DecryptPool =>
    ({
        async decryptBatch(hints: ScanHint[], keys: unknown) {
            return decryptHintBatch(hints as never, keys as never);
        },
        terminate() {},
    }) as unknown as DecryptPool;

async function freshVault(): Promise<{ storage: MemoryVaultStorage; vault: VaultStore }> {
    const storage = new MemoryVaultStorage();
    const session = createWalletSession();
    const vault = new VaultStore({ storage, session, notes: createNotesCache() });
    session.open(await deriveVaultKey(SENDER_ROOT), await deriveVaultBlindKey(SENDER_ROOT));
    await storage.putConfig({ id: 'main', v: 4, createdAt: 1, updatedAt: 1 });
    return { storage, vault };
}

/** Un wallet restaurado: solo lo que deriva de la raíz. Sin vault previo. */
const restoredKeys = () => ({
    viewingKey: sender.viewingSecretKey,
    spendingKey: sender.spendingKey,
    ownerPk: sender.ownerPk,
    outgoingViewingKey: SENDER_OVK,
});

describe('ciclo de vida completo de una identidad v3', () => {
    let storage: MemoryVaultStorage;
    let vault: VaultStore;

    beforeEach(async () => {
        clearKnownEphWindow();
        ({ storage, vault } = await freshVault());
    });

    it('tras restaurar, recupera importe y receptor de cada pago', async () => {
        // Dos pagos a personas distintas y un tercero repetido a Alice: la
        // libreta tiene que distinguir contrapartes, no solo encontrar una.
        const t1 = await transfer({
            to: ALICE,
            value: 4200n,
            outIndex: 0,
            selfIndex: 0,
            change: 800n,
        });
        const t2 = await transfer({
            to: BOB,
            value: 1500n,
            outIndex: 1,
            selfIndex: 1,
            change: 300n,
        });
        const t3 = await transfer({
            to: ALICE,
            value: 99n,
            outIndex: 2,
            selfIndex: 2,
            change: 50n,
        });

        const result = await runScan({
            vault,
            storage,
            hints: hintSource([
                asHint(t1.sent, 0),
                asHint(t1.change, 1),
                asHint(t2.sent, 2),
                asHint(t2.change, 3),
                asHint(t3.sent, 4),
                asHint(t3.change, 5),
            ]),
            nullifiers: nullifierSource(),
            pool: realPool(),
            keys: restoredKeys(),
        });

        const byValue = new Map(result.sentNotes!.map((s) => [s.value, s]));
        expect([...byValue.keys()].sort((a, b) => Number(a - b))).toEqual([99n, 1500n, 4200n]);
        expect(byValue.get(4200n)!.counterpartyIvkHex).toBe(toHex(ALICE.viewingPublicKey));
        expect(byValue.get(1500n)!.counterpartyIvkHex).toBe(toHex(BOB.viewingPublicKey));
        expect(byValue.get(99n)!.counterpartyIvkHex).toBe(toHex(ALICE.viewingPublicKey));
    });

    it('el cambio entra como saldo propio y el pago NO', async () => {
        // El emisor no posee la nota que envió. Contarla sería inflar el saldo.
        const { sent, change } = await transfer({
            to: ALICE,
            value: 4200n,
            outIndex: 0,
            selfIndex: 0,
            change: 800n,
        });

        await runScan({
            vault,
            storage,
            hints: hintSource([asHint(sent, 0), asHint(change, 1)]),
            nullifiers: nullifierSource(),
            pool: realPool(),
            keys: restoredKeys(),
        });

        expect(vault.getAll().map((n) => n.value)).toEqual([800n]);
    });

    it('el slip reemitido sale bien formado desde los hechos recuperados', async () => {
        // El cierre del círculo: el emisor perdió su copia y la reconstruye
        // desde la cadena, sellada hacia la clave de visión del receptor.
        const { sent, change } = await transfer({
            to: ALICE,
            value: 4200n,
            outIndex: 0,
            selfIndex: 0,
            change: 800n,
        });

        const result = await runScan({
            vault,
            storage,
            hints: hintSource([asHint(sent, 0), asHint(change, 1)]),
            nullifiers: nullifierSource(),
            pool: realPool(),
            keys: restoredKeys(),
        });

        const recovered = result.sentNotes![0]!;
        const slip = regeneratePaymentSlip(
            {
                commitmentHex: recovered.commitmentHex,
                encryptedMemo: recovered.encryptedMemo,
                leafIndex: recovered.leafIndex,
            } as never,
            ALICE.viewingPublicKey
        );

        expect(slip).toMatch(/^orbslip1:/);
    });

    it('el contador saliente avanza más allá de lo publicado', async () => {
        // Si no avanzara, el siguiente pago reutilizaría un ephPk ya en cadena y
        // enlazaría en público los dos pagos como del mismo emisor.
        const { sent, change } = await transfer({
            to: ALICE,
            value: 10n,
            outIndex: 3,
            selfIndex: 0,
            change: 5n,
        });

        await runScan({
            vault,
            storage,
            hints: hintSource([asHint(sent, 0), asHint(change, 1)]),
            nullifiers: nullifierSource(),
            pool: realPool(),
            keys: restoredKeys(),
        });

        const config = await storage.getConfig();
        expect(config!.outgoingEphCounter).toBeGreaterThan(3);
    });
});

describe('las capacidades están realmente separadas', () => {
    beforeEach(() => clearKnownEphWindow());

    it('SIN ovk: encuentra el saldo, no reconstruye ningún pago', async () => {
        // El caso watch-only. La clave entrante revela lo que llegó; a quién se
        // pagó es un secreto distinto y más grande, y no viene incluido.
        const { storage, vault } = await freshVault();
        const { sent, change } = await transfer({
            to: ALICE,
            value: 4200n,
            outIndex: 0,
            selfIndex: 0,
            change: 800n,
        });

        const result = await runScan({
            vault,
            storage,
            hints: hintSource([asHint(sent, 0), asHint(change, 1)]),
            nullifiers: nullifierSource(),
            pool: realPool(),
            // La misma identidad, MENOS la rama saliente.
            keys: {
                viewingKey: sender.viewingSecretKey,
                spendingKey: sender.spendingKey,
                ownerPk: sender.ownerPk,
            },
        });

        expect(vault.getAll().map((n) => n.value)).toEqual([800n]);
        expect(result.sentNotes ?? []).toHaveLength(0);
    });

    it('la credencial watch-only no lleva ovk salvo que se pida', () => {
        expect(exportViewingCredential(sender).outgoingViewingKey).toBeUndefined();
        expect(
            exportViewingCredential(sender, { includeOutgoing: true }).outgoingViewingKey
        ).toBeDefined();
    });

    it('la credencial no lleva clave de gasto, y mutarla no toca la identidad', () => {
        const cred = exportViewingCredential(sender, { includeOutgoing: true });
        expect('spendingKey' in cred).toBe(false);

        // Una credencial está hecha para salir del proceso; si compartiera los
        // buffers vivos, quien la reciba podría corromper las claves en uso.
        cred.viewingSecretKey.fill(0xff);
        cred.outgoingViewingKey!.fill(0xff);

        expect(toHex(sender.viewingSecretKey)).not.toBe(toHex(cred.viewingSecretKey));
        expect(toHex(SENDER_OVK)).not.toBe(toHex(cred.outgoingViewingKey!));
    });

    it('las ramas v3 no se derivan unas de otras', () => {
        // La propiedad que v2 no tenía: allí la clave de visión DESCENDÍA de la
        // de gasto, así que delegar lectura era delegar todo — y no quedaba
        // rama donde colgar la de visión saliente. Por eso v2 se eliminó en vez
        // de deprecarse.
        expect(toHex(SENDER_OVK)).not.toBe(toHex(sender.viewingSecretKey));
        expect(toHex(SENDER_OVK)).not.toBe(toHex(sender.viewingPublicKey));

        // Cada rama sale de un dominio HKDF propio sobre la misma raíz, así que
        // tener una no acerca a ninguna otra.
        const branches = [
            sender.spendingKey.toString(16),
            toHex(sender.viewingSecretKey),
            toHex(SENDER_OVK),
        ];
        expect(new Set(branches).size).toBe(3);
    });

    it('y v2 ya no se puede derivar', () => {
        expect(() => deriveIdentity(SENDER_ROOT, 'v2' as never)).toThrow(
            /unknown identity version/
        );
    });

    it('el ovk de otro wallet no abre nada de este', async () => {
        const { sent, change } = await transfer({
            to: ALICE,
            value: 4200n,
            outIndex: 0,
            selfIndex: 0,
            change: 800n,
        });

        const result = decryptHintBatch(
            [asHint(sent, 0), asHint(change, 1)] as never,
            {
                viewingKey: sender.viewingSecretKey,
                spendingKey: sender.spendingKey,
                ownerPk: sender.ownerPk,
                selfEph: true,
                outgoingEph: true,
                // La rama saliente de OTRA persona.
                outgoingViewingKey: BOB.outgoingViewingKey!,
                pairwiseCounterparties: [],
            } as never
        );

        expect(result.sentNotes).toHaveLength(0);
    });
});

describe('el contador saliente se reconstruye desde la cadena', () => {
    it('nombra el índice siguiente al más alto que este wallet publicó', () => {
        // Es lo que permite que una secuencia saliente arranque en 0 tras un
        // restore en vez de degradar a una efímera aleatoria.
        const published = [0, 1, 5].map((i) => deriveOutgoingEphPk(SENDER_OVK, i));

        expect(reconstructOutgoingIndex(SENDER_OVK, published, 64)).toBe(6);
    });

    it('ignora lo que publicó otro emisor', () => {
        const other = [0, 1, 2].map((i) => deriveOutgoingEphPk(BOB.outgoingViewingKey!, i));

        expect(reconstructOutgoingIndex(SENDER_OVK, other, 64)).toBe(0);
    });
});

describe('el escaneo no depende de que el feed mande ephPkHex', () => {
    // `ScanHint.ephPkHex` es nullable por contrato, y el kernel ya sabe leer la
    // efímera de los últimos 32 bytes del memo. La fase de recolección lo exigía
    // igualmente y descartaba el hint antes de que el kernel lo viera: un feed
    // que no mandara el campo hacía que el wallet no encontrara NADA y
    // reportara un escaneo limpio, que es la peor forma de fallar.
    it('encuentra el saldo y el historial con ephPkHex a null', async () => {
        clearKnownEphWindow();
        const { storage, vault } = await freshVault();
        const { sent, change } = await transfer({
            to: ALICE,
            value: 4200n,
            outIndex: 0,
            selfIndex: 0,
            change: 800n,
        });

        // asHint ya construye los hints con `ephPkHex: null`.
        const result = await runScan({
            vault,
            storage,
            hints: hintSource([asHint(sent, 0), asHint(change, 1)]),
            nullifiers: nullifierSource(),
            pool: realPool(),
            keys: restoredKeys(),
        });

        expect(vault.getAll().map((n) => n.value)).toEqual([800n]);
        expect(result.sentNotes!.map((s) => s.value)).toEqual([4200n]);
    });
});

describe('un feed hostil no rompe ni envenena el escaneo', () => {
    // El indexer es la parte NO confiable del sistema: sirve los hints. Un hint
    // malformado no puede matar el lote (el resto del pool se perdería), y un
    // hint que empareja el memo de una nota con el commitment de otra no puede
    // colar una nota falsa — la clave del memo lleva el commitment dentro, así
    // que el MAC lo rechaza.
    it('sobrevive a hints malformados y sigue recuperando lo válido', async () => {
        clearKnownEphWindow();
        const { storage, vault } = await freshVault();
        const { sent, change } = await transfer({
            to: ALICE,
            value: 4200n,
            outIndex: 0,
            selfIndex: 0,
            change: 800n,
        });
        const memo = toHex(Uint8Array.from(sent.memo));

        const hostile = [
            {
                leafIndex: 0,
                commitmentHex: '',
                ephPkHex: null,
                encryptedMemo: memo,
                timestampMs: null,
                txHash: null,
            },
            {
                leafIndex: 1,
                commitmentHex: '0xzz',
                ephPkHex: null,
                encryptedMemo: memo,
                timestampMs: null,
                txHash: null,
            },
            {
                leafIndex: NaN,
                commitmentHex: sent.commitmentHex,
                ephPkHex: null,
                encryptedMemo: memo,
                timestampMs: null,
                txHash: null,
            },
            {
                leafIndex: 2,
                commitmentHex: sent.commitmentHex,
                ephPkHex: null,
                encryptedMemo: '0x00',
                timestampMs: null,
                txHash: null,
            },
            // El memo del pago emparejado con el commitment del CAMBIO.
            {
                leafIndex: 4,
                commitmentHex: change.commitmentHex,
                ephPkHex: null,
                encryptedMemo: memo,
                timestampMs: null,
                txHash: null,
            },
            asHint(change, 10),
            asHint(sent, 11),
        ] as ScanHint[];

        const result = await runScan({
            vault,
            storage,
            hints: hintSource(hostile),
            nullifiers: nullifierSource(),
            pool: realPool(),
            keys: restoredKeys(),
        });

        // Lo bueno se recupera entero pese a la basura de alrededor.
        expect(vault.getAll().map((n) => n.value)).toEqual([800n]);
        expect(result.sentNotes!.map((s) => s.value)).toEqual([4200n]);
    });

    it('un memo emparejado con el commitment ajeno no produce nota', async () => {
        // La defensa: `deriveEncryptionKey` mezcla el commitment, así que un
        // memo servido junto a otro commitment no abre. Sin eso, un feed podría
        // inventar notas con importes elegidos por él.
        clearKnownEphWindow();
        const { storage, vault } = await freshVault();
        const { sent, change } = await transfer({
            to: ALICE,
            value: 4200n,
            outIndex: 0,
            selfIndex: 0,
            change: 800n,
        });

        await runScan({
            vault,
            storage,
            hints: hintSource([
                {
                    ...asHint(change, 0),
                    encryptedMemo: toHex(Uint8Array.from(sent.memo)),
                },
            ]),
            nullifiers: nullifierSource(),
            pool: realPool(),
            keys: restoredKeys(),
        });

        expect(vault.getAll()).toEqual([]);
    });
});
