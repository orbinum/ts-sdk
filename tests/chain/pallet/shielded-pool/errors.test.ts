/**
 * Pallet-error classification. The classifiers drive automatic recovery — a
 * resync on already-spent, a purge on ghost note — so a misclassification
 * either skips a needed repair or destroys a live note.
 */
import { describe, it, expect } from 'vitest';
import {
    extractPalletError,
    isAlreadySpentError,
    isGhostNoteError,
    palletErrorKind,
    classifyChainError,
    KNOWN_PALLET_ERRORS,
} from '../../../../src/chain/pallet/shielded-pool/errors';

describe('extractPalletError', () => {
    it('reads the variant out of a Substrate error', () => {
        expect(extractPalletError('… message: Some("NullifierAlreadyUsed") …')).toBe(
            'NullifierAlreadyUsed'
        );
    });

    it('reads the backslash-escaped form the EVM path nests in eth_call', () => {
        expect(extractPalletError('execution reverted: message: Some(\\"InvalidAmount\\")')).toBe(
            'InvalidAmount'
        );
    });

    it('returns null when no pallet error is present', () => {
        expect(extractPalletError('network timeout')).toBeNull();
    });
});

describe('isAlreadySpentError', () => {
    it('detects the pallet rejection after submit', () => {
        expect(isAlreadySpentError('… message: Some("NullifierAlreadyUsed") …')).toBe(true);
    });

    it('detects the local pre-flight wording', () => {
        // Same condition found before submitting — same resync reaction.
        expect(isAlreadySpentError('message: Some("NullifierAlreadySpent")')).toBe(true);
    });

    it('ignores unrelated errors', () => {
        expect(isAlreadySpentError('… message: Some("InvalidProof") …')).toBe(false);
        expect(isAlreadySpentError('network timeout')).toBe(false);
    });
});

describe('isGhostNoteError', () => {
    it('detects the pallet rejection for a missing commitment', () => {
        expect(isGhostNoteError('… message: Some("CommitmentNotFound") …')).toBe(true);
    });

    it('SECURITY: does NOT flag a stale merkle root as a ghost note', () => {
        // Both are proof-versus-tree failures, which is why they used to be one
        // case — but the reactions are opposite and one destroys funds. A ghost
        // note is gone for good and gets purged; `UnknownMerkleRoot` means the
        // note IS on chain and the proof was built against a tree that has
        // since moved, so a rescan and a fresh proof succeed. Purging on it
        // deletes a live, spendable note.
        expect(isGhostNoteError('… message: Some("UnknownMerkleRoot") …')).toBe(false);
        expect(classifyChainError('… message: Some("UnknownMerkleRoot") …')).toBe('stale-proof');
    });

    it('detects the merkle-proof RPC failing to find a leaf', () => {
        expect(isGhostNoteError('privacy_getMerkleProofByCommitment failed: no leaf')).toBe(true);
    });

    it('never flags an already-spent error as ghost', () => {
        // The reactions differ destructively: ghost → purge the note,
        // already-spent → mark it spent. Crossing them deletes a real note.
        expect(isGhostNoteError('… message: Some("NullifierAlreadyUsed") …')).toBe(false);
    });

    it('ignores unrelated errors', () => {
        expect(isGhostNoteError('network timeout')).toBe(false);
    });
});

/**
 * The taxonomy behind the classifiers.
 *
 * A host renders its own words; what it must NOT have to invent is which
 * failures are retryable, which are terminal, and which mean a note should be
 * deleted. Those three answers decide whether a user loses money, so they are
 * protocol knowledge and asserted here.
 */
describe('palletErrorKind', () => {
    it.each([
        ['NullifierAlreadyUsed', 'already-spent'],
        ['NullifierAlreadySpent', 'already-spent'],
        ['CommitmentNotFound', 'ghost-note'],
        ['UnknownMerkleRoot', 'stale-proof'],
        ['InvalidAmount', 'amount'],
        ['FeeTooLow', 'amount'],
        ['InsufficientPendingFees', 'amount'],
        ['AssetIdAlreadyExists', 'asset'],
        ['FeeRecipientUnavailable', 'shape'],
        ['InvalidProof', 'proof'],
        ['AssetNotVerified', 'asset'],
        ['InvalidMemoSize', 'shape'],
        ['MerkleTreeFull', 'capacity'],
        ['InsufficientBalance', 'balance'],
    ])('classifies %s as %s', (name, kind) => {
        expect(palletErrorKind(name)).toBe(kind);
    });

    it('returns unknown for a name this version does not know', () => {
        // A runtime upgrade can add variants. Reacting to an unrecognised one
        // by guessing is worse than not reacting: the guess could purge a note.
        expect(palletErrorKind('SomeFutureRuntimeError')).toBe('unknown');
    });

    it('keeps the destructive kinds apart', () => {
        // ghost-note purges, already-spent marks spent, stale-proof only
        // rescans. No name may land in more than one.
        const destructive = ['already-spent', 'ghost-note', 'stale-proof'];
        const counts = new Map<string, number>();
        for (const name of KNOWN_PALLET_ERRORS) {
            const kind = palletErrorKind(name);
            if (destructive.includes(kind)) counts.set(name, (counts.get(name) ?? 0) + 1);
        }
        expect([...counts.values()].every((n) => n === 1)).toBe(true);
    });
});

describe('classifyChainError', () => {
    it('reads the name out of a raw substrate error', () => {
        expect(classifyChainError('… message: Some("FeeTooLow") …')).toBe('amount');
    });

    it('reads the name out of the EVM path, where quotes are escaped', () => {
        expect(
            classifyChainError('evm error: Other("… message: Some(\\"InvalidProof\\") …")')
        ).toBe('proof');
    });

    it('falls back to the merkle-proof RPC for a ghost note', () => {
        // The spend never reaches the chain, so there is no pallet name to read
        // — same condition, different messenger.
        expect(classifyChainError('privacy_getMerkleProofByCommitment failed: no leaf')).toBe(
            'ghost-note'
        );
    });

    it('returns unknown for noise rather than guessing', () => {
        expect(classifyChainError('network timeout')).toBe('unknown');
    });
});

describe('KNOWN_PALLET_ERRORS', () => {
    it('lists every classified name, so a host can build a copy table', () => {
        expect(KNOWN_PALLET_ERRORS).toContain('MerkleTreeFull');
        expect(KNOWN_PALLET_ERRORS).toContain('AssetNotVerified');
        expect(KNOWN_PALLET_ERRORS.length).toBeGreaterThanOrEqual(20);
    });

    it("is frozen — a host must not mutate the SDK's vocabulary", () => {
        expect(Object.isFrozen(KNOWN_PALLET_ERRORS)).toBe(true);
    });
});

/**
 * Sincronía con el pallet.
 *
 * `AmountTooSmall` estuvo mapeado aquí meses después de que el runtime lo
 * eliminara, y tres variantes vivas (`InsufficientPendingFees`,
 * `AssetIdAlreadyExists`, `FeeRecipientUnavailable`) nunca llegaron a mapearse:
 * caían en `unknown` y el host perdía la clasificación que decide si un fallo
 * se reintenta o es terminal.
 *
 * Ninguno de los dos desfases rompe nada de golpe — por eso duraron. Este test
 * los convierte en un fallo visible.
 */
describe('el mapa sigue al pallet', () => {
    it('no clasifica nombres que el pallet ya no declara', () => {
        // Eliminado del runtime: `shield` acepta cualquier importe no-cero, y
        // el cero se rechaza con `InvalidAmount`.
        expect(palletErrorKind('AmountTooSmall')).toBe('unknown');
    });

    it('clasifica las variantes de comisiones y activos que el pallet SÍ declara', () => {
        expect(palletErrorKind('InsufficientPendingFees')).toBe('amount');
        expect(palletErrorKind('AssetIdAlreadyExists')).toBe('asset');
        expect(palletErrorKind('FeeRecipientUnavailable')).toBe('shape');
    });
});
