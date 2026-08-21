/**
 * Gastar de punta a punta, contra un vault DE VERDAD.
 *
 * Los tests de `ops/spend/` mockean el vault (`{ markSpent: vi.fn(), save:
 * vi.fn() }`) y el constructor de notas. Eso comprueba que la operación LLAMA a
 * lo que debe — no que lo que guarda se pueda releer, ni que lo que marca
 * quede marcado.
 *
 * La diferencia importa por un bug que ya ocurrió y que `transfer.ts:258`
 * documenta: el cambio construido a partir de la nota de entrada quedaba
 * sellado hacia una clave de un solo uso, y el rescan no lo abría. Al enviar
 * todo parecía bien —el cambio se guarda desde memoria y el saldo cuadra— y el
 * dinero desaparecía al restaurar. Un `vault.save` falso no puede ver eso; sólo
 * verlo desaparecer al reabrir puede.
 *
 * Aquí sólo se simulan las dos cosas que necesitan una máquina distinta: el
 * proving y el envío a la cadena. El vault, el constructor de notas y las
 * reservas de índices efímeros son los reales.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { openVault } from '../../helpers/scanHarness';
import { transferNotes } from '../../../src/wallet/ops/spend/transfer';
import { unshieldNote } from '../../../src/wallet/ops/spend/unshield';
import { buildZkNoteWithIndex } from '../../../src/wallet/ops/notes/buildNote';
import { NoteBuilder } from '../../../src/protocol/note/NoteBuilder';
import { deriveIdentity } from '../../../src/wallet/identity/walletIdentity';
import { checkSpendableInputs } from '../../../src/wallet/ops/spend/guards';
import { isSpendable } from '../../../src/protocol/spend/index';
import { reserveOutgoingIndex } from '../../../src/wallet/vault/index';
import { recoverSelfStealthNote } from '../../../src/wallet/ops/notes/selfStealthNote';
import { deriveStealthSk, deriveStealthOwnerPk } from '../../../src/foundation/crypto/stealth';
import { recoverOwnerPkPoint } from '../../../src/foundation/crypto/bjj';
import type { MemoryVaultStorage, VaultStore } from '../../../src/index';
import type { ZkNote } from '../../../src/protocol/types';

vi.mock('../../../src/protocol/proving/transfer', () => ({
    generateTransferProof: vi.fn().mockResolvedValue({ proof: '0xdeadbeef', publicSignals: [] }),
}));
vi.mock('../../../src/protocol/proving/unshield', () => ({
    generateUnshieldProof: vi.fn().mockResolvedValue({ proof: '0xdeadbeef', publicSignals: [] }),
}));

const ROOT = new Uint8Array(32).fill(0x31);
const me = deriveIdentity(ROOT, 'v3');
const them = deriveIdentity(new Uint8Array(32).fill(0x32), 'v3');

const MERKLE_ROOT = '0x' + 'aa'.repeat(32);
const RECIPIENT_SS58 = '5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY';

/**
 * Una nota RECIBIDA: sigilosa, con clave y owner de un solo uso.
 *
 * Es lo que un wallet gasta casi siempre, y el caso donde el bug de
 * `transfer.ts:258` muerde: un cambio que heredara estas claves quedaría
 * sellado hacia una clave de visión derivada de un escalar efímero, y el
 * rescan —que tiene la global— no lo abriría nunca.
 */
async function receivedStealthNote(value: bigint): Promise<ZkNote> {
    const sharedSecret = new Uint8Array(32).fill(0x2b);
    const ownPoint = recoverOwnerPkPoint(me.ownerPk)!;
    const note = await NoteBuilder.build({
        value,
        assetId: 0n,
        ownerPk: deriveStealthOwnerPk(sharedSecret, me.ownerPk, ownPoint),
        spendingKey: deriveStealthSk(sharedSecret, me.ownerPk, me.spendingKey),
        viewingPublicKey: me.viewingPublicKey,
    });
    // Lo que el escaneo persiste: el escalar sigiloso, nunca el global.
    expect(note.spendingKey).not.toBe(me.spendingKey);
    expect(note.ownerPk).not.toBe(me.ownerPk);
    return note;
}

/** Una nota propia ya en el vault: lo que deja un shield. */
async function ownNote(value: bigint): Promise<ZkNote> {
    return NoteBuilder.build({
        value,
        assetId: 0n,
        ownerPk: me.ownerPk,
        spendingKey: me.spendingKey,
        viewingPublicKey: me.viewingPublicKey,
    });
}

/**
 * Las dependencias de un gasto, con el vault y el builder REALES.
 *
 * Sólo `resolver` y `submit` son falsos: uno necesitaría artefactos de circuito
 * y el otro una cadena. Todo lo demás —incluidas las reservas de índice contra
 * el almacenamiento— corre de verdad.
 */
function realDeps(vault: VaultStore, storage: MemoryVaultStorage) {
    const submitted: unknown[] = [];
    return {
        submitted,
        deps: {
            privacy: {
                getNullifierStatus: vi.fn().mockResolvedValue({ isSpent: false }),
                getMerkleProofByCommitment: vi.fn().mockResolvedValue({
                    root: MERKLE_ROOT,
                    path: ['0x' + '11'.repeat(32)],
                    leafIndex: 1,
                    treeId: 0,
                }),
            },
            resolver: {
                resolve: vi.fn().mockResolvedValue({ provider: { tag: 'p' }, version: 1 }),
            },
            buildNote: (p: Parameters<typeof buildZkNoteWithIndex>[0]) =>
                buildZkNoteWithIndex(
                    { ...p, circuitVersion: 1 },
                    {
                        keys: {
                            ownerPk: me.ownerPk,
                            spendingKey: me.spendingKey,
                            viewingPublicKey: me.viewingPublicKey,
                            viewingSecretKey: me.viewingSecretKey,
                            outgoingViewingKey: me.outgoingViewingKey,
                        },
                        storage,
                    }
                ),
            vault,
            // La función REAL: el cambio de un unshield se construye con la
            // clave global contra un ownerPk sigiloso, y sólo se persiste si
            // esto rederiva la clave que lo hace gastable.
            recoverStealth: (note: ZkNote) =>
                recoverSelfStealthNote(note, {
                    viewingSecretKey: me.viewingSecretKey,
                    spendingKey: me.spendingKey,
                    ownerPk: me.ownerPk,
                }),
            submit: vi.fn().mockImplementation((req: unknown) => {
                submitted.push(req);
                return Promise.resolve({
                    ok: true,
                    txHash: '0xtx',
                    blockHash: '0xb',
                    blockNumber: 1,
                });
            }),
            selfOwnerPk: me.ownerPk,
            outgoingViewingKey: me.outgoingViewingKey,
            // La identidad GLOBAL, no una del vault: el builder deriva la clave
            // sigilosa desde ella y una clave de nota derivaría basura.
            stealthKeys: { ownerPk: me.ownerPk, spendingKey: me.spendingKey },
        },
    };
}

describe('el cambio de una transferencia sobrevive al disco', () => {
    it('se relee tras reabrir el vault, y es GASTABLE', async () => {
        // El bug de `transfer.ts:258` exactamente: invisible al enviar, sólo
        // visible al restaurar. Si el cambio heredara las claves de la nota de
        // entrada, volvería del disco con un `ownerPk` que este wallet no
        // deriva y un memo que su clave de visión no abre.
        const input = await ownNote(1000n);
        const first = await openVault(ROOT);
        await first.vault.save(input);
        const { deps } = realDeps(first.vault, first.storage);

        await transferNotes(deps as never, {
            inputNotes: [input],
            transferAmount: 400n,
            recipientPk: them.ownerPk,
            recipientViewingPublicKey: them.viewingPublicKey,
            fee: 0n,
        });

        const reopened = await openVault(ROOT, first.storage);
        const change = reopened.notes.find((n) => !n.spent && n.value === 600n);

        expect(change).toBeDefined();
        expect(checkSpendableInputs([change]).ok).toBe(true);
    });

    it('GASTANDO UNA NOTA RECIBIDA, el cambio sigue siendo relegible', async () => {
        // El caso real y el único donde el bug muerde: la entrada es sigilosa,
        // así que heredar sus claves produce un cambio que se guarda bien y
        // desaparece al reabrir.
        const input = await receivedStealthNote(1000n);
        const first = await openVault(ROOT);
        await first.vault.save(input);
        const { deps } = realDeps(first.vault, first.storage);

        await transferNotes(deps as never, {
            inputNotes: [input],
            transferAmount: 400n,
            recipientPk: them.ownerPk,
            recipientViewingPublicKey: them.viewingPublicKey,
            fee: 0n,
        });

        const { notes } = await openVault(ROOT, first.storage);
        const change = notes.find((n) => !n.spent && n.value === 600n);

        expect(change).toBeDefined();
        expect(change!.ownerPk).toBe(me.ownerPk);
        expect(checkSpendableInputs([change]).ok).toBe(true);
    });

    it('y el cambio pertenece a la identidad GLOBAL, no a una de un solo uso', async () => {
        // La razón por la que lo anterior funciona: un `ownerPk` sigiloso sería
        // una clave que el wallet no vuelve a derivar nunca.
        const input = await ownNote(1000n);
        const first = await openVault(ROOT);
        await first.vault.save(input);
        const { deps } = realDeps(first.vault, first.storage);

        await transferNotes(deps as never, {
            inputNotes: [input],
            transferAmount: 400n,
            recipientPk: them.ownerPk,
            recipientViewingPublicKey: them.viewingPublicKey,
            fee: 0n,
        });

        const { notes } = await openVault(ROOT, first.storage);
        const change = notes.find((n) => n.value === 600n)!;

        expect(change.ownerPk).toBe(me.ownerPk);
        expect(change.spendingKey).toBe(me.spendingKey);
    });

    it('un cambio de valor cero NO entra en el vault', async () => {
        // El circuito trata una entrada de valor 0 como dummy y fuerza su
        // nullifier a 0, así que sería imposible de gastar. Contarla infla el
        // saldo con dinero que no se mueve.
        const input = await ownNote(1000n);
        const first = await openVault(ROOT);
        await first.vault.save(input);
        const { deps } = realDeps(first.vault, first.storage);

        await transferNotes(deps as never, {
            inputNotes: [input],
            transferAmount: 1000n,
            recipientPk: them.ownerPk,
            recipientViewingPublicKey: them.viewingPublicKey,
            fee: 0n,
        });

        const { notes } = await openVault(ROOT, first.storage);

        expect(notes.filter((n) => n.value === 0n)).toEqual([]);
    });
});

describe('una entrada gastada queda gastada', () => {
    it('sigue marcada tras reabrir, y deja de ser seleccionable', async () => {
        // `VaultStore.markSpent` tiene una salida temprana silenciosa
        // (`if (!target || target.spent) return`). Con un vault falso siempre
        // "funciona"; con el real, una nota que no esté en la caché no se marca
        // y no falla — y el siguiente gasto la vuelve a elegir y muere en
        // nullifier duplicado.
        const input = await ownNote(1000n);
        const first = await openVault(ROOT);
        await first.vault.save(input);
        const { deps } = realDeps(first.vault, first.storage);

        await transferNotes(deps as never, {
            inputNotes: [input],
            transferAmount: 400n,
            recipientPk: them.ownerPk,
            recipientViewingPublicKey: them.viewingPublicKey,
            fee: 0n,
        });

        const { notes } = await openVault(ROOT, first.storage);
        const spent = notes.find((n) => n.commitmentHex === input.commitmentHex);

        expect(spent?.spent).toBe(true);
        expect(isSpendable(spent!)).toBe(false);
    });

    it('el saldo gastable refleja el cambio, no la entrada original', async () => {
        const input = await ownNote(1000n);
        const first = await openVault(ROOT);
        await first.vault.save(input);
        const { deps } = realDeps(first.vault, first.storage);

        await transferNotes(deps as never, {
            inputNotes: [input],
            transferAmount: 400n,
            recipientPk: them.ownerPk,
            recipientViewingPublicKey: them.viewingPublicKey,
            fee: 0n,
        });

        const { notes } = await openVault(ROOT, first.storage);
        const spendable = notes.filter(isSpendable).reduce((s, n) => s + n.value, 0n);

        expect(spendable).toBe(600n);
    });
});

describe('unshield parcial', () => {
    it('el remanente vuelve del disco y es gastable', async () => {
        const input = await ownNote(1000n);
        const first = await openVault(ROOT);
        await first.vault.save(input);
        const { deps } = realDeps(first.vault, first.storage);

        await unshieldNote(deps as never, {
            note: input,
            amount: 300n,
            recipientAddress: RECIPIENT_SS58,
            fee: 0n,
        });

        const { notes } = await openVault(ROOT, first.storage);
        const remainder = notes.find((n) => !n.spent && n.value === 700n);

        expect(remainder).toBeDefined();
        expect(checkSpendableInputs([remainder]).ok).toBe(true);
    });
});

describe('los índices efímeros no se reutilizan', () => {
    let storage: MemoryVaultStorage;

    beforeEach(async () => {
        ({ storage } = await openVault(ROOT));
    });

    it('dos reservas concurrentes reciben índices distintos', async () => {
        // Reutilizar un índice republica una efímera ya publicada, y eso enlaza
        // las dos notas en público como del mismo emisor. La reserva es un
        // read-modify-write: sin atomicidad ambas leen el mismo valor.
        const [a, b] = await Promise.all([
            reserveOutgoingIndex(storage),
            reserveOutgoingIndex(storage),
        ]);

        expect(a).not.toBe(b);
    });

    it('y una transferencia real consume uno de la secuencia', async () => {
        const { vault } = await openVault(ROOT, storage);
        const input = await ownNote(1000n);
        await vault.save(input);
        const before = await reserveOutgoingIndex(storage);
        const { deps } = realDeps(vault, storage);

        await transferNotes(deps as never, {
            inputNotes: [input],
            transferAmount: 400n,
            recipientPk: them.ownerPk,
            recipientViewingPublicKey: them.viewingPublicKey,
            fee: 0n,
        });

        expect(await reserveOutgoingIndex(storage)).toBeGreaterThan(before + 1);
    });
});
