/**
 * pairwiseEph — the mechanism only works if one exact thing holds: the ephPk
 * the SENDER publishes in the memo must appear, byte-for-byte, in the window
 * the RECEIVER precomputes. Everything else is detail.
 *
 * That is asserted end-to-end (real encrypt, real window, real decrypt) rather
 * than by comparing derivations to each other, because the failure mode this
 * guards against is a clamp or packing mismatch between the two paths — which
 * matching derivations would not catch.
 */
import { describe, it, expect } from 'vitest';
import {
    derivePairwiseSharedSecret,
    derivePairwiseEphSk,
    pairwiseEphWindow,
} from '../../src/shielded-pool/protocol/pairwiseEph';
import { EncryptedMemo } from '../../src/shielded-pool/protocol/EncryptedMemo';
import {
    tryDecryptNote,
    computeNoteCommitment,
} from '../../src/shielded-pool/protocol/NoteDecryptor';
import { selfEphWindow } from '../../src/shielded-pool/protocol/selfEph';
import {
    deriveViewingSecretKey,
    deriveViewingPublicKey,
    deriveOwnerPk,
} from '../../src/privacy-keys/PrivacyKeys';
import { toHex } from '../../src/utils/hex';
import { bigintTo32Le } from '../../src/utils/bytes';

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

const alice = party(111222333444555666777n);
const bob = party(999888777666555444333n);
const eve = party(555555555555555555555n);

/** The secret from each side's own point of view — these must agree. */
const aliceSecret = derivePairwiseSharedSecret(alice.viewingSecretKey, bob.viewingPublicKey);
const bobSecret = derivePairwiseSharedSecret(bob.viewingSecretKey, alice.viewingPublicKey);

/** The ephPk as it travels on the wire: the memo's last 32 bytes. */
const memoEphPk = (memoHex: string) => ('0x' + memoHex.slice(-64)).toLowerCase();

// A note's commitment is Poseidon4(value, assetId, ownerPk, blinding) and
// decryption recomputes it to reject a memo that does not match — so a test
// note has to carry its real commitment, not a placeholder.
const VALUE = 4200n;
const BLINDING = 987654321n;
const COMMITMENT = bigintTo32Le(computeNoteCommitment(VALUE, 0n, bob.ownerPk, BLINDING));

describe('derivePairwiseSharedSecret', () => {
    // Without this the sender and receiver derive different ephemerals and the
    // window never matches — the mechanism silently degrades to a normal scan.
    it('is symmetric: both parties derive the same secret', () => {
        expect(toHex(aliceSecret)).toBe(toHex(bobSecret));
    });

    it('is 32 bytes', () => {
        expect(aliceSecret).toHaveLength(32);
    });

    it('differs per counterparty', () => {
        const withEve = derivePairwiseSharedSecret(alice.viewingSecretKey, eve.viewingPublicKey);

        expect(toHex(withEve)).not.toBe(toHex(aliceSecret));
    });

    it('rejects a viewing public key that is not a curve point', () => {
        expect(() =>
            derivePairwiseSharedSecret(alice.viewingSecretKey, new Uint8Array(32).fill(0xff))
        ).toThrow(/invalid viewing public key/);
    });
});

describe('derivePairwiseEphSk', () => {
    it('is deterministic', () => {
        expect(derivePairwiseEphSk(aliceSecret, 7)).toEqual(derivePairwiseEphSk(aliceSecret, 7));
    });

    it('advances with the index', () => {
        expect(derivePairwiseEphSk(aliceSecret, 0)).not.toEqual(
            derivePairwiseEphSk(aliceSecret, 1)
        );
    });

    it('is domain-separated from selfEph', () => {
        // Both hash (secret ‖ u32le(i)); only the domain string separates them.
        // A collision would let a self-note and a pairwise note share an ephPk.
        const asPairwise = derivePairwiseEphSk(bigintTo32Le(alice.spendingKey), 0);
        const selfEntry = selfEphWindow(alice.spendingKey, alice.viewingPublicKey, 0, 1)[0]!;

        expect(toHex(asPairwise)).not.toBe(selfEntry.ephPkHex);
    });
});

describe('the sender publishes what the receiver precomputed', () => {
    const INDEX = 3;


    /** Alice pays Bob, choosing the ephemeral their shared secret dictates. */
    function alicePaysBob(index: number, value = VALUE) {
        const memo = EncryptedMemo.encrypt(
            value,
            bigintTo32Le(bob.ownerPk),
            bigintTo32Le(BLINDING),
            0,
            COMMITMENT,
            bob.viewingPublicKey,
            bigintTo32Le(alice.ownerPk),
            1,
            derivePairwiseEphSk(aliceSecret, index)
        );
        return toHex(memo);
    }


    it('the memo ephPk appears in Bob’s window for Alice', () => {
        const memoHex = alicePaysBob(INDEX);
        const window = pairwiseEphWindow(bobSecret, bob.viewingPublicKey, 0, 16);

        const match = window.find((e) => e.ephPkHex.toLowerCase() === memoEphPk(memoHex));

        expect(match).toBeDefined();
        expect(match!.index).toBe(INDEX);
    });

    // The point of the window: opening the note with the precomputed secret,
    // never calling the ECDH the scan pays per hint.
    it('the precomputed secret opens the note with no trial decryption', () => {
        const memoHex = alicePaysBob(INDEX, VALUE);
        const window = pairwiseEphWindow(bobSecret, bob.viewingPublicKey, 0, 16);
        const entry = window[INDEX]!;

        const note = tryDecryptNote(
            // The commitment feeds the memo's key derivation, so decryption must
            // be handed the same bytes the sender encrypted against.
            { commitmentHex: toHex(COMMITMENT), leafIndex: 1, encryptedMemo: memoHex },
            bob.viewingSecretKey,
            bob.spendingKey,
            bob.ownerPk,
            { sharedSecret: entry.sharedSecret }
        );

        expect(note?.value).toBe(VALUE);
    });

    it('the note still opens by ordinary trial decryption', () => {
        // The wire format is unchanged, so a wallet that knows nothing about
        // pairwise keys must still recover the note the slow way.
        const memoHex = alicePaysBob(INDEX, VALUE);

        const note = tryDecryptNote(
            // The commitment feeds the memo's key derivation, so decryption must
            // be handed the same bytes the sender encrypted against.
            { commitmentHex: toHex(COMMITMENT), leafIndex: 1, encryptedMemo: memoHex },
            bob.viewingSecretKey,
            bob.spendingKey,
            bob.ownerPk
        );

        expect(note?.value).toBe(VALUE);
    });

    it('a stranger’s window does not match', () => {
        const memoHex = alicePaysBob(INDEX);
        const eveSecret = derivePairwiseSharedSecret(eve.viewingSecretKey, alice.viewingPublicKey);
        const eveWindow = pairwiseEphWindow(eveSecret, eve.viewingPublicKey, 0, 64);

        expect(eveWindow.some((e) => e.ephPkHex.toLowerCase() === memoEphPk(memoHex))).toBe(false);
    });
});

describe('pairwiseEphWindow', () => {
    it('covers exactly the requested range', () => {
        const window = pairwiseEphWindow(aliceSecret, bob.viewingPublicKey, 10, 5);

        expect(window.map((e) => e.index)).toEqual([10, 11, 12, 13, 14]);
    });

    it('emits distinct ephPks across indexes', () => {
        const window = pairwiseEphWindow(aliceSecret, bob.viewingPublicKey, 0, 32);

        expect(new Set(window.map((e) => e.ephPkHex)).size).toBe(32);
    });

    it('is reproducible', () => {
        expect(pairwiseEphWindow(aliceSecret, bob.viewingPublicKey, 0, 4)).toEqual(
            pairwiseEphWindow(bobSecret, bob.viewingPublicKey, 0, 4)
        );
    });

    it('rejects an invalid receiver key', () => {
        expect(() =>
            pairwiseEphWindow(aliceSecret, new Uint8Array(32).fill(0xff), 0, 1)
        ).toThrow(/invalid viewing public key/);
    });

    // Documented, not prevented: the linkage a reused counter creates is the
    // one privacy cost of the scheme, and the caller owns the counter.
    it('reusing an index republishes the same ephPk (the documented linkage)', () => {
        const a = pairwiseEphWindow(aliceSecret, bob.viewingPublicKey, 5, 1)[0]!;
        const b = pairwiseEphWindow(aliceSecret, bob.viewingPublicKey, 5, 1)[0]!;

        expect(a.ephPkHex).toBe(b.ephPkHex);
    });
});
