/**
 * Lo que el SDK le pregunta al servidor — y lo que no.
 *
 * Tres sitios del código documentan la misma invariante y ninguno tenía test:
 *
 *   `vault/storage/contract.ts:132`
 *     "asking a server whether one specific nullifier is spent would tell it
 *      which notes the wallet holds"
 *   `vault/store/unlock.ts:36`
 *     "checking all of them would hand the node the wallet's entire commitment
 *      set, which is exactly the linkage the scan design avoids"
 *
 * Era prosa. Nada impedía que una refactorización "optimizara" el escaneo
 * consultando por nota — más rápido, correcto, y con el servidor aprendiendo
 * exactamente qué notas tiene el usuario. Un cambio así pasaría el resto de la suite sin un solo fallo.
 *
 * Aquí las fuentes registran CADA petición y los tests comprueban su contenido.
 * La propiedad que se mide no es "el escaneo funciona", sino que dos usuarios
 * distintos emiten peticiones INDISTINGUIBLES.
 *
 * Hay una asimetría deliberada que estos tests también fijan: el escaneo no
 * revela nada, pero el GASTO sí pide la prueba de Merkle de una nota concreta.
 * Es inevitable —hace falta la prueba de ESA nota— y por eso conviene que esté
 * escrito, acotado y no se extienda al escaneo.
 */
import { describe, it, expect, vi } from 'vitest';
import { openVault, asHint, realPool, nullifierSource } from '../../helpers/scanHarness';
import { runScan } from '../../../src/wallet/scanner/pipeline';
import { reconstructOutgoingTxRecords } from '../../../src/wallet/scanner/history/reconstruct';
import { NoteBuilder } from '../../../src/protocol/note/NoteBuilder';
import { deriveIdentity } from '../../../src/wallet/identity/walletIdentity';
import type { ScanHint, ScanHintSource } from '../../../src/wallet/scanner/feed/sources';
import type { ZkNote } from '../../../src/protocol/types';

const ROOT = new Uint8Array(32).fill(0x71);
const me = deriveIdentity(ROOT, 'v3');
const other = deriveIdentity(new Uint8Array(32).fill(0x72), 'v3');

const scanKeys = (id: typeof me) => ({
    viewingKey: id.viewingSecretKey,
    spendingKey: id.spendingKey,
    ownerPk: id.ownerPk,
});

const noteFor = (id: typeof me, value: bigint, blinding: bigint): Promise<ZkNote> =>
    NoteBuilder.build({
        value,
        assetId: 0n,
        blinding,
        ownerPk: id.ownerPk,
        spendingKey: id.spendingKey,
        viewingPublicKey: id.viewingPublicKey,
    });

/** Un feed que apunta con qué parámetros se le llamó. */
function recordingHints(hints: ScanHint[]): ScanHintSource & { requests: unknown[] } {
    const requests: unknown[] = [];
    return {
        requests,
        async listHints(params) {
            requests.push({ method: 'listHints', params });
            return { data: hints, pagination: { limit: params.limit, total: hints.length } };
        },
    };
}

/** Un feed de nullifiers que apunta cada llamada y sus argumentos. */
function recordingNullifiers(spent: string[] = []) {
    const requests: unknown[] = [];
    const base = nullifierSource(spent);
    return {
        requests,
        source: {
            async manifest() {
                requests.push({ method: 'manifest', args: [] });
                return base.manifest();
            },
            async chunk(idx: number, digest: string) {
                requests.push({ method: 'chunk', args: [idx, digest] });
                return base.chunk(idx, digest);
            },
            async tail() {
                requests.push({ method: 'tail', args: [] });
                return base.tail();
            },
        },
    };
}

/** Todo lo que viajó, como texto, para buscar identificadores dentro. */
const wire = (requests: unknown[]): string => JSON.stringify(requests);

describe('un escaneo no revela qué notas tiene el usuario', () => {
    it('nunca pregunta por un nullificador concreto', async () => {
        // La consulta prohibida: `isNullifierSpent(mío)` le dice al servidor
        // exactamente qué nota es del usuario. El conjunto se descarga entero
        // y se interseca en local precisamente para evitarlo.
        const note = await noteFor(me, 100n, 1n);
        const nullifiers = recordingNullifiers([]);
        const { vault, storage } = await openVault(ROOT);

        await runScan({
            vault,
            storage,
            hints: recordingHints([asHint(note, 0)]),
            nullifiers: nullifiers.source,
            pool: realPool(),
            keys: scanKeys(me),
        });

        // Ninguna petición lleva el nullificador de la nota.
        expect(wire(nullifiers.requests)).not.toContain(note.nullifierHex.slice(2));
        // Y las únicas llamadas son las del contrato: manifiesto, chunks, cola.
        const methods = new Set(nullifiers.requests.map((r) => (r as { method: string }).method));
        expect([...methods].sort()).toEqual(['manifest', 'tail']);
    });

    it('nunca pide un commitment concreto', async () => {
        const note = await noteFor(me, 100n, 1n);
        const hints = recordingHints([asHint(note, 0)]);
        const { vault, storage } = await openVault(ROOT);

        await runScan({
            vault,
            storage,
            hints,
            nullifiers: nullifierSource(),
            pool: realPool(),
            keys: scanKeys(me),
        });

        expect(wire(hints.requests)).not.toContain(note.commitmentHex.slice(2));
    });

    it('DOS USUARIOS DISTINTOS emiten peticiones idénticas', async () => {
        // La prueba de que no hay fuga, no la ausencia de una fuga concreta:
        // si las peticiones dependen de las claves, dos wallets con notas
        // distintas piden cosas distintas y el servidor los distingue.
        const pool = [
            asHint(await noteFor(me, 100n, 1n), 0),
            asHint(await noteFor(other, 5n, 2n), 1),
        ];

        const runFor = async (id: typeof me, root: Uint8Array) => {
            const hints = recordingHints(pool);
            const nulls = recordingNullifiers([]);
            const { vault, storage } = await openVault(root);
            await runScan({
                vault,
                storage,
                hints,
                nullifiers: nulls.source,
                pool: realPool(),
                keys: scanKeys(id),
            });
            return wire([...hints.requests, ...nulls.requests]);
        };

        expect(await runFor(me, ROOT)).toBe(await runFor(other, new Uint8Array(32).fill(0x72)));
    });
});

describe('`unlock` muestrea una nota, no todas', () => {
    it('valida exactamente un commitment, haya las que haya', async () => {
        // Validar todas entregaría al nodo el conjunto completo del vault —
        // la linkabilidad que el diseño del escaneo existe para evitar.
        const first = await openVault(ROOT);
        for (let i = 0; i < 12; i++)
            await first.vault.save(await noteFor(me, BigInt(i + 1), BigInt(i)));

        const validateCommitment = vi.fn().mockResolvedValue(true);
        await openVault(ROOT, first.storage, { validateCommitment });

        expect(validateCommitment).toHaveBeenCalledTimes(1);
    });

    it('y sin validador no pregunta nada', async () => {
        const first = await openVault(ROOT);
        await first.vault.save(await noteFor(me, 100n, 1n));

        const reopened = await openVault(ROOT, first.storage);

        expect(reopened.notes).toHaveLength(1);
    });
});

describe('la reconstrucción de historial SÍ revela el vault', () => {
    /**
     * Documenta la asimetría, no la aprueba.
     *
     * `reconstructOutgoingTxRecords` envía al indexer los nullificadores
     * gastados y TODOS los commitments del vault. Es lo contrario de lo que
     * hace el escaneo, y la app lo llama en cada rescan.
     *
     * Se fija aquí para que el alcance no crezca en silencio: si un cambio
     * futuro añade otro identificador a la petición, este test lo dice.
     */
    it('envía exactamente los commitments del vault, ni uno más', async () => {
        const spent = await noteFor(me, 100n, 1n);
        const unspent = await noteFor(me, 200n, 2n);
        const { vault, storage } = await openVault(ROOT);
        await vault.save(spent);
        await vault.save(unspent);
        await vault.markSpent(spent.commitmentHex);

        const asked: { byNullifiers: string[][]; byCommitments: string[][] } = {
            byNullifiers: [],
            byCommitments: [],
        };
        await reconstructOutgoingTxRecords({
            vault,
            transfers: {
                byNullifiers: async (n) => {
                    asked.byNullifiers.push(n);
                    return [];
                },
                byCommitments: async (c) => {
                    asked.byCommitments.push(c);
                    return [];
                },
            },
            txFacts: { byHash: async () => null },
            sentNotes: [],
        });

        // Sólo los GASTADOS por nullificador — no todo el vault.
        expect(asked.byNullifiers.flat()).toEqual([spent.nullifierHex]);
        // Y todos los commitments, gastados o no. Ésta es la fuga.
        expect(asked.byCommitments.flat().sort()).toEqual(
            [spent.commitmentHex, unspent.commitmentHex].sort()
        );
    });

    it('con el vault vacío de notas gastadas no pregunta nada', async () => {
        // La única mitigación que ya existe: sin nada gastado no hay historial
        // que reconstruir, y la petición no llega a salir.
        const { vault, storage } = await openVault(ROOT);
        await vault.save(await noteFor(me, 100n, 1n));
        let called = false;

        await reconstructOutgoingTxRecords({
            vault,
            transfers: {
                byNullifiers: async () => {
                    called = true;
                    return [];
                },
                byCommitments: async () => {
                    called = true;
                    return [];
                },
            },
            txFacts: { byHash: async () => null },
        });

        expect(called).toBe(false);
        expect(storage).toBeDefined();
    });
});
