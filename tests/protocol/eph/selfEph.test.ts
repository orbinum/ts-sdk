/**
 * Self-note ephemeral keys — deterministic ephSk so a cold restore finds the
 * wallet's own notes (shields, change) by ephPk hash-lookup, zero trial ECDH.
 *
 * Covers: derivation determinism + fixed cross-repo vector, window↔encrypt
 * ephPk byte-equality, shared-secret decrypt through tryDecryptNote's
 * sharedSecret option (identical result to the full ECDH path), index
 * distinctness, and foreign-window non-matching.
 */
import { describe, it, expect } from 'vitest';
import { sha256 } from '@noble/hashes/sha2.js';
import { deriveSelfEphSk, selfEphWindow } from '../../../src/protocol/eph/selfEph';
import { EncryptedMemo } from '../../../src/protocol/memo/EncryptedMemo';
import { NoteBuilder } from '../../../src/protocol/note/NoteBuilder';
import {
    tryDecryptNote,
    tryDecryptNoteVerbose,
} from '../../../src/protocol/note/NoteDecryptor';
import {
    deriveViewingSecretKey,
    deriveViewingPublicKey,
    deriveOwnerPk,
} from '../../../src/protocol/keys/PrivacyKeys';
import { toHex } from '../../../src/foundation/encoding/hex';
import { bigintTo32Le } from '../../../src/foundation/encoding/bytes';
import type { ScanCommitment } from '../../../src/protocol/types';

const SPENDING_KEY = 12345678901234567890n;
const ivsk = deriveViewingSecretKey(SPENDING_KEY);
const ivk = deriveViewingPublicKey(ivsk);
const ownerPk = deriveOwnerPk(SPENDING_KEY);

const FOREIGN_SK = 98765432109876543210n;

/** Own note built the deterministic way, as buildZkNote will do it. */
async function buildSelfNote(index: number, value = 5000n) {
    return NoteBuilder.build({
        value,
        assetId: 0n,
        ownerPk,
        blinding: 42n + BigInt(index),
        spendingKey: SPENDING_KEY,
        viewingPublicKey: ivk,
        circuitVersion: 1,
        ephSkOverride: deriveSelfEphSk(SPENDING_KEY, index),
    });
}

function asHint(note: { commitmentHex: string; memo: number[] }, leafIndex = 0): ScanCommitment {
    return {
        commitmentHex: note.commitmentHex,
        leafIndex,
        encryptedMemo: toHex(new Uint8Array(note.memo)),
    };
}

/** ephPk hex exactly as the indexer serves it: the memo's last 32 bytes. */
const memoEphPkHex = (memo: number[]) => toHex(new Uint8Array(memo.slice(-32)));

describe('deriveSelfEphSk', () => {
    it('is deterministic and index-sensitive', () => {
        expect(deriveSelfEphSk(SPENDING_KEY, 7)).toEqual(deriveSelfEphSk(SPENDING_KEY, 7));
        expect(deriveSelfEphSk(SPENDING_KEY, 7)).not.toEqual(deriveSelfEphSk(SPENDING_KEY, 8));
        expect(deriveSelfEphSk(SPENDING_KEY, 7)).not.toEqual(deriveSelfEphSk(FOREIGN_SK, 7));
    });

    it('fixed vector: SHA256("orbinum-self-eph-v1" || sk_LE32 || u32le(i)) (cross-repo pin)', () => {
        const h = sha256.create();
        h.update(new TextEncoder().encode('orbinum-self-eph-v1'));
        h.update(bigintTo32Le(SPENDING_KEY));
        h.update(new Uint8Array([3, 0, 0, 0])); // i = 3, u32 LE
        expect(deriveSelfEphSk(SPENDING_KEY, 3)).toEqual(h.digest());
    });
});

describe('selfEphWindow ↔ EncryptedMemo.encrypt', () => {
    it('window ephPkHex equals the memo tail byte-for-byte, for every index', async () => {
        const window = selfEphWindow(SPENDING_KEY, ivk, 0, 5);
        for (const entry of window) {
            const note = await buildSelfNote(entry.index);
            expect(memoEphPkHex(note.memo)).toBe(entry.ephPkHex);
        }
    });

    it("window sharedSecret decrypts the memo (matches the receiver's ECDH)", async () => {
        const [entry] = selfEphWindow(SPENDING_KEY, ivk, 2, 1);
        const note = await buildSelfNote(2, 777n);
        const memoBytes = new Uint8Array(note.memo);

        // Same secret the ivsk-side ECDH would produce…
        expect(EncryptedMemo.extractSharedSecret(memoBytes, ivsk)).toEqual(entry!.sharedSecret);
        // …and it decrypts directly.
        const dec = EncryptedMemo.decryptWithSharedSecret(
            memoBytes,
            bigintTo32Le(note.commitment),
            entry!.sharedSecret
        );
        expect(dec?.value).toBe(777n);
    });

    it('a foreign wallet window never matches our notes', async () => {
        const foreignWindow = selfEphWindow(
            FOREIGN_SK,
            deriveViewingPublicKey(deriveViewingSecretKey(FOREIGN_SK)),
            0,
            32
        );
        const note = await buildSelfNote(0);
        const tail = memoEphPkHex(note.memo);
        expect(foreignWindow.some((e) => e.ephPkHex === tail)).toBe(false);
    });
});

describe('tryDecryptNote with a precomputed sharedSecret', () => {
    it('returns the exact same note as the full ECDH path', async () => {
        const [entry] = selfEphWindow(SPENDING_KEY, ivk, 4, 1);
        const note = await buildSelfNote(4, 9999n);
        const hint = asHint(note);

        const full = tryDecryptNote(hint, ivsk, SPENDING_KEY, ownerPk);
        const fast = tryDecryptNote(hint, ivsk, SPENDING_KEY, ownerPk, {
            sharedSecret: entry!.sharedSecret,
        });

        expect(full).not.toBeNull();
        expect(fast).not.toBeNull();
        expect(fast!.commitmentHex).toBe(full!.commitmentHex);
        expect(fast!.nullifierHex).toBe(full!.nullifierHex);
        expect(fast!.value).toBe(9999n);
    });

    it('a wrong sharedSecret fails the MAC — no false accept', async () => {
        const note = await buildSelfNote(5);
        const res = tryDecryptNoteVerbose(asHint(note), ivsk, SPENDING_KEY, ownerPk, {
            sharedSecret: new Uint8Array(32).fill(9),
        });
        expect(res.note).toBeNull();
        expect(res.reason).toBe('decrypt_failed:wrong_key_or_corrupt_mac');
    });

    it('sharedSecret wins over viewTag: decrypts even when both options are passed', async () => {
        const [entry] = selfEphWindow(SPENDING_KEY, ivk, 6, 1);
        const note = await buildSelfNote(6, 4242n);
        // The window match already proved ownership — the tag gate must not
        // re-filter (a precomputed secret skips it entirely).
        const res = tryDecryptNoteVerbose(asHint(note), ivsk, SPENDING_KEY, ownerPk, {
            viewTag: true,
            sharedSecret: entry!.sharedSecret,
        });
        expect(res.note?.value).toBe(4242n);
    });

    it('triple agreement: window path == view-tag path == full path on one note', async () => {
        const [entry] = selfEphWindow(SPENDING_KEY, ivk, 7, 1);
        const note = await buildSelfNote(7, 1234n);
        const hint = asHint(note);

        const viaWindow = tryDecryptNote(hint, ivsk, SPENDING_KEY, ownerPk, {
            sharedSecret: entry!.sharedSecret,
        });
        const viaViewTag = tryDecryptNote(hint, ivsk, SPENDING_KEY, ownerPk, { viewTag: true });
        const viaFull = tryDecryptNote(hint, ivsk, SPENDING_KEY, ownerPk);

        for (const found of [viaWindow, viaViewTag, viaFull]) {
            expect(found).not.toBeNull();
            expect(found!.commitmentHex).toBe(note.commitmentHex);
            expect(found!.nullifierHex).toBe(note.nullifierHex);
            expect(found!.value).toBe(1234n);
        }
    });

    it('stealth path honours ephSkOverride, and the recipient still finds the note', async () => {
        // The override used to be dropped here, which silently disabled the
        // pairwise fast path: the caller derived an ephemeral the builder threw
        // away. Honouring it must not cost the recipient anything — the same
        // ephSk drives both the memo encryption and the stealth derivation.
        const recipientOwnerPk = deriveOwnerPk(SPENDING_KEY);
        const override = deriveSelfEphSk(SPENDING_KEY, 99);
        const note = await NoteBuilder.build({
            value: 10n,
            assetId: 0n,
            ownerPk: recipientOwnerPk,
            blinding: 321n,
            spendingKey: 1n,
            viewingPublicKey: ivk,
            recipientOwnerPk,
            circuitVersion: 1,
            ephSkOverride: override, // documented as ignored on the stealth path
        });

        // The published ephPk is the override's…
        const [overrideEntry] = selfEphWindow(SPENDING_KEY, ivk, 99, 1);
        expect(memoEphPkHex(note.memo)).toBe(overrideEntry!.ephPkHex);
        // …and the recipient still recovers the note via the normal stealth scan.
        const found = tryDecryptNote(asHint(note), ivsk, SPENDING_KEY, recipientOwnerPk);
        expect(found).not.toBeNull();
        expect(found!.value).toBe(10n);
    });
});
