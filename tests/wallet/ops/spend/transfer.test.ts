/**
 * transferNotes — the full spend flow with real guards and injected transport.
 *
 * The root-reconciliation block is the one that pays for this file: two proofs
 * fetched under different best blocks anchor to different roots, and without
 * the loop the failure is an opaque circuit assert after seconds of proving.
 * The cross-tree guard inside it matters just as much — those roots can never
 * agree, and retrying against them reports "tree advancing too quickly" for a
 * condition that is actually permanent.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => ({ generateTransferProof: vi.fn() }));
vi.mock('../../../../src/protocol/proving/transfer', async (importOriginal) => ({
    ...(await importOriginal<typeof import('../../../../src/protocol/proving/transfer')>()),
    generateTransferProof: mocks.generateTransferProof,
}));

import { transferNotes } from '../../../../src/wallet/ops/spend/transfer';
import type { TransferDeps } from '../../../../src/wallet/ops/spend/transfer';
import { computeNoteCommitment } from '../../../../src/protocol/note/NoteDecryptor';
import {
    deriveOwnerPk,
    deriveViewingSecretKey,
    deriveViewingPublicKey,
} from '../../../../src/protocol/keys/PrivacyKeys';
import { toHex } from '../../../../src/foundation/encoding/hex';
import { bigintTo32LeArr } from '../../../../src/foundation/encoding/bytes';
import type { ZkNote } from '../../../../src/protocol/types';

const SPENDING_KEY = 12345678901234567890n;
const OWNER_PK = deriveOwnerPk(SPENDING_KEY);
const SENDER_IVK = deriveViewingPublicKey(deriveViewingSecretKey(SPENDING_KEY));

/** Real 32-byte hex per logical root label — fromHex runs for real in submit. */
const ROOTS: Record<string, string> = Object.fromEntries(
    [
        ['0xroot', 'aa'],
        ['0xold', 'b1'],
        ['0xnew', 'b2'],
        ['0xstale', 'c1'],
        ['0xfresh', 'c2'],
        ['0xa', 'd1'],
        ['0xb', 'd2'],
    ].map(([label, byte]) => [label, '0x' + byte!.repeat(32)])
);

/** Self-consistent input note — the real checkSpendableInputs must accept it. */
function makeNote(value: bigint, blinding = 9n, circuitVersion = 1): ZkNote {
    const assetId = 1n;
    const commitment = computeNoteCommitment(value, assetId, OWNER_PK, blinding);
    return {
        value,
        assetId,
        ownerPk: OWNER_PK,
        blinding,
        spendingKey: SPENDING_KEY,
        commitment,
        nullifier: blinding * 1000n,
        commitmentHex: toHex(new Uint8Array(bigintTo32LeArr(commitment))),
        nullifierHex: toHex(new Uint8Array(bigintTo32LeArr(blinding * 1000n))),
        memo: [],
        sourcePk: 0n,
        circuitVersion,
        spent: false,
        spentAt: null,
    } as ZkNote;
}

/** Output the fake builder returns; distinct per ownerPk so calls are tellable. */
const builtNote = (ownerPk: bigint, value: bigint): ZkNote =>
    ({
        value,
        assetId: 1n,
        ownerPk,
        blinding: 5n,
        spendingKey: SPENDING_KEY,
        commitment: ownerPk * 10n,
        commitmentHex: toHex(new Uint8Array(bigintTo32LeArr(ownerPk * 10n))),
        nullifierHex: toHex(new Uint8Array(bigintTo32LeArr(ownerPk * 11n))),
        memo: [Number(ownerPk % 256n), 1],
    }) as unknown as ZkNote;

const proof = (root: string, over: Partial<{ treeId: number; leafIndex: number }> = {}) => ({
    root,
    path: ['0xsib'],
    leafIndex: over.leafIndex ?? 1,
    treeId: over.treeId ?? 0,
});

function makeDeps(over: Partial<TransferDeps> = {}) {
    const base = {
        privacy: {
            getNullifierStatus: vi.fn().mockResolvedValue({ isSpent: false }),
            getMerkleProofByCommitment: vi.fn().mockResolvedValue(proof(ROOTS['0xroot']!)),
        },
        resolver: { resolve: vi.fn().mockResolvedValue({ provider: { tag: 'p' }, version: 1 }) },
        buildNote: vi
            .fn()
            .mockImplementation((p: { ownerPk: bigint; value: bigint }) =>
                Promise.resolve(builtNote(p.ownerPk, p.value))
            ),
        vault: {
            markSpent: vi.fn().mockResolvedValue(undefined),
            save: vi.fn().mockResolvedValue(undefined),
        },
        recoverStealth: vi.fn().mockReturnValue(null),
        submit: vi
            .fn()
            .mockResolvedValue({ ok: true, txHash: '0xtx', blockHash: '0xb', blockNumber: 1 }),
        selfOwnerPk: null,
    };
    return Object.assign(base, over);
}

const asDeps = (d: ReturnType<typeof makeDeps>) => d as unknown as TransferDeps;

beforeEach(() => {
    vi.clearAllMocks();
    mocks.generateTransferProof.mockResolvedValue({ proof: '0xdeadbeef', publicSignals: [] });
});

describe('transferNotes — guards', () => {
    it('rejects a zero amount', async () => {
        const result = await transferNotes(asDeps(makeDeps()), {
            inputNotes: [makeNote(50n)],
            transferAmount: 0n,
            recipientPk: 99n,
        });

        expect(result.ok).toBe(false);
        expect(result.error).toContain('greater than zero');
    });

    it('rejects amount + fee above the inputs', async () => {
        const result = await transferNotes(asDeps(makeDeps()), {
            inputNotes: [makeNote(50n)],
            transferAmount: 45n,
            recipientPk: 99n,
            fee: 10n,
        });

        expect(result.ok).toBe(false);
        expect(result.error).toContain('Insufficient note value');
    });

    it('rejects mixed circuit versions before touching the network', async () => {
        const deps = makeDeps();

        const result = await transferNotes(asDeps(deps), {
            inputNotes: [makeNote(50n, 9n, 1), makeNote(30n, 8n, 2)],
            transferAmount: 10n,
            recipientPk: 99n,
        });

        expect(result.ok).toBe(false);
        expect(result.error).toContain('circuit versions');
        expect(deps.privacy.getNullifierStatus).not.toHaveBeenCalled();
        expect(mocks.generateTransferProof).not.toHaveBeenCalled();
    });

    it('rejects a drifted note and never proves', async () => {
        const deps = makeDeps();
        const bad = { ...makeNote(50n), value: 999n } as ZkNote;

        const result = await transferNotes(asDeps(deps), {
            inputNotes: [bad],
            transferAmount: 10n,
            recipientPk: 99n,
        });

        expect(result.ok).toBe(false);
        expect(result.error).toContain('on-chain commitment');
        expect(deps.privacy.getNullifierStatus).not.toHaveBeenCalled();
    });
});

describe('transferNotes — nullifier checks', () => {
    it('fails and reconciles when input A is already spent', async () => {
        const deps = makeDeps();
        deps.privacy.getNullifierStatus.mockResolvedValue({ isSpent: true });
        const noteA = makeNote(50n);

        const result = await transferNotes(asDeps(deps), {
            inputNotes: [noteA],
            transferAmount: 10n,
            recipientPk: 99n,
        });

        expect(result.ok).toBe(false);
        expect(result.error).toContain('NullifierAlreadySpent');
        expect(deps.vault.markSpent).toHaveBeenCalledWith(noteA.commitmentHex);
        expect(mocks.generateTransferProof).not.toHaveBeenCalled();
    });

    it('fails and reconciles when input B is already spent', async () => {
        const deps = makeDeps();
        deps.privacy.getNullifierStatus
            .mockResolvedValueOnce({ isSpent: false })
            .mockResolvedValueOnce({ isSpent: true });
        const noteB = makeNote(30n, 8n);

        const result = await transferNotes(asDeps(deps), {
            inputNotes: [makeNote(50n), noteB],
            transferAmount: 10n,
            recipientPk: 99n,
        });

        expect(result.ok).toBe(false);
        expect(deps.vault.markSpent).toHaveBeenCalledWith(noteB.commitmentHex);
    });
});

describe('transferNotes — root reconciliation', () => {
    const twoNotes = (deps: ReturnType<typeof makeDeps>) =>
        transferNotes(asDeps(deps), {
            inputNotes: [makeNote(50n), makeNote(30n, 8n)],
            transferAmount: 60n,
            recipientPk: 99n,
        });

    it('converges first try when both proofs share a root', async () => {
        const deps = makeDeps();

        const result = await twoNotes(deps);

        expect(result.ok).toBe(true);
        expect(deps.privacy.getMerkleProofByCommitment).toHaveBeenCalledTimes(2);
        const input = mocks.generateTransferProof.mock.calls[0]?.[0] as { merkleRoot: string };
        expect(input.merkleRoot).toBe(ROOTS['0xroot']!);
    });

    it('refetches alternately until the roots agree, and proves under the converged root', async () => {
        const deps = makeDeps();
        deps.privacy.getMerkleProofByCommitment
            .mockResolvedValueOnce(proof(ROOTS['0xold']!)) // A
            .mockResolvedValueOnce(proof(ROOTS['0xnew']!)) // B — differs
            .mockResolvedValueOnce(proof(ROOTS['0xnew']!)); // A refetch — agree

        const result = await twoNotes(deps);

        expect(result.ok).toBe(true);
        const input = mocks.generateTransferProof.mock.calls[0]?.[0] as { merkleRoot: string };
        expect(input.merkleRoot).toBe(ROOTS['0xnew']!);
    });

    it('gives up when the roots never converge', async () => {
        const deps = makeDeps();
        let n = 0;
        deps.privacy.getMerkleProofByCommitment.mockImplementation(() =>
            Promise.resolve(proof('0x' + (n++).toString(16).padStart(2, '0').repeat(32)))
        );

        const result = await twoNotes(deps);

        expect(result.ok).toBe(false);
        expect(result.error).toContain('advancing too quickly');
        expect(mocks.generateTransferProof).not.toHaveBeenCalled();
    });

    it('fails immediately for inputs in different forest trees', async () => {
        // Those roots can NEVER agree; retrying would misreport a permanent
        // condition as a transient one.
        const deps = makeDeps();
        deps.privacy.getMerkleProofByCommitment
            .mockResolvedValueOnce(proof(ROOTS['0xa']!, { treeId: 0 }))
            .mockResolvedValueOnce(proof(ROOTS['0xb']!, { treeId: 1 }));

        const result = await twoNotes(deps);

        expect(result.ok).toBe(false);
        expect(result.error).toContain('different Merkle trees');
        // No reconciliation attempts were burned.
        expect(deps.privacy.getMerkleProofByCommitment).toHaveBeenCalledTimes(2);
    });

    it('does not let a malformed treeId block a valid pair', async () => {
        // NaN compares unequal to itself; an untrusted hint must sanitise to
        // tree 0 instead of flagging every pair as cross-tree.
        const deps = makeDeps();
        deps.privacy.getMerkleProofByCommitment
            .mockResolvedValueOnce(proof(ROOTS['0xroot']!, { treeId: NaN as unknown as number }))
            .mockResolvedValueOnce(proof(ROOTS['0xroot']!, { treeId: 0 }));

        const result = await twoNotes(deps);

        expect(result.ok).toBe(true);
    });

    it('single note: refetches once and keeps the newer proof if the root moved', async () => {
        const deps = makeDeps();
        deps.privacy.getMerkleProofByCommitment
            .mockResolvedValueOnce(proof(ROOTS['0xstale']!))
            .mockResolvedValueOnce(proof(ROOTS['0xfresh']!));

        const result = await transferNotes(asDeps(deps), {
            inputNotes: [makeNote(50n)],
            transferAmount: 10n,
            recipientPk: 99n,
        });

        expect(result.ok).toBe(true);
        const input = mocks.generateTransferProof.mock.calls[0]?.[0] as { merkleRoot: string };
        expect(input.merkleRoot).toBe(ROOTS['0xfresh']!);
    });

    it('single note: keeps the original proof when the root did not move', async () => {
        const deps = makeDeps();

        await transferNotes(asDeps(deps), {
            inputNotes: [makeNote(50n)],
            transferAmount: 10n,
            recipientPk: 99n,
        });

        expect(deps.privacy.getMerkleProofByCommitment).toHaveBeenCalledTimes(2);
        const input = mocks.generateTransferProof.mock.calls[0]?.[0] as { merkleRoot: string };
        expect(input.merkleRoot).toBe(ROOTS['0xroot']!);
    });
});

describe('transferNotes — output construction', () => {
    it('builds recipient and change with the documented key wiring', async () => {
        const deps = makeDeps({ selfOwnerPk: OWNER_PK } as Partial<TransferDeps>);
        const ivk = new Uint8Array(32).fill(3);
        // A stealth-received input, so `sourcePk` is genuinely one-time and the
        // wiring below is exercised with the values a real transfer carries.
        const input = { ...makeNote(50n), ownerPk: 0xbeefn } as ZkNote;

        await transferNotes(asDeps(deps), {
            inputNotes: [input],
            transferAmount: 30n,
            recipientPk: 99n,
            recipientViewingPublicKey: ivk,
        });

        const [recipientCall, changeCall] = deps.buildNote.mock.calls.map(
            (c) => c[0] as Record<string, unknown>
        );
        // Recipient: their pk, stealth activated, encrypted to their viewing key.
        expect(recipientCall).toMatchObject({
            value: 30n,
            ownerPk: 99n,
            recipientOwnerPk: 99n,
            // The spent note's one-time pk — never the wallet's own identity.
            sourcePk: 0xbeefn,
        });
        expect(recipientCall!['viewingPublicKey']).toBe(ivk);

        // Change: sender's real pair (no stealth), reopenable under the viewing
        // key derived from the INPUT's spending key, and the counterparty is the
        // recipient's ONE-TIME key — never their stable global identifier.
        expect(changeCall).toMatchObject({
            value: 20n,
            // Change goes back to the SPENT note's owner, so a stealth-received
            // input keeps its one-time key here too.
            ownerPk: 0xbeefn,
            spendingKey: SPENDING_KEY,
            sourcePk: builtNote(99n, 30n).ownerPk,
        });
        expect(changeCall!['viewingPublicKey']).toEqual(SENDER_IVK);
        expect('recipientOwnerPk' in changeCall!).toBe(false);
    });

    // ── sourcePk must never carry a stable identity ──────────────────────────
    //
    // `sourcePk` is documented as "ALWAYS a one-time stealth key, never a stable
    // identity". The code used to stamp the spent note's `ownerPk`
    // unconditionally, relying on that note having arrived by stealth — which a
    // SHIELD note never does: a shield is self-addressed with no stealth
    // derivation, so its ownerPk IS the wallet's global pk. Spending a shield
    // therefore handed the recipient a stable identifier for the sender, on the
    // shield→transfer path every new user takes for their first payment.

    it('does NOT stamp the sender global pk when spending a self-owned (shield) note', async () => {
        const ivk = new Uint8Array(32).fill(3);
        // The wallet knows its own identity, and the input note is owned by it —
        // exactly the shape a shield produces.
        const deps = makeDeps({ selfOwnerPk: OWNER_PK } as Partial<TransferDeps>);

        await transferNotes(asDeps(deps), {
            inputNotes: [makeNote(50n)],
            transferAmount: 30n,
            recipientPk: 99n,
            recipientViewingPublicKey: ivk,
        });

        const [recipientCall] = deps.buildNote.mock.calls.map(
            (c) => c[0] as Record<string, unknown>
        );
        expect(recipientCall!['sourcePk']).not.toBe(OWNER_PK);
        // Zero is what a shield/unshield note already carries — the recipient
        // reads it as "no counterparty" rather than as a wrong identity.
        expect(recipientCall!['sourcePk']).toBe(0n);
    });

    it('still stamps the spent pk when it is genuinely one-time (stealth-received note)', async () => {
        const ivk = new Uint8Array(32).fill(3);
        // Wallet identity differs from the note's owner: the note arrived by
        // stealth, so its ownerPk is a per-transfer key and safe to stamp.
        const deps = makeDeps({ selfOwnerPk: 12345n } as Partial<TransferDeps>);

        await transferNotes(asDeps(deps), {
            inputNotes: [makeNote(50n)],
            transferAmount: 30n,
            recipientPk: 99n,
            recipientViewingPublicKey: ivk,
        });

        const [recipientCall] = deps.buildNote.mock.calls.map(
            (c) => c[0] as Record<string, unknown>
        );
        expect(recipientCall!['sourcePk']).toBe(OWNER_PK);
    });

    it('fails CLOSED when the wallet identity is unknown (cannot prove one-time)', async () => {
        const ivk = new Uint8Array(32).fill(3);
        // selfOwnerPk null → no way to tell whether the spent note is ours.
        // Withhold rather than stamp: defaulting to "stamp" would leak exactly
        // when the wallet knows least about itself.
        const deps = makeDeps({ selfOwnerPk: null } as Partial<TransferDeps>);

        await transferNotes(asDeps(deps), {
            inputNotes: [makeNote(50n)],
            transferAmount: 30n,
            recipientPk: 99n,
            recipientViewingPublicKey: ivk,
        });

        const [recipientCall] = deps.buildNote.mock.calls.map(
            (c) => c[0] as Record<string, unknown>
        );
        expect(recipientCall!['sourcePk']).toBe(0n);
    });

    it('withholds when EITHER input is self-owned, whatever the input order', async () => {
        const ivk = new Uint8Array(32).fill(3);
        // A stealth-received note (one-time owner) paired with a self-owned
        // shield. The sender picks the order, so the outcome must not depend on
        // which note lands in slot 0.
        const stealthNote = { ...makeNote(30n), ownerPk: 777n } as ZkNote;
        const shieldNote = makeNote(30n); // ownerPk === OWNER_PK (self)

        for (const inputs of [
            [stealthNote, shieldNote],
            [shieldNote, stealthNote],
        ] as Array<[ZkNote, ZkNote]>) {
            const deps = makeDeps({ selfOwnerPk: OWNER_PK } as Partial<TransferDeps>);

            await transferNotes(asDeps(deps), {
                inputNotes: inputs,
                transferAmount: 30n,
                recipientPk: 99n,
                recipientViewingPublicKey: ivk,
            });

            const [recipientCall] = deps.buildNote.mock.calls.map(
                (c) => c[0] as Record<string, unknown>
            );
            expect(recipientCall!['sourcePk']).toBe(0n);
        }
    });

    it('keeps recording the payee on the CHANGE note — it is ours and history needs it', async () => {
        // Asymmetry with the recipient note, deliberately: the change is sealed
        // to our own viewing key, `NoteDisclosure` does not carry `sourcePk`,
        // and `reconstruct.ts` reads exactly this field to name the payee when
        // the sealed memo is unreadable to us. Blanking it breaks that recovery.
        const deps = makeDeps({ selfOwnerPk: OWNER_PK } as Partial<TransferDeps>);

        await transferNotes(asDeps(deps), {
            inputNotes: [makeNote(50n)],
            transferAmount: 30n,
            recipientPk: 99n,
            // no recipient viewing key — the payee pk is global here, and the
            // change still records it: nobody else can read this note.
        });

        const [, changeCall] = deps.buildNote.mock.calls.map(
            (c) => c[0] as Record<string, unknown>
        );
        expect(changeCall!['sourcePk']).toBe(builtNote(99n, 30n).ownerPk);
        expect(changeCall!['sourcePk']).not.toBe(0n);
    });

    it('returns a payment slip for a transfer to another user (real recipient ivk)', async () => {
        const deps = makeDeps();
        // A real BJJ viewing public key so the slip can actually seal.
        const recipientIvk = deriveViewingPublicKey(deriveViewingSecretKey(424242n));

        const result = await transferNotes(asDeps(deps), {
            inputNotes: [makeNote(50n)],
            transferAmount: 30n,
            recipientPk: 99n,
            recipientViewingPublicKey: recipientIvk,
        });

        expect(result.ok).toBe(true);
        expect(result.paymentSlip).toBeDefined();
        expect(result.paymentSlip!.startsWith('orbslip1:')).toBe(true);
    });

    it('omits the payment slip for a self-transfer', async () => {
        const deps = makeDeps({ selfOwnerPk: 99n });
        const recipientIvk = deriveViewingPublicKey(deriveViewingSecretKey(424242n));

        const result = await transferNotes(asDeps(deps), {
            inputNotes: [makeNote(50n)],
            transferAmount: 30n,
            recipientPk: 99n, // == selfOwnerPk → self-transfer
            recipientViewingPublicKey: recipientIvk,
        });

        expect(result.paymentSlip).toBeUndefined();
    });

    it('omits the recipient viewing key when none was given (dummy memo)', async () => {
        const deps = makeDeps();

        await transferNotes(asDeps(deps), {
            inputNotes: [makeNote(50n)],
            transferAmount: 30n,
            recipientPk: 99n,
        });

        const recipientCall = deps.buildNote.mock.calls[0]?.[0] as Record<string, unknown>;
        expect('viewingPublicKey' in recipientCall).toBe(false);
    });

    it('stamps the SPENT note’s pk as sourcePk ONLY when it is one-time', async () => {
        // The privacy invariant, replacing the removed `senderPk` override: what
        // reaches the recipient's memo is the pk of the note being spent — but
        // only when that note arrived by stealth, so the pk is per-transfer. A
        // global identity here would link every payment this sender ever made,
        // and would expose them if the recipient later disclosed the note.
        //
        // This test used to spend a SELF-owned note and assert its pk was
        // stamped, which is exactly the leak: `makeNote` owns its note under
        // OWNER_PK, the wallet's own identity.
        const deps = makeDeps({ selfOwnerPk: OWNER_PK } as Partial<TransferDeps>);
        const stealthInput = { ...makeNote(50n), ownerPk: 0xbeefn } as ZkNote;

        await transferNotes(asDeps(deps), {
            inputNotes: [stealthInput],
            transferAmount: 30n,
            recipientPk: 99n,
        });

        const [recipientCall, changeCall] = deps.buildNote.mock.calls.map(
            (c) => c[0] as Record<string, unknown>
        );
        expect(recipientCall!['sourcePk']).toBe(0xbeefn);
        expect(recipientCall!['sourcePk']).not.toBe(OWNER_PK);
        expect(changeCall!['ownerPk']).toBe(stealthInput.ownerPk);
    });

    it('a stealth-received input carries ITS one-time pk into the next transfer', async () => {
        // Spending a note that arrived by stealth: its ownerPk is that transfer's
        // one-time key, so that is what the next recipient sees. Nothing links
        // the two payments back to a single identity.
        // `selfOwnerPk` is supplied because the rule fails closed without it —
        // proving the key is one-time requires knowing which key is ours.
        const stealthInput = { ...makeNote(50n), ownerPk: 0xbeefn } as ZkNote;
        const deps = makeDeps({ selfOwnerPk: OWNER_PK } as Partial<TransferDeps>);

        await transferNotes(asDeps(deps), {
            inputNotes: [stealthInput],
            transferAmount: 30n,
            recipientPk: 99n,
        });

        const recipientCall = deps.buildNote.mock.calls[0]?.[0] as Record<string, unknown>;
        expect(recipientCall['sourcePk']).toBe(0xbeefn);
        // Never the wallet's global identity.
        expect(recipientCall['sourcePk']).not.toBe(OWNER_PK);
    });
});

describe('transferNotes — proving and submit', () => {
    it('resolves the transfer circuit for noteA version and forwards fee', async () => {
        const deps = makeDeps();

        await transferNotes(asDeps(deps), {
            inputNotes: [makeNote(50n)],
            transferAmount: 30n,
            recipientPk: 99n,
            fee: 5n,
        });

        expect(deps.resolver.resolve).toHaveBeenCalledWith('transfer', 1);
        const input = mocks.generateTransferProof.mock.calls[0]?.[0] as { fee: bigint };
        expect(input.fee).toBe(5n);
        const request = deps.submit.mock.calls[0]?.[0] as { fee: bigint; circuitVersion: number };
        expect(request.fee).toBe(5n);
        expect(request.circuitVersion).toBe(1);
    });

    it('fee defaults to zero', async () => {
        const deps = makeDeps();

        await transferNotes(asDeps(deps), {
            inputNotes: [makeNote(50n)],
            transferAmount: 30n,
            recipientPk: 99n,
        });

        expect((mocks.generateTransferProof.mock.calls[0]?.[0] as { fee: bigint }).fee).toBe(0n);
    });

    it('zero-pads the second input slot on a single-note transfer', async () => {
        const deps = makeDeps();

        await transferNotes(asDeps(deps), {
            inputNotes: [makeNote(50n)],
            transferAmount: 30n,
            recipientPk: 99n,
        });

        const request = deps.submit.mock.calls[0]?.[0] as {
            inputs: Array<{ nullifier: number[]; commitment: number[] }>;
        };
        expect(request.inputs[1]!.nullifier).toEqual(new Array(32).fill(0));
        expect(request.inputs[1]!.commitment).toEqual(new Array(32).fill(0));
    });

    it('reports the steps in order', async () => {
        const steps: string[] = [];

        await transferNotes(
            asDeps(makeDeps()),
            { inputNotes: [makeNote(50n)], transferAmount: 30n, recipientPk: 99n },
            (s) => steps.push(s)
        );

        expect(steps).toEqual([
            'checking-nullifiers',
            'fetching-merkle-proofs',
            'building-output-notes',
            'generating-zk',
            'submitting',
        ]);
    });
});

describe('transferNotes — persistence', () => {
    it('saves the change note stamped with the tx hash on success', async () => {
        const deps = makeDeps({ txKind: 'evm' });

        await transferNotes(asDeps(deps), {
            inputNotes: [makeNote(50n)],
            transferAmount: 30n, // change 20
            recipientPk: 99n,
        });

        const saved = deps.vault.save.mock.calls[0]?.[0] as Record<string, unknown>;
        expect(saved['value']).toBe(20n);
        expect(saved['createdTxHash']).toBe('0xtx');
        expect(saved['txKind']).toBe('evm');
        // Stamped at creation, so the UI never has to infer it from sourcePk.
        expect(saved['origin']).toBe('transfer-change');
    });

    it('saves no change note on an exact-amount transfer', async () => {
        const deps = makeDeps();

        await transferNotes(asDeps(deps), {
            inputNotes: [makeNote(50n)],
            transferAmount: 50n, // change 0
            recipientPk: 99n,
        });

        expect(deps.vault.save).not.toHaveBeenCalled();
    });

    it('saves nothing when the submit failed', async () => {
        const deps = makeDeps();
        deps.submit.mockResolvedValue({
            ok: false,
            txHash: '',
            blockHash: '0x',
            blockNumber: 0,
            error: 'x',
        });

        await transferNotes(asDeps(deps), {
            inputNotes: [makeNote(50n)],
            transferAmount: 30n,
            recipientPk: 99n,
        });

        expect(deps.vault.save).not.toHaveBeenCalled();
    });
});

describe('transferNotes — self-transfer recovery', () => {
    it('recovers and saves the recipient output when it is addressed to us', async () => {
        const deps = makeDeps({ selfOwnerPk: 99n });
        const recovered = { commitmentHex: '0xrec', spendingKey: 4242n } as unknown as ZkNote;
        deps.recoverStealth.mockReturnValue(recovered);

        await transferNotes(asDeps(deps), {
            inputNotes: [makeNote(50n)],
            transferAmount: 50n, // no change — isolates the self-save
            recipientPk: 99n,
        });

        // The RECOVERED note lands, not the builder output.
        expect(deps.recoverStealth).toHaveBeenCalledWith(builtNote(99n, 50n));
        const saved = deps.vault.save.mock.calls[0]?.[0] as Record<string, unknown>;
        expect(saved['spendingKey']).toBe(4242n);
    });

    it('does not attempt recovery for a foreign recipient', async () => {
        const deps = makeDeps({ selfOwnerPk: 55n });

        await transferNotes(asDeps(deps), {
            inputNotes: [makeNote(50n)],
            transferAmount: 50n,
            recipientPk: 99n,
        });

        expect(deps.recoverStealth).not.toHaveBeenCalled();
    });

    it('does not attempt recovery when no identity is loaded', async () => {
        const deps = makeDeps({ selfOwnerPk: null });

        await transferNotes(asDeps(deps), {
            inputNotes: [makeNote(50n)],
            transferAmount: 50n,
            recipientPk: 99n,
        });

        expect(deps.recoverStealth).not.toHaveBeenCalled();
    });

    it('saves nothing when the self memo does not open', async () => {
        const deps = makeDeps({ selfOwnerPk: 99n });
        deps.recoverStealth.mockReturnValue(null);

        await transferNotes(asDeps(deps), {
            inputNotes: [makeNote(50n)],
            transferAmount: 50n,
            recipientPk: 99n,
        });

        expect(deps.vault.save).not.toHaveBeenCalled();
    });
});

/**
 * Inputs are gone the moment the chain accepts the transfer, and the vault has
 * to learn that from the operation itself.
 *
 * Waiting for a rescan is not a degraded-but-acceptable state: until the input
 * is marked it still counts toward the balance AND coin selection keeps
 * offering it, so the user sees money that no longer exists and the next spend
 * dies on a duplicate nullifier.
 */
describe('transferNotes — inputs are marked spent on success', () => {
    it('SECURITY: marks the single input after a successful transfer', async () => {
        const deps = makeDeps();
        const noteA = makeNote(50n);

        const result = await transferNotes(asDeps(deps), {
            inputNotes: [noteA],
            transferAmount: 10n,
            recipientPk: 99n,
        });

        expect(result.ok).toBe(true);
        expect(deps.vault.markSpent).toHaveBeenCalledWith(
            noteA.commitmentHex,
            expect.any(Number),
            expect.objectContaining({ txHash: '0xtx' })
        );
    });

    it('SECURITY: marks BOTH inputs of a two-note transfer', async () => {
        // A pair spend that only marked one would leave half the money looking
        // available.
        const deps = makeDeps();
        const noteA = makeNote(50n);
        const noteB = makeNote(30n, 8n);

        await transferNotes(asDeps(deps), {
            inputNotes: [noteA, noteB],
            transferAmount: 60n,
            recipientPk: 99n,
        });

        const marked = deps.vault.markSpent.mock.calls.map((c) => c[0]);
        expect(marked).toEqual([noteA.commitmentHex, noteB.commitmentHex]);
    });

    it('stamps the spending tx hash, so the note links to an explorer', async () => {
        const deps = makeDeps();

        await transferNotes(asDeps(deps), {
            inputNotes: [makeNote(50n)],
            transferAmount: 10n,
            recipientPk: 99n,
        });

        expect(deps.vault.markSpent.mock.calls[0]?.[2]).toMatchObject({
            txHash: '0xtx',
            txKind: 'substrate',
        });
    });

    it('does not mark anything when the submit fails', async () => {
        // The inputs are still spendable — marking them would strand the funds
        // until a rescan un-marked them.
        const deps = makeDeps({
            submit: vi.fn().mockResolvedValue({
                ok: false,
                error: 'rejected',
                txHash: '',
                blockHash: '0x',
                blockNumber: 0,
            }),
        });

        await transferNotes(asDeps(deps), {
            inputNotes: [makeNote(50n)],
            transferAmount: 10n,
            recipientPk: 99n,
        });

        expect(deps.vault.markSpent).not.toHaveBeenCalled();
    });
});
