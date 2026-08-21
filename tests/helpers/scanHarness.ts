/**
 * El andamiaje que comparten los tests de extremo a extremo.
 *
 * Antes vivía copiado en tres sitios (`identityLifecycle.e2e.test.ts` y dos
 * veces en `pipeline.test.ts`), y las copias ya habían divergido: una abría el
 * vault con la raíz del emisor y otra con `fill(9)`. Un andamiaje duplicado es
 * un andamiaje que se corrige en un sitio y se queda mal en los otros.
 *
 * `realPool` es la pieza que importa: corre el kernel de descifrado DE VERDAD
 * en el hilo principal, sin worker. Un pool falso comprueba el cableado; éste
 * comprueba que la criptografía cierra de punta a punta.
 */
import {
    VaultStore,
    MemoryVaultStorage,
    createNotesCache,
    createWalletSession,
    deriveVaultKey,
    deriveVaultBlindKey,
    VAULT_SCHEMA_VERSION,
} from '../../src/index';
import type { VaultUnlockOptions } from '../../src/index';
import { decryptHintBatch } from '../../src/wallet/worker/kernel/decryptBatch';
import { toHex } from '../../src/foundation/encoding/hex';
import type { DecryptPool } from '../../src/index';
import type {
    ScanHint,
    ScanHintSource,
    NullifierSource,
} from '../../src/wallet/scanner/feed/sources';
import type { ZkNote } from '../../src/protocol/types';

/**
 * Una nota tal como la sirve el indexer.
 *
 * `ephPkHex: null` a propósito: el campo es anulable por contrato y el kernel
 * lee la efímera de los últimos 32 bytes del memo. Dejarlo nulo aquí mantiene
 * ese camino ejercitado en todos los tests que usan este andamiaje.
 */
export const asHint = (note: ZkNote, leafIndex: number): ScanHint => ({
    leafIndex,
    commitmentHex: note.commitmentHex,
    ephPkHex: null,
    encryptedMemo: toHex(Uint8Array.from(note.memo)),
    timestampMs: null,
    txHash: null,
});

/**
 * Un feed que sirve TODO en una sola página, ignorando `page` y `limit`.
 *
 * Cómodo para un puñado de pistas, pero deja el bucle de paginación sin dar
 * una segunda vuelta. Para cualquier test que dependa de recorrer el feed
 * —cursor, checkpoints, purga de fantasmas— hay que usar `pagedHintSource`:
 * con éste, un `sinceLeafIndex` mal propagado o un cálculo de páginas
 * equivocado pasan inadvertidos.
 */
export const hintSource = (hints: ScanHint[]): ScanHintSource => ({
    async listHints({ limit }) {
        return { data: hints, pagination: { limit, total: hints.length } };
    },
});

/**
 * Un feed que pagina DE VERDAD, respetando `page` y `limit`.
 *
 * `pagination.limit` devuelve el límite realmente aplicado, que es lo que el
 * escáner usa para contar páginas: un servidor que recorta el límite pedido y
 * no lo dice hace que el cliente calcule de menos y se salte pistas.
 *
 * `calls` cuenta las peticiones, para distinguir "sirvió una página" de
 * "recorrió el feed entero".
 */
export function pagedHintSource(
    hints: ScanHint[],
    serverLimit = 2500
): ScanHintSource & { calls: () => number } {
    let calls = 0;
    return {
        calls: () => calls,
        async listHints({ page, limit, sinceLeafIndex }) {
            calls++;
            const visible =
                sinceLeafIndex === undefined
                    ? hints
                    : hints.filter((h) => h.leafIndex >= sinceLeafIndex);
            const applied = Math.min(limit, serverLimit);
            return {
                data: visible.slice((page - 1) * applied, page * applied),
                pagination: { limit: applied, total: visible.length },
            };
        },
    };
}

/** Un conjunto de nullifiers; por defecto, nada gastado. */
export const nullifierSource = (spentHexes: string[] = []): NullifierSource => ({
    async manifest() {
        return { generation: '1', chunks: [] };
    },
    async chunk() {
        return { data: [] };
    },
    async tail() {
        return {
            afterChunks: 0,
            data: spentHexes,
            timestampsMs: spentHexes.map(() => 4242),
            txHashes: spentHexes.map(() => null),
        };
    },
});

/** El kernel real, sin worker — mismo código, mismo contrato de resultado. */
export const realPool = (): DecryptPool =>
    ({
        async decryptBatch(hints: ScanHint[], keys: unknown) {
            return decryptHintBatch(hints as never, keys as never);
        },
        terminate() {},
    }) as unknown as DecryptPool;

/**
 * Un vault vacío con la sesión abierta A MANO, sin pasar por `unlock()`.
 *
 * Sirve para un test que sólo necesita dónde guardar notas y no está probando
 * la apertura. Para cualquier cosa que dependa de releer del disco —una nota
 * que vuelve tras cerrar, un reset por identidad ajena— hay que usar
 * `openVault`: esto se salta el descifrado de registros, la normalización y la
 * comprobación de esquema, así que un fallo en cualquiera de los tres pasa
 * inadvertido.
 *
 * Cada llamada crea almacenamiento nuevo: un test que empieza con estado de
 * otro no prueba lo que dice probar.
 */
export async function freshVault(
    master: Uint8Array
): Promise<{ storage: MemoryVaultStorage; vault: VaultStore }> {
    const storage = new MemoryVaultStorage();
    const session = createWalletSession();
    const vault = new VaultStore({ storage, session, notes: createNotesCache() });
    session.open(await deriveVaultKey(master), await deriveVaultBlindKey(master));
    await storage.putConfig({ id: 'main', v: VAULT_SCHEMA_VERSION, createdAt: 1, updatedAt: 1 });
    return { storage, vault };
}

/**
 * Un vault abierto por el camino REAL: `unlock()` con la clave derivada.
 *
 * La diferencia con `freshVault` es lo que se ejercita, no lo que se obtiene:
 * `unlock` descifra cada registro guardado, lo normaliza, comprueba la versión
 * de esquema y el fingerprint de cadena, y decide si resetear. Nada de eso
 * corre cuando la sesión se abre a mano.
 *
 * Reabrir sobre el MISMO `storage` es lo que prueba que una nota sobrevivió al
 * disco — `getAll()` tras un `save()` lee la caché en memoria y pasaría igual
 * con el cifrado roto.
 *
 * @param master  la raíz de la identidad; una distinta debe resetear el vault
 * @param storage reutilizar uno existente para reabrir, u omitir para empezar
 */
export async function openVault(
    master: Uint8Array,
    storage: MemoryVaultStorage = new MemoryVaultStorage(),
    options: VaultUnlockOptions = {}
): Promise<{
    storage: MemoryVaultStorage;
    vault: VaultStore;
    wasReset: boolean;
    notes: ZkNote[];
}> {
    const session = createWalletSession();
    const vault = new VaultStore({ storage, session, notes: createNotesCache() });
    const cryptoKey = await deriveVaultKey(master);
    // La sesión se abre ANTES de leer el vault, igual que en `OrbinumWallet`:
    // `unlock` descifra con las claves que ya están puestas.
    session.open(cryptoKey, await deriveVaultBlindKey(master));
    const { wasReset, notes } = await vault.unlock(cryptoKey, {
        expectedSchemaVersion: VAULT_SCHEMA_VERSION,
        ...options,
    });
    return { storage, vault, wasReset, notes };
}
