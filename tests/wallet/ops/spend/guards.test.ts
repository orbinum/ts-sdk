/**
 * Pre-flight spend checks.
 *
 * Each of these conditions is already enforced downstream, so the value here is
 * entirely in WHEN it fails and what it says: a drifted note otherwise surfaces
 * as "assert failed" on a Merkle constraint, seconds into proving.
 */
import { describe, it, expect } from 'vitest';
import { noteMatchesCommitment, treeOf, checkSpendableInputs } from '../../../../src/wallet/ops/spend/guards';
import { treeIdOf, LEAVES_PER_TREE } from '../../../../src/index';
import { computeNoteCommitment } from '../../../../src/protocol/note/NoteDecryptor';
import { deriveOwnerPk } from '../../../../src/protocol/keys/PrivacyKeys';
import { toHex } from '../../../../src/foundation/encoding/hex';
import { bigintTo32LeArr } from '../../../../src/foundation/encoding/bytes';
import type { ZkNote } from '../../../../src/protocol/types';
import type { PrivacyMerkleProof } from '../../../../src/index';

const SPENDING_KEY = 12345678901234567890n;

/** A note whose stored commitment matches what the circuit would recompute. */
function consistentNote(overrides: Partial<ZkNote> = {}): ZkNote {
    const value = (overrides.value as bigint) ?? 100n;
    const assetId = (overrides.assetId as bigint) ?? 0n;
    const blinding = (overrides.blinding as bigint) ?? 7n;
    const spendingKey = (overrides.spendingKey as bigint) ?? SPENDING_KEY;
    const commitment = computeNoteCommitment(value, assetId, deriveOwnerPk(spendingKey), blinding);
    return {
        value,
        assetId,
        blinding,
        spendingKey,
        ownerPk: deriveOwnerPk(spendingKey),
        commitmentHex: toHex(new Uint8Array(bigintTo32LeArr(commitment))),
        nullifierHex: '0xn',
        circuitVersion: 1,
        ...overrides,
    } as ZkNote;
}

const proof = (over: Partial<PrivacyMerkleProof> = {}) =>
    ({ leafIndex: 0, ...over }) as PrivacyMerkleProof;

describe('noteMatchesCommitment', () => {
    it('accepts a note whose fields still produce its commitment', () => {
        expect(noteMatchesCommitment(consistentNote())).toBe(true);
    });

    it.each([
        ['value', { value: 999n }],
        ['assetId', { assetId: 3n }],
        ['blinding', { blinding: 8n }],
    ])('rejects a note whose %s drifted from what was committed', (_field, drift) => {
        // The commitment stays as built; only the field moves.
        const note = { ...consistentNote(), ...drift } as ZkNote;

        expect(noteMatchesCommitment(note)).toBe(false);
    });

    it('rejects a note carrying the wrong spending key', () => {
        // The exact case a stealth note hits when stored unrepaired: the circuit
        // rebuilds the commitment from BabyPbk(spendingKey).Ax, not from ownerPk.
        const note = { ...consistentNote(), spendingKey: 999n } as ZkNote;

        expect(noteMatchesCommitment(note)).toBe(false);
    });
});

describe('treeOf', () => {
    it('prefers an explicit treeId', () => {
        expect(treeOf(proof({ treeId: 4, leafIndex: 0 }))).toBe(4);
    });

    it('derives the tree from the leaf index when no treeId is given', () => {
        expect(treeOf(proof({ leafIndex: 2 ** 20 }))).toBe(1);
        expect(treeOf(proof({ leafIndex: 5 }))).toBe(0);
    });

    it('agrees with treeIdOf, which answers the same question for a note', () => {
        // Two implementations of one protocol rule: this one reads a merkle
        // proof, `treeIdOf` reads a note. They must not drift — a guard that
        // computed a different tree would reject same-tree pairs as cross-tree
        // and refuse transfers the chain would have accepted.
        for (const leafIndex of [0, 1, LEAVES_PER_TREE - 1, LEAVES_PER_TREE, 3 * LEAVES_PER_TREE]) {
            expect(treeOf(proof({ leafIndex }))).toBe(treeIdOf({ leafIndex }));
        }
    });

    it.each([
        ['NaN', NaN],
        ['negative', -1],
        ['above u32', 2 ** 32],
        ['fractional', 1.5],
    ])('resolves a %s treeId to tree 0 rather than trusting it', (_label, treeId) => {
        // NaN is the dangerous one: it compares unequal to itself, so an
        // untrusted hint would flag every pair as cross-tree and block valid
        // transfers.
        expect(treeOf(proof({ treeId, leafIndex: 0 }))).toBe(0);
    });
});

describe('checkSpendableInputs', () => {
    it('accepts consistent notes of the same circuit version', () => {
        expect(checkSpendableInputs([consistentNote(), consistentNote({ blinding: 9n })])).toEqual({
            ok: true,
        });
    });

    it('accepts a single note with no second input', () => {
        expect(checkSpendableInputs([consistentNote(), undefined])).toEqual({ ok: true });
    });

    it('names which input drifted', () => {
        const bad = { ...consistentNote(), value: 999n } as ZkNote;

        const result = checkSpendableInputs([consistentNote(), bad]);

        expect(result.ok).toBe(false);
        expect(result.error).toContain('Input note B');
        expect(result.error).toContain('rescan');
    });

    it('rejects inputs of different circuit versions', () => {
        // One proof covers one circuit version; mixing them cannot verify.
        const result = checkSpendableInputs([
            consistentNote({ circuitVersion: 1 }),
            consistentNote({ circuitVersion: 2, blinding: 9n }),
        ]);

        expect(result.ok).toBe(false);
        expect(result.error).toContain('circuit versions');
    });

    it('reports the drifted commitment before the version mismatch', () => {
        // An unspendable note is the more fundamental problem, and its message
        // tells the user what to do about it.
        const bad = { ...consistentNote({ circuitVersion: 2 }), value: 999n } as ZkNote;

        expect(checkSpendableInputs([consistentNote({ circuitVersion: 1 }), bad]).error).toContain(
            'on-chain commitment'
        );
    });
});

/**
 * `checkSpendableInputs` is documented as returning the first problem rather
 * than throwing, and every caller relies on that — `transferNotes` turns its
 * result into a failed `TxResult`. A note with a malformed `commitmentHex`
 * (a corrupt record, a truncated write) used to escape as an unhandled
 * exception from `fromHex`, taking the whole transfer with it instead of
 * naming the note.
 */
describe('malformed input notes never throw', () => {
    const malformed = (commitmentHex: string): ZkNote =>
        ({
            value: 100n,
            assetId: 0n,
            blinding: 42n,
            spendingKey: SPENDING_KEY,
            ownerPk: deriveOwnerPk(SPENDING_KEY),
            counterpartyPk: 0n,
            commitmentHex,
            nullifierHex: '0xn1',
            circuitVersion: 1,
            spent: false,
            spentAt: null,
            commitment: 1n,
            nullifier: 2n,
            memo: [],
        }) as ZkNote;

    it.each([
        ['odd-length hex', '0xb'],
        ['non-hex characters', '0xzzzz'],
        ['empty', ''],
    ])('reports %s as a mismatch instead of raising', (_label, commitmentHex) => {
        expect(() => noteMatchesCommitment(malformed(commitmentHex))).not.toThrow();
        expect(noteMatchesCommitment(malformed(commitmentHex))).toBe(false);
    });

    it('checkSpendableInputs returns a usable error for a malformed note', () => {
        const result = checkSpendableInputs([malformed('0xb')]);

        expect(result.ok).toBe(false);
        expect(result.error).toMatch(/does not match its on-chain commitment/);
    });
});
