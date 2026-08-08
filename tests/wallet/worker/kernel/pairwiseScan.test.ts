/**
 * Pairwise discovery inside the scan kernel — with real crypto, not mocks.
 *
 * The mechanism only pays off if a known sender's note is recognized by the
 * precomputed window and never reaches the ECDH. Mocking the SDK would prove
 * the plumbing routes correctly while saying nothing about whether the sender's
 * published ephemeral and the receiver's window actually agree — which is the
 * only thing that can break.
 *
 * So these run the real derivations end to end: notes are encrypted exactly as
 * a sender would encrypt them, the kernel scans, and the assertions distinguish
 * "found" from "found the fast way". A note counted as found but matched by
 * trial decryption means the mechanism silently did nothing.
 */
import { describe, it, expect } from 'vitest';
import {
    EncryptedMemo,
    computeNoteCommitment,
    derivePairwiseSharedSecret,
    derivePairwiseEphSk,
    deriveViewingSecretKey,
    deriveViewingPublicKey,
    deriveOwnerPk,
    toHex,
    bigintTo32Le,
} from '../../../../src/index';
import { decryptHintBatch, type ScanKeys } from '../../../../src/index';

/** A party: spending key plus everything derived from it. */
function party(spendingKey: bigint) {
    const viewingSecretKey = deriveViewingSecretKey(spendingKey);
    return {
        spendingKey,
        viewingSecretKey,
        viewingPublicKey: deriveViewingPublicKey(viewingSecretKey),
        ownerPk: deriveOwnerPk(spendingKey),
    };
}

const wallet = party(111222333444555666777n);
const sender = party(999888777666555444333n);
const stranger = party(555555555555555555555n);

/** The secret the sender and this wallet both derive. */
const pairSecret = derivePairwiseSharedSecret(sender.viewingSecretKey, wallet.viewingPublicKey);

/** Base keys with every fast path off — the slow scan, as a control. */
const baseKeys = (): ScanKeys => ({
    viewingKey: wallet.viewingSecretKey,
    spendingKey: wallet.spendingKey,
    ownerPk: wallet.ownerPk,
});

type Hint = { commitmentHex: string; leafIndex: number; encryptedMemo: string };

/**
 * One note addressed to `wallet`. With `pairIndex` set the sender uses the
 * pairwise ephemeral both sides can derive; without it, a plain one — which is
 * what a stranger's payment looks like.
 */
function noteFor(leafIndex: number, value: bigint, pairIndex?: number): Hint {
    const blinding = BigInt(leafIndex) * 7919n + 13n;
    const commitment = computeNoteCommitment(value, 0n, wallet.ownerPk, blinding);
    const memo = EncryptedMemo.encrypt(
        value,
        bigintTo32Le(wallet.ownerPk),
        bigintTo32Le(blinding),
        0,
        bigintTo32Le(commitment),
        wallet.viewingPublicKey,
        bigintTo32Le(sender.ownerPk),
        1,
        pairIndex === undefined ? undefined : derivePairwiseEphSk(pairSecret, pairIndex)
    );
    return {
        commitmentHex: toHex(bigintTo32Le(commitment)),
        leafIndex,
        encryptedMemo: toHex(memo),
    };
}

/** A note for somebody else — the ~99.6% case the scan spends its time rejecting. */
function foreignNote(leafIndex: number): Hint {
    const value = BigInt(leafIndex) + 1n;
    const blinding = BigInt(leafIndex) * 104729n + 7n;
    const commitment = computeNoteCommitment(value, 0n, stranger.ownerPk, blinding);
    const memo = EncryptedMemo.encrypt(
        value,
        bigintTo32Le(stranger.ownerPk),
        bigintTo32Le(blinding),
        0,
        bigintTo32Le(commitment),
        stranger.viewingPublicKey
    );
    return {
        commitmentHex: toHex(bigintTo32Le(commitment)),
        leafIndex,
        encryptedMemo: toHex(memo),
    };
}

/** A pool of `size` hints with `pairwise` notes from the known sender in it. */
function pool(size: number, pairwise: number): Hint[] {
    const stride = Math.max(1, Math.floor(size / Math.max(pairwise, 1)));
    const planted = new Map<number, number>();
    for (let i = 0; i < pairwise; i++) planted.set(Math.min(size - 1, i * stride), i);

    return Array.from({ length: size }, (_, leaf) => {
        const pairIndex = planted.get(leaf);
        return pairIndex === undefined
            ? foreignNote(leaf)
            : noteFor(leaf, 100n + BigInt(leaf), pairIndex);
    });
}

describe('pairwise discovery', () => {
    it('finds a known sender’s notes through the window, with no trial decryption', () => {
        const hints = pool(40, 4);

        const result = decryptHintBatch(hints, {
            ...baseKeys(),
            pairwiseCounterparties: [sender.viewingPublicKey],
            pairwiseWindowSize: 16,
        });

        expect(result.pairwiseMatched).toBe(4);
        expect(result.notes.filter(Boolean)).toHaveLength(4);
        // Never confused with self notes: the counters feed different windows and
        // only the self one advances the vault's published-ephemeral counter.
        expect(result.selfMatched).toBe(0);
        expect(result.maxSelfEphIndex).toBeNull();
    });

    // The wire format is unchanged, so the notes must still be recoverable by a
    // wallet that knows nothing about pairwise keys — just slowly.
    it('finds the same notes without the window, by full trial decryption', () => {
        const result = decryptHintBatch(pool(40, 4), baseKeys());

        expect(result.notes.filter(Boolean)).toHaveLength(4);
        expect(result.pairwiseMatched).toBe(0);
    });

    it('ignores an unrelated counterparty', () => {
        const result = decryptHintBatch(pool(40, 4), {
            ...baseKeys(),
            pairwiseCounterparties: [stranger.viewingPublicKey],
            pairwiseWindowSize: 16,
        });

        // Registering the wrong sender buys nothing, but must not lose the notes:
        // they fall back to the slow path and are still recovered.
        expect(result.pairwiseMatched).toBe(0);
        expect(result.notes.filter(Boolean)).toHaveLength(4);
    });

    // The window is a gap limit, not a bound on correctness: a sender who outruns
    // it keeps being discovered the slow way until the counter catches up.
    it('falls back to trial decryption past the end of the window', () => {
        const result = decryptHintBatch(pool(40, 6), {
            ...baseKeys(),
            pairwiseCounterparties: [sender.viewingPublicKey],
            pairwiseWindowSize: 2,
        });

        expect(result.pairwiseMatched).toBe(2);
        expect(result.notes.filter(Boolean)).toHaveLength(6);
    });

    // The window is cached across batches; keying it on the key set alone would
    // serve a stale window forever after the wallet learns a new sender.
    it('rebuilds the window when a counterparty is added', () => {
        const hints = pool(40, 4);
        const keys = baseKeys();

        const before = decryptHintBatch(hints, keys);
        const after = decryptHintBatch(hints, {
            ...keys,
            pairwiseCounterparties: [sender.viewingPublicKey],
            pairwiseWindowSize: 16,
        });

        expect(before.pairwiseMatched).toBe(0);
        expect(after.pairwiseMatched).toBe(4);
    });
});
