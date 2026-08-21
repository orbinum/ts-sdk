/**
 * El reintento acotado que rescata los pagos partidos por un límite de página.
 *
 * Cuando un pago cae en un lote y su nota de cambio en el siguiente, ningún
 * lote puede abrirlo por sí solo. `runScan` reintenta al final, ya con toda la
 * libreta del escaneo en la mano. Ese reintento es cuadrático —una ECDH por
 * (pago, entrada)— y corre en el hilo principal, así que ambos lados están
 * acotados a `RETRY_BOOK_LIMIT`.
 *
 * Dos cosas que el acotado tiene que hacer bien y no estaban fijadas:
 *
 *   - AVISAR cuando descarta, en los dos lados. Un historial a medias que no
 *     avisa se lee como un historial completo;
 *   - SOBREVIVIR a una entrada malformada. Las entradas son cadenas que cruzan
 *     la frontera del worker, y `BigInt('')` lanza: un `.map(BigInt)` a secas
 *     tumbaba el reintento entero, o sea TODOS los pagos varados del escaneo y
 *     no sólo el de la entrada mala.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { runScan } from '../../../src/wallet/scanner/pipeline';
import { MemoryVaultStorage } from '../../../src/index';
import { VaultStore, createNotesCache, createWalletSession } from '../../../src/wallet/vault/index';
import { deriveVaultKey, deriveVaultBlindKey } from '../../../src/wallet/vault/index';
import { deriveOwnerPk, deriveOutgoingViewingKeyV3 } from '../../../src/protocol/keys/PrivacyKeys';
import type { DecryptPool } from '../../../src/index';
import type {
    ScanHint,
    ScanHintSource,
    NullifierSource,
} from '../../../src/wallet/scanner/feed/sources';

const SPENDING_KEY = 12345678901234567890n;
const OVK = deriveOutgoingViewingKeyV3(new Uint8Array(32).fill(0x4d));
const RETRY_BOOK_LIMIT = 64;

const hint = (i: number): ScanHint => ({
    leafIndex: i,
    commitmentHex: `0xc${i}`,
    ephPkHex: null,
    encryptedMemo: '0x' + 'ab'.repeat(180),
    timestampMs: null,
    txHash: null,
});

function hintSource(size: number): ScanHintSource {
    return {
        async listHints({ limit }) {
            return {
                data: Array.from({ length: size }, (_, i) => hint(i)),
                pagination: { limit, total: size },
            };
        },
    };
}

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

/**
 * Un pool que reporta pagos varados y entradas de libreta, sin descifrar nada.
 *
 * Es lo que deja el escaneo cuando un pago y su cambio caen en lotes distintos,
 * que es la única situación en la que el reintento existe.
 */
function poolReporting(unmatchedCount: number, sealedEntries: string[]): DecryptPool {
    return {
        async decryptBatch(hints: ScanHint[]) {
            return {
                notes: hints.map(() => null),
                tagFiltered: 0,
                selfMatched: 0,
                pairwiseMatched: 0,
                maxSelfEphIndex: null,
                maxOutgoingEphIndex: null,
                sentNotes: [],
                learnedRecipients: [],
                unmatchedSent: Array.from({ length: unmatchedCount }, (_, i) => ({
                    hint: hint(i),
                    ephIndex: i,
                })),
                sealedBookEntries: sealedEntries,
            };
        },
        terminate() {},
    } as unknown as DecryptPool;
}

const KEYS = {
    viewingKey: new Uint8Array(32).fill(1),
    spendingKey: SPENDING_KEY,
    ownerPk: deriveOwnerPk(SPENDING_KEY),
    outgoingViewingKey: OVK,
};

describe('el reintento de la libreta, acotado', () => {
    let storage: MemoryVaultStorage;
    let vault: VaultStore;

    beforeEach(async () => {
        storage = new MemoryVaultStorage();
        const session = createWalletSession();
        vault = new VaultStore({ storage, session, notes: createNotesCache() });
        const master = new Uint8Array(32).fill(9);
        session.open(await deriveVaultKey(master), await deriveVaultBlindKey(master));
        await storage.putConfig({ id: 'main', v: 4, createdAt: 1, updatedAt: 1 });
    });

    const scanWith = (pool: DecryptPool, onWarning?: (m: string) => void) =>
        runScan({
            vault,
            storage,
            hints: hintSource(1),
            nullifiers: nullifierSource(),
            pool,
            keys: KEYS,
            ...(onWarning ? { onWarning } : {}),
        });

    it('una entrada MALFORMADA no tumba el reintento entero', async () => {
        // El fallo que esto cierra: `.map(BigInt)` sobre una cadena vacía lanza
        // fuera de todo try, y con él se caen los pagos varados de TODO el
        // escaneo — no sólo el que traía la entrada mala.
        const pool = poolReporting(2, ['', 'no-soy-un-numero', '12345']);

        await expect(scanWith(pool)).resolves.toBeDefined();
    });

    it('AVISA cuando descarta pagos varados por el tope', async () => {
        const warnings: string[] = [];
        const pool = poolReporting(RETRY_BOOK_LIMIT + 5, ['1']);

        await scanWith(pool, (m) => warnings.push(m));

        expect(warnings.some((w) => /retry capped at 64 of 69/.test(w))).toBe(true);
    });

    it('AVISA también cuando descarta ENTRADAS de libreta', async () => {
        // El lado que no avisaba. Descartar entradas en silencio deja pagos sin
        // recuperar y un historial a medias que parece completo.
        const warnings: string[] = [];
        const entries = Array.from({ length: RETRY_BOOK_LIMIT + 3 }, (_, i) => String(i + 1));
        const pool = poolReporting(1, entries);

        await scanWith(pool, (m) => warnings.push(m));

        expect(warnings.some((w) => /recipient book capped at 64 of 67/.test(w))).toBe(true);
    });

    it('no avisa de nada cuando todo cabe', async () => {
        // El contraste: un aviso que saltara siempre sería ruido, y el usuario
        // dejaría de leerlos justo cuando uno importa.
        const warnings: string[] = [];
        const pool = poolReporting(2, ['1', '2']);

        await scanWith(pool, (m) => warnings.push(m));

        expect(warnings.filter((w) => /capped at/.test(w))).toHaveLength(0);
    });
});
