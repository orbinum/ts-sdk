/**
 * unshieldNote — full and partial withdrawal.
 *
 * The stealth-change tests are the ones with money on them: the change note
 * must be built under the wallet's GLOBAL spending key with stealth activated,
 * and what lands in the vault must be the RECOVERED note — persisting the
 * builder's raw output stores something no spend path accepts.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => ({ generateUnshieldProof: vi.fn() }));
vi.mock('../../../../src/protocol/proving/unshield', async (importOriginal) => ({
    ...(await importOriginal<typeof import('../../../../src/protocol/proving/unshield')>()),
    generateUnshieldProof: mocks.generateUnshieldProof,
}));

import { unshieldNote } from '../../../../src/wallet/ops/spend/unshield';
import type { UnshieldDeps } from '../../../../src/wallet/ops/spend/unshield';
import { computeNoteCommitment } from '../../../../src/protocol/note/NoteDecryptor';
import { deriveOwnerPk } from '../../../../src/protocol/keys/PrivacyKeys';
import { toHex } from '../../../../src/foundation/encoding/hex';
import { bigintTo32LeArr } from '../../../../src/foundation/encoding/bytes';
import type { ZkNote } from '../../../../src/protocol/types';

const SPENDING_KEY = 12345678901234567890n;
const GLOBAL = { spendingKey: 777n, ownerPk: 55n };
/** Substrate address so addressToAccountIdHex resolves for real. */
const RECIPIENT = '5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY';

/** A note whose stored fields still produce its commitment — spendable. */
function makeNote(value = 50n): ZkNote {
    const assetId = 1n;
    const blinding = 9n;
    const commitment = computeNoteCommitment(value, assetId, deriveOwnerPk(SPENDING_KEY), blinding);
    return {
        value,
        assetId,
        ownerPk: deriveOwnerPk(SPENDING_KEY),
        blinding,
        spendingKey: SPENDING_KEY,
        commitment,
        nullifier: 111n,
        commitmentHex: toHex(new Uint8Array(bigintTo32LeArr(commitment))),
        nullifierHex: '0x' + '22'.repeat(32),
        memo: [],
        sourcePk: 0n,
        circuitVersion: 1,
        spent: false,
        spentAt: null,
    } as ZkNote;
}

const CHANGE_NOTE = {
    value: 20n,
    assetId: 1n,
    ownerPk: 99n, // stealthOwnerPk
    blinding: 7n,
    spendingKey: 777n,
    commitmentHex: '0x999',
    nullifierHex: '0x111',
    memo: [5, 6, 7],
} as unknown as ZkNote;

function makeDeps(over: Partial<UnshieldDeps> = {}) {
    const base = {
        privacy: {
            getNullifierStatus: vi.fn().mockResolvedValue({ isSpent: false }),
            getMerkleProofByCommitment: vi
                .fn()
                .mockResolvedValue({ root: '0x' + 'aa'.repeat(32), path: ['0xbb'], leafIndex: 3 }),
        },
        resolver: { resolve: vi.fn().mockResolvedValue({ provider: { tag: 'p' }, version: 1 }) },
        buildNote: vi.fn().mockResolvedValue({ note: CHANGE_NOTE }),
        vault: {
            markSpent: vi.fn().mockResolvedValue(undefined),
            save: vi.fn().mockResolvedValue(undefined),
        },
        recoverStealth: vi.fn().mockReturnValue(null),
        submit: vi
            .fn()
            .mockResolvedValue({ ok: true, txHash: '0xtx', blockHash: '0xb', blockNumber: 1 }),
        stealthKeys: GLOBAL,
    };
    return Object.assign(base, over);
}

const asDeps = (d: ReturnType<typeof makeDeps>) => d as unknown as UnshieldDeps;

describe('unshieldNote — guards', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.generateUnshieldProof.mockResolvedValue({
            proof: '0xdeadbeef',
            publicSignals: [],
            changeCommitment: 0n,
            changeValue: 0n,
        });
    });

    it('rejects a note whose recomputed commitment does not match on-chain', async () => {
        const deps = makeDeps();
        const bad = { ...makeNote(), blinding: 1n } as ZkNote;

        const result = await unshieldNote(asDeps(deps), {
            note: bad,
            recipientAddress: RECIPIENT,
            fee: 0n,
        });

        expect(result.ok).toBe(false);
        expect(result.error).toContain('on-chain commitment');
        expect(deps.privacy.getNullifierStatus).not.toHaveBeenCalled();
    });

    it('fails when the derived amount is zero', async () => {
        const result = await unshieldNote(asDeps(makeDeps()), {
            note: makeNote(50n),
            recipientAddress: RECIPIENT,
            fee: 50n, // note.value - fee = 0
        });

        expect(result.ok).toBe(false);
        expect(result.error).toContain('greater than zero');
    });

    it('fails when amount + fee exceeds the note value', async () => {
        const result = await unshieldNote(asDeps(makeDeps()), {
            note: makeNote(50n),
            recipientAddress: RECIPIENT,
            amount: 45n,
            fee: 10n,
        });

        expect(result.ok).toBe(false);
        expect(result.error).toContain('exceeds note value');
    });

    it('fails early on an already-spent nullifier and reconciles the vault', async () => {
        const deps = makeDeps();
        deps.privacy.getNullifierStatus.mockResolvedValue({ isSpent: true });

        const result = await unshieldNote(asDeps(deps), {
            note: makeNote(),
            recipientAddress: RECIPIENT,
            amount: 10n,
            fee: 0n,
        });

        expect(result.ok).toBe(false);
        // The pallet's wording, so the caller's already-spent classifier fires.
        expect(result.error).toContain('NullifierAlreadySpent');
        expect(deps.vault.markSpent).toHaveBeenCalledWith(makeNote().commitmentHex);
        expect(mocks.generateUnshieldProof).not.toHaveBeenCalled();
    });

    it('rejects an unresolvable recipient before touching the chain', async () => {
        const deps = makeDeps();

        const result = await unshieldNote(asDeps(deps), {
            note: makeNote(),
            recipientAddress: 'not-an-address',
            amount: 10n,
            fee: 0n,
        });

        expect(result.ok).toBe(false);
        expect(result.error).toContain('Invalid recipient');
        expect(deps.privacy.getNullifierStatus).not.toHaveBeenCalled();
    });
});

describe('unshieldNote — full withdrawal', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.generateUnshieldProof.mockResolvedValue({
            proof: '0xdeadbeef',
            publicSignals: [],
            changeCommitment: 0n,
            changeValue: 0n,
        });
    });

    it('proves with the note fields and the fetched merkle proof', async () => {
        const deps = makeDeps();
        const note = makeNote(50n);

        const result = await unshieldNote(asDeps(deps), {
            note,
            recipientAddress: RECIPIENT,
            fee: 5n,
        });

        expect(result.ok).toBe(true);
        const input = mocks.generateUnshieldProof.mock.calls[0]?.[0] as Record<string, unknown>;
        expect(input['amount']).toBe(45n); // full: value - fee
        expect(input['spendingKey']).toBe(SPENDING_KEY);
        expect(input['leafIndex']).toBe(3);
        expect('changeValue' in input).toBe(false); // no change output
        expect(deps.buildNote).not.toHaveBeenCalled();
    });

    it('reports the steps in order', async () => {
        const steps: string[] = [];

        await unshieldNote(
            asDeps(makeDeps()),
            { note: makeNote(), recipientAddress: RECIPIENT, amount: 10n, fee: 0n },
            (s) => steps.push(s)
        );

        expect(steps).toEqual([
            'checking-nullifier',
            'fetching-proof',
            'generating-zk',
            'submitting',
        ]);
    });

    it('zero-pads the change commitment when there is no change', async () => {
        const deps = makeDeps();

        await unshieldNote(asDeps(deps), {
            note: makeNote(),
            recipientAddress: RECIPIENT,
            fee: 0n,
        });

        const request = deps.submit.mock.calls[0]?.[0] as { changeCommitment: number[] };
        expect(request.changeCommitment).toEqual(new Array(32).fill(0));
    });
});

describe('unshieldNote — stealth change', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.generateUnshieldProof.mockResolvedValue({
            proof: '0xdeadbeef',
            publicSignals: [],
            changeCommitment: 111n,
            changeValue: 20n,
        });
    });

    const partial = (deps: ReturnType<typeof makeDeps>) =>
        unshieldNote(asDeps(deps), {
            note: makeNote(50n),
            recipientAddress: RECIPIENT,
            amount: 30n, // change = 20
            fee: 0n,
        });

    it('builds the change under the GLOBAL spending key with stealth activated', async () => {
        const deps = makeDeps();

        await partial(deps);

        const call = deps.buildNote.mock.calls[0]?.[0] as Record<string, unknown>;
        // The global key, never the input note's: the builder derives the
        // one-time stealth key from it via the memo's ephemeral.
        expect(call['spendingKey']).toBe(GLOBAL.spendingKey);
        expect(call['ownerPk']).toBe(GLOBAL.ownerPk);
        expect(call['recipientOwnerPk']).toBe(GLOBAL.ownerPk); // stealth on
        expect(call['value']).toBe(20n);
    });

    it('submits the builder memo verbatim and the prover commitment as authoritative', async () => {
        const deps = makeDeps();

        await partial(deps);

        const request = deps.submit.mock.calls[0]?.[0] as {
            changeEncryptedMemo?: number[];
            changeCommitment: number[];
        };
        // The memo shares its ephemeral with the stealth-key derivation; a
        // regenerated memo would make the change note unspendable.
        expect(request.changeEncryptedMemo).toEqual(CHANGE_NOTE.memo);
        expect(request.changeCommitment).toEqual(Array.from(bigintTo32LeArr(111n)));
    });

    it('persists the RECOVERED note, never the builder output', async () => {
        const deps = makeDeps();
        const recovered = { ...CHANGE_NOTE, spendingKey: 424242n };
        deps.recoverStealth.mockReturnValue(recovered);

        await partial(deps);

        expect(deps.recoverStealth).toHaveBeenCalledWith(CHANGE_NOTE);
        const saved = deps.vault.save.mock.calls[0]?.[0] as Record<string, unknown>;
        expect(saved['spendingKey']).toBe(424242n);
        expect(saved['createdTxHash']).toBe('0xtx');
    });

    it('persists nothing when the memo does not open with our keys', async () => {
        // Storing the built note would put an unspendable one in the vault; the
        // rescan recovers it from the on-chain memo instead.
        const deps = makeDeps();
        deps.recoverStealth.mockReturnValue(null);

        await partial(deps);

        expect(deps.vault.save).not.toHaveBeenCalled();
    });

    it('persists nothing when the submit failed', async () => {
        const deps = makeDeps();
        deps.recoverStealth.mockReturnValue(CHANGE_NOTE);
        deps.submit.mockResolvedValue({
            ok: false,
            txHash: '',
            blockHash: '0x',
            blockNumber: 0,
            error: 'x',
        });

        await partial(deps);

        expect(deps.vault.save).not.toHaveBeenCalled();
    });
});

/**
 * The withdrawn note is gone the moment the chain accepts the unshield, and the
 * vault has to learn that from the operation.
 *
 * Leaving it to a rescan means the note still counts toward the balance and
 * stays selectable, so the user sees funds that no longer exist and the next
 * spend dies on a duplicate nullifier.
 */
describe('unshieldNote — the input is marked spent on success', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.generateUnshieldProof.mockResolvedValue({
            proof: '0xdead',
            changeCommitment: 0n,
        });
    });

    it('SECURITY: marks the withdrawn note after a successful unshield', async () => {
        const deps = makeDeps();
        const note = makeNote();

        const result = await unshieldNote(asDeps(deps), {
            note,
            recipientAddress: RECIPIENT,
            amount: 40n,
            fee: 0n,
        });

        expect(result.ok).toBe(true);
        expect(deps.vault.markSpent).toHaveBeenCalledWith(
            note.commitmentHex,
            expect.any(Number),
            expect.objectContaining({ txHash: '0xtx' })
        );
    });

    it('does not mark it when the submit fails', async () => {
        // The note is still spendable; marking it would strand the funds.
        const deps = makeDeps({
            submit: vi.fn().mockResolvedValue({
                ok: false,
                error: 'rejected',
                txHash: '',
                blockHash: '0x',
                blockNumber: 0,
            }),
        });

        await unshieldNote(asDeps(deps), {
            note: makeNote(),
            recipientAddress: RECIPIENT,
            amount: 40n,
            fee: 0n,
        });

        expect(deps.vault.markSpent).not.toHaveBeenCalled();
    });
});
