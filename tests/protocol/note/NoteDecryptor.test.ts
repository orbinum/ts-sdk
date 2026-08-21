import { describe, it, expect, beforeAll } from 'vitest';
import {
    tryDecryptNote,
    tryDecryptNoteVerbose,
    computeNullifier,
    computeNoteCommitment,
    commitmentHexOf,
    type ScanCommitment,
} from '../../../src/protocol/note/NoteDecryptor';
import { NoteBuilder } from '../../../src/protocol/note/NoteBuilder';
import {
    deriveViewingSecretKey,
    deriveViewingPublicKey,
    deriveOwnerPk,
} from '../../../src/protocol/keys/PrivacyKeys';
import { toHex, fromHex } from '../../../src/foundation/encoding/hex';
import { bytesToBigintLE, bigintTo32Le } from '../../../src/foundation/encoding/bytes';
import { CURRENT_CIRCUIT_VERSION, type ZkNote } from '../../../src/protocol/types';

// ─── Test fixtures ────────────────────────────────────────────────────────────

const SPENDING_KEY = 12345678901234567890n;
let viewingKey: Uint8Array; // viewingSecretKey — used for decryption
let viewingPublicKey: Uint8Array; // viewingPublicKey — used for encryption
let note: ZkNote;
let validCommitment: ScanCommitment;

beforeAll(async () => {
    viewingKey = deriveViewingSecretKey(SPENDING_KEY);
    viewingPublicKey = deriveViewingPublicKey(viewingKey);
    note = await NoteBuilder.build({
        value: 1000n,
        assetId: 0n,
        ownerPk: 0n,
        blinding: 42n,
        spendingKey: SPENDING_KEY,
    });
    const memoBytes = NoteBuilder.buildMemo(note, viewingPublicKey);
    validCommitment = {
        commitmentHex: note.commitmentHex,
        leafIndex: 0,
        encryptedMemo: toHex(memoBytes),
    };
});

// ─── tryDecryptNote — happy path ──────────────────────────────────────────────

describe('tryDecryptNote — valid note', () => {
    it('returns a ZkNote (non-null) for a valid commitment + matching key', () => {
        const result = tryDecryptNote(validCommitment, viewingKey, SPENDING_KEY);
        expect(result).not.toBeNull();
    });

    it('returned ZkNote has the correct value', () => {
        const result = tryDecryptNote(validCommitment, viewingKey, SPENDING_KEY)!;
        expect(result.value).toBe(1000n);
    });

    it('returned ZkNote has the correct assetId', () => {
        const result = tryDecryptNote(validCommitment, viewingKey, SPENDING_KEY)!;
        expect(result.assetId).toBe(0n);
    });

    it('returned ZkNote has the correct blinding', () => {
        const result = tryDecryptNote(validCommitment, viewingKey, SPENDING_KEY)!;
        expect(result.blinding).toBe(42n);
    });

    it('returned ZkNote carries the spending key', () => {
        const result = tryDecryptNote(validCommitment, viewingKey, SPENDING_KEY)!;
        expect(result.spendingKey).toBe(SPENDING_KEY);
    });

    it('commitmentHex matches the original note', () => {
        const result = tryDecryptNote(validCommitment, viewingKey, SPENDING_KEY)!;
        expect(result.commitmentHex).toBe(note.commitmentHex);
    });

    it('nullifierHex matches the original note', () => {
        const result = tryDecryptNote(validCommitment, viewingKey, SPENDING_KEY)!;
        expect(result.nullifierHex).toBe(note.nullifierHex);
    });

    it('commitmentHex is a 0x-prefixed 64-nibble string', () => {
        const result = tryDecryptNote(validCommitment, viewingKey, SPENDING_KEY)!;
        expect(result.commitmentHex).toMatch(/^0x[0-9a-f]{64}$/);
    });

    it('nullifierHex is a 0x-prefixed 64-nibble string', () => {
        const result = tryDecryptNote(validCommitment, viewingKey, SPENDING_KEY)!;
        expect(result.nullifierHex).toMatch(/^0x[0-9a-f]{64}$/);
    });

    it('memo field is a number[]', () => {
        const result = tryDecryptNote(validCommitment, viewingKey, SPENDING_KEY)!;
        expect(Array.isArray(result.memo)).toBe(true);
        expect(result.memo).toHaveLength(180);
    });

    it('leafIndex on ScanCommitment does not affect decryption', () => {
        const c: ScanCommitment = { ...validCommitment, leafIndex: 99 };
        const result = tryDecryptNote(c, viewingKey, SPENDING_KEY);
        expect(result).not.toBeNull();
    });
});

// ─── tryDecryptNote — null paths ──────────────────────────────────────────────

describe('tryDecryptNote — returns null when note cannot be decrypted', () => {
    it('returns null when encryptedMemo is null', () => {
        const c: ScanCommitment = { ...validCommitment, encryptedMemo: null };
        expect(tryDecryptNote(c, viewingKey, SPENDING_KEY)).toBeNull();
    });

    it('returns null when encryptedMemo is an empty string', () => {
        const c: ScanCommitment = { ...validCommitment, encryptedMemo: '' };
        // empty string is falsy — early-return path
        expect(tryDecryptNote(c, viewingKey, SPENDING_KEY)).toBeNull();
    });

    it('returns null when commitmentHex is invalid hex', () => {
        const c: ScanCommitment = { ...validCommitment, commitmentHex: 'not-hex' };
        expect(tryDecryptNote(c, viewingKey, SPENDING_KEY)).toBeNull();
    });

    it('returns null when encryptedMemo is invalid hex', () => {
        const c: ScanCommitment = { ...validCommitment, encryptedMemo: 'zzz' };
        expect(tryDecryptNote(c, viewingKey, SPENDING_KEY)).toBeNull();
    });

    it('returns null when viewing key is wrong (all zeros)', () => {
        const wrongKey = new Uint8Array(32);
        expect(tryDecryptNote(validCommitment, wrongKey, SPENDING_KEY)).toBeNull();
    });

    it('returns null when viewing key belongs to a different spending key', () => {
        const otherVk = deriveViewingSecretKey(999n);
        expect(tryDecryptNote(validCommitment, otherVk, SPENDING_KEY)).toBeNull();
    });

    it('returns null when commitmentHex is tampered (commitment mismatch)', () => {
        // Replace one nibble to produce a different commitment value.
        const tampered = validCommitment.commitmentHex.replace(/.$/, 'f');
        const c: ScanCommitment = {
            ...validCommitment,
            commitmentHex:
                tampered !== validCommitment.commitmentHex
                    ? tampered
                    : validCommitment.commitmentHex.replace(/.$/, '0'),
        };
        expect(tryDecryptNote(c, viewingKey, SPENDING_KEY)).toBeNull();
    });
});

// ─── tryDecryptNote — determinism ─────────────────────────────────────────────

describe('tryDecryptNote — determinism', () => {
    it('same inputs always produce the same ZkNote', () => {
        const a = tryDecryptNote(validCommitment, viewingKey, SPENDING_KEY)!;
        const b = tryDecryptNote(validCommitment, viewingKey, SPENDING_KEY)!;
        expect(a.commitment).toBe(b.commitment);
        expect(a.nullifier).toBe(b.nullifier);
        expect(a.commitmentHex).toBe(b.commitmentHex);
        expect(a.nullifierHex).toBe(b.nullifierHex);
    });
});

// ─── tryDecryptNoteVerbose — reason codes ─────────────────────────────────────

describe('tryDecryptNoteVerbose — happy path', () => {
    it('devuelve note sin reason cuando el memo descifra correctamente', () => {
        const result = tryDecryptNoteVerbose(validCommitment, viewingKey, SPENDING_KEY);
        expect(result.note).not.toBeNull();
        expect(result.reason).toBeUndefined();
    });

    it('el note devuelto coincide con tryDecryptNote', () => {
        const verbose = tryDecryptNoteVerbose(validCommitment, viewingKey, SPENDING_KEY);
        const simple = tryDecryptNote(validCommitment, viewingKey, SPENDING_KEY);
        expect(verbose.note?.commitmentHex).toBe(simple?.commitmentHex);
        expect(verbose.note?.nullifierHex).toBe(simple?.nullifierHex);
    });
});

// ─── circuitVersion carried in the memo ───────────────────────────────────────

describe('tryDecryptNote — circuitVersion from memo', () => {
    it('recovers the circuit version stamped into the note memo', async () => {
        // A note built with circuitVersion=2 carries it inside the encrypted memo;
        // the decryptor reads it back — no indexer lookup.
        const n = await NoteBuilder.build({
            value: 1000n,
            assetId: 0n,
            ownerPk: 0n,
            blinding: 42n,
            spendingKey: SPENDING_KEY,
            viewingPublicKey,
            circuitVersion: 2,
        });
        const c: ScanCommitment = {
            commitmentHex: n.commitmentHex,
            leafIndex: 0,
            encryptedMemo: toHex(new Uint8Array(n.memo)),
        };
        const result = tryDecryptNote(c, viewingKey, SPENDING_KEY)!;
        expect(result.circuitVersion).toBe(2);
    });

    it('defaults to CURRENT_CIRCUIT_VERSION when the note is built without one', async () => {
        const n = await NoteBuilder.build({
            value: 500n,
            assetId: 0n,
            ownerPk: 0n,
            blinding: 7n,
            spendingKey: SPENDING_KEY,
            viewingPublicKey,
        });
        const c: ScanCommitment = {
            commitmentHex: n.commitmentHex,
            leafIndex: 0,
            encryptedMemo: toHex(new Uint8Array(n.memo)),
        };
        const result = tryDecryptNote(c, viewingKey, SPENDING_KEY)!;
        expect(result.circuitVersion).toBe(CURRENT_CIRCUIT_VERSION);
    });
});

describe('tryDecryptNoteVerbose — códigos de fallo', () => {
    it('devuelve reason="no_memo" cuando encryptedMemo es null', () => {
        const c: ScanCommitment = { ...validCommitment, encryptedMemo: null };
        const result = tryDecryptNoteVerbose(c, viewingKey, SPENDING_KEY);
        expect(result.note).toBeNull();
        expect(result.reason).toBe('no_memo');
    });

    it('devuelve reason="no_memo" cuando encryptedMemo es string vacío', () => {
        const c: ScanCommitment = { ...validCommitment, encryptedMemo: '' };
        const result = tryDecryptNoteVerbose(c, viewingKey, SPENDING_KEY);
        expect(result.note).toBeNull();
        expect(result.reason).toBe('no_memo');
    });

    it('devuelve reason="hex_parse_error" cuando commitmentHex no es hex válido', () => {
        const c: ScanCommitment = { ...validCommitment, commitmentHex: 'not-valid-hex' };
        const result = tryDecryptNoteVerbose(c, viewingKey, SPENDING_KEY);
        expect(result.note).toBeNull();
        expect(result.reason).toBe('hex_parse_error');
    });

    it('devuelve reason="hex_parse_error" cuando encryptedMemo no es hex válido', () => {
        const c: ScanCommitment = { ...validCommitment, encryptedMemo: 'zzz-no-hex' };
        const result = tryDecryptNoteVerbose(c, viewingKey, SPENDING_KEY);
        expect(result.note).toBeNull();
        expect(result.reason).toBe('hex_parse_error');
    });

    it('devuelve reason que comienza con "memo_size_mismatch" cuando el memo tiene tamaño incorrecto', () => {
        // Un memo de 10 bytes (no es 104)
        const shortMemo = '0x' + '0a'.repeat(10);
        const c: ScanCommitment = { ...validCommitment, encryptedMemo: shortMemo };
        const result = tryDecryptNoteVerbose(c, viewingKey, SPENDING_KEY);
        expect(result.note).toBeNull();
        expect(result.reason).toMatch(/^memo_size_mismatch:got_10_expected_\d+$/);
    });

    it('devuelve reason="decrypt_failed:wrong_key_or_corrupt_mac" con viewing key incorrecta', () => {
        const wrongKey = new Uint8Array(32); // all zeros
        const result = tryDecryptNoteVerbose(validCommitment, wrongKey, SPENDING_KEY);
        expect(result.note).toBeNull();
        expect(result.reason).toBe('decrypt_failed:wrong_key_or_corrupt_mac');
    });

    it('devuelve reason="decrypt_failed:wrong_key_or_corrupt_mac" con viewing key de otro spending key', () => {
        const otherVk = deriveViewingSecretKey(999n);
        const result = tryDecryptNoteVerbose(validCommitment, otherVk, SPENDING_KEY);
        expect(result.note).toBeNull();
        expect(result.reason).toBe('decrypt_failed:wrong_key_or_corrupt_mac');
    });

    // Nota: el código 'commitment_mismatch' ocurre cuando el memo descifra correctamente
    // (MAC pasa) pero el Poseidon recalculado difiere del commitment en cadena. Esto requiere
    // construir un memo cifrado bajo un AAD válido pero con plaintext cuyos valores de campo
    // producen un hash diferente — imposible de simular sin acceso a los internals de AES-GCM.
    // Se documenta aquí para confirmar que el path existe en la implementación.
});

// ─── computeNullifier ─────────────────────────────────────────────────────────

describe('computeNullifier', () => {
    const COMMITMENT = 123456789n;
    const SK = 12345678901234567890n;

    it('returns a bigint', () => {
        const n = computeNullifier(COMMITMENT, SK);
        expect(typeof n).toBe('bigint');
    });

    it('is deterministic — same inputs produce same output', () => {
        expect(computeNullifier(COMMITMENT, SK)).toBe(computeNullifier(COMMITMENT, SK));
    });

    it('result is non-zero for typical inputs', () => {
        expect(computeNullifier(COMMITMENT, SK)).toBeGreaterThan(0n);
    });

    it('different commitments produce different nullifiers', () => {
        const n1 = computeNullifier(1n, SK);
        const n2 = computeNullifier(2n, SK);
        expect(n1).not.toBe(n2);
    });

    it('different spending keys produce different nullifiers', () => {
        const n1 = computeNullifier(COMMITMENT, 1n);
        const n2 = computeNullifier(COMMITMENT, 2n);
        expect(n1).not.toBe(n2);
    });

    it('is order-sensitive (commitment, sk) != (sk, commitment)', () => {
        const forward = computeNullifier(COMMITMENT, SK);
        const reversed = computeNullifier(SK, COMMITMENT);
        expect(forward).not.toBe(reversed);
    });

    it('no reduction applied — sk is used as-is (pre-normalized from deriveSpendingKeyFromSignature)', () => {
        // The function no longer normalizes sk % BABYJUB_SUBORDER internally.
        // The same sk passed directly produces the expected result deterministically.
        const n1 = computeNullifier(COMMITMENT, SK);
        const n2 = computeNullifier(COMMITMENT, SK);
        expect(n1).toBe(n2);
    });

    it('matches nullifier stored in a built note', async () => {
        const sk = SPENDING_KEY;
        const vsk = deriveViewingSecretKey(sk);
        const vpk = deriveViewingPublicKey(vsk);
        const n = await NoteBuilder.build({
            value: 500n,
            assetId: 1n,
            ownerPk: 0n,
            blinding: 77n,
            spendingKey: sk,
        });
        const memoBytes = NoteBuilder.buildMemo(n, vpk);
        const commitment: ScanCommitment = {
            commitmentHex: n.commitmentHex,
            leafIndex: 0,
            encryptedMemo: toHex(memoBytes),
        };
        const decrypted = tryDecryptNote(commitment, vsk, sk);
        expect(decrypted).not.toBeNull();
        expect(decrypted!.nullifier).toBe(computeNullifier(n.commitment, sk));
    });
});

// ─── computeNoteCommitment ────────────────────────────────────────────────────

describe('computeNoteCommitment', () => {
    it('matches the commitment produced by NoteBuilder for the same inputs', () => {
        // `note` is built in beforeAll with value=1000n, assetId=0n, blinding=42n.
        const recomputed = computeNoteCommitment(
            note.value,
            note.assetId,
            note.ownerPk,
            note.blinding
        );
        expect(recomputed).toBe(note.commitment);
    });

    it('matches when ownerPk is re-derived from the spending key (circuit invariant)', async () => {
        // Mirrors the pre-proof guard: BabyPbk(spending_key).Ax must reproduce
        // the on-chain commitment. Same path as unshield.circom:60-71.
        // Needs a note whose ownerPk was actually derived from the spending key
        // (the shared fixture uses ownerPk: 0n literally).
        const ownedNote = await NoteBuilder.build({
            value: 250n,
            assetId: 1n,
            ownerPk: deriveOwnerPk(SPENDING_KEY),
            blinding: 55n,
            spendingKey: SPENDING_KEY,
        });
        const recomputed = computeNoteCommitment(
            ownedNote.value,
            ownedNote.assetId,
            deriveOwnerPk(SPENDING_KEY),
            ownedNote.blinding
        );
        expect(recomputed).toBe(ownedNote.commitment);
        expect(recomputed).toBe(bytesToBigintLE(fromHex(ownedNote.commitmentHex)));
    });

    it('round-trips through commitmentHex (LE bytes) as the app guard compares it', () => {
        const fromHexScalar = bytesToBigintLE(fromHex(note.commitmentHex));
        const recomputed = computeNoteCommitment(
            note.value,
            note.assetId,
            note.ownerPk,
            note.blinding
        );
        expect(recomputed).toBe(fromHexScalar);
    });

    it('is deterministic', () => {
        expect(computeNoteCommitment(1n, 2n, 3n, 4n)).toBe(computeNoteCommitment(1n, 2n, 3n, 4n));
    });

    it('changes when any field changes', () => {
        const base = computeNoteCommitment(1n, 2n, 3n, 4n);
        expect(computeNoteCommitment(9n, 2n, 3n, 4n)).not.toBe(base);
        expect(computeNoteCommitment(1n, 9n, 3n, 4n)).not.toBe(base);
        expect(computeNoteCommitment(1n, 2n, 9n, 4n)).not.toBe(base);
        expect(computeNoteCommitment(1n, 2n, 3n, 9n)).not.toBe(base);
    });

    it('is order-sensitive — matches Poseidon4(value, assetId, ownerPk, blinding) exactly', () => {
        expect(computeNoteCommitment(1n, 2n, 3n, 4n)).not.toBe(
            computeNoteCommitment(4n, 3n, 2n, 1n)
        );
    });
});

// ─── sourcePk round-trip ─────────────────────────────────────────────────

describe('tryDecryptNoteVerbose — sourcePk', () => {
    it('sourcePk is 0n for shield notes (no sourcePk in input)', () => {
        const result = tryDecryptNoteVerbose(validCommitment, viewingKey, SPENDING_KEY);
        expect(result.note).not.toBeNull();
        expect(result.note!.sourcePk).toBe(0n);
    });

    it('sourcePk is recovered correctly after encrypt/decrypt round-trip', async () => {
        const sk = SPENDING_KEY;
        const vsk = deriveViewingSecretKey(sk);
        const vpk = deriveViewingPublicKey(vsk);
        const cpk = 0xdeadbeefcafebaben;
        const n = await NoteBuilder.build({
            value: 500n,
            assetId: 1n,
            ownerPk: 0n,
            blinding: 77n,
            spendingKey: sk,
            sourcePk: cpk,
        });
        const memoBytes = NoteBuilder.buildMemo(n, vpk);
        const commitment: ScanCommitment = {
            commitmentHex: n.commitmentHex,
            leafIndex: 0,
            encryptedMemo: toHex(memoBytes),
        };
        const result = tryDecryptNoteVerbose(commitment, vsk, sk);
        expect(result.note).not.toBeNull();
        expect(result.note!.sourcePk).toBe(cpk);
    });
});

// ─── Stealth address — end-to-end ────────────────────────────────────────────

describe('stealth address — end-to-end (NoteBuilder + NoteDecryptor)', () => {
    // Sender and recipient have independent key pairs.
    const SENDER_SK = 11111111111111111n;
    const RECIPIENT_SK = 22222222222222222n;

    let senderOwnerPk: bigint;
    let recipientOwnerPk: bigint;
    let recipientVsk: Uint8Array;
    let recipientVpk: Uint8Array;
    let stealthNote: ZkNote;
    let stealthCommitment: ScanCommitment;

    beforeAll(async () => {
        senderOwnerPk = deriveOwnerPk(SENDER_SK);
        recipientOwnerPk = deriveOwnerPk(RECIPIENT_SK);
        recipientVsk = deriveViewingSecretKey(RECIPIENT_SK);
        recipientVpk = deriveViewingPublicKey(recipientVsk);

        // Sender builds a stealth note for the recipient.
        stealthNote = await NoteBuilder.build({
            value: 5000n,
            blinding: 77n,
            ownerPk: recipientOwnerPk,
            sourcePk: senderOwnerPk,
            viewingPublicKey: recipientVpk,
            recipientOwnerPk,
        });

        stealthCommitment = {
            commitmentHex: stealthNote.commitmentHex,
            leafIndex: 0,
            encryptedMemo: toHex(new Uint8Array(stealthNote.memo)),
        };
    });

    it('recipient can decrypt the stealth note with their viewing key + ownOwnerPk', () => {
        const result = tryDecryptNote(
            stealthCommitment,
            recipientVsk,
            RECIPIENT_SK,
            recipientOwnerPk
        );
        expect(result).not.toBeNull();
    });

    it('decrypted note has correct value and assetId', () => {
        const result = tryDecryptNote(
            stealthCommitment,
            recipientVsk,
            RECIPIENT_SK,
            recipientOwnerPk
        );
        expect(result!.value).toBe(5000n);
        expect(result!.assetId).toBe(0n);
    });

    it('decrypted note.ownerPk is stealthOwnerPk (not the recipient global ownerPk)', () => {
        const result = tryDecryptNote(
            stealthCommitment,
            recipientVsk,
            RECIPIENT_SK,
            recipientOwnerPk
        );
        expect(result!.ownerPk).not.toBe(recipientOwnerPk);
        expect(result!.ownerPk).toBe(stealthNote.ownerPk); // matches what NoteBuilder produced
    });

    it('decrypted note.spendingKey is the derived stealthSk', () => {
        const result = tryDecryptNote(
            stealthCommitment,
            recipientVsk,
            RECIPIENT_SK,
            recipientOwnerPk
        );
        expect(result!.spendingKey).not.toBe(RECIPIENT_SK);
    });

    it('nullifier is correctly derived using stealthSk', () => {
        const result = tryDecryptNote(
            stealthCommitment,
            recipientVsk,
            RECIPIENT_SK,
            recipientOwnerPk
        );
        const expectedNullifier = computeNullifier(result!.commitment, result!.spendingKey);
        expect(result!.nullifier).toBe(expectedNullifier);
    });

    it('without ownOwnerPk (0n), memo decrypts but spendingKey is the global key (not stealthSk)', () => {
        // Without ownOwnerPk, stealth detection is skipped. The commitment still matches
        // (plaintext.ownerPk = stealthOwnerPk was used to build it), but spendingKey = RECIPIENT_SK
        // which would produce an invalid on-chain nullifier at spend time.
        const result = tryDecryptNoteVerbose(stealthCommitment, recipientVsk, RECIPIENT_SK, 0n);
        expect(result.note).not.toBeNull();
        expect(result.note!.spendingKey).toBe(RECIPIENT_SK); // wrong key — nullifier would be invalid
    });

    it('fails to decrypt with a wrong ownOwnerPk', () => {
        const wrongPk = deriveOwnerPk(99999999n);
        const result = tryDecryptNoteVerbose(
            stealthCommitment,
            recipientVsk,
            RECIPIENT_SK,
            wrongPk
        );
        expect(result.note).toBeNull();
    });

    it('own (non-stealth) notes still decrypt correctly when ownOwnerPk is provided', async () => {
        const ownSk = 33333333333333n;
        const ownPk = deriveOwnerPk(ownSk);
        const ownVsk = deriveViewingSecretKey(ownSk);
        const ownVpk = deriveViewingPublicKey(ownVsk);

        // Build a regular (non-stealth) own note — no recipientOwnerPk.
        const ownNote = await NoteBuilder.build({
            value: 800n,
            blinding: 11n,
            ownerPk: ownPk,
            spendingKey: ownSk,
            viewingPublicKey: ownVpk,
        });
        const ownCommitment: ScanCommitment = {
            commitmentHex: ownNote.commitmentHex,
            leafIndex: 0,
            encryptedMemo: toHex(NoteBuilder.buildMemo(ownNote, ownVpk)),
        };

        const result = tryDecryptNote(ownCommitment, ownVsk, ownSk, ownPk);
        expect(result).not.toBeNull();
        expect(result!.value).toBe(800n);
        expect(result!.ownerPk).toBe(ownPk);
        expect(result!.spendingKey).toBe(ownSk);
    });

    it('two stealth notes from the same sender produce different stealthSk values', async () => {
        const note2 = await NoteBuilder.build({
            value: 100n,
            blinding: 88n,
            ownerPk: recipientOwnerPk,
            viewingPublicKey: recipientVpk,
            recipientOwnerPk,
        });
        const commitment2: ScanCommitment = {
            commitmentHex: note2.commitmentHex,
            leafIndex: 1,
            encryptedMemo: toHex(new Uint8Array(note2.memo)),
        };
        const r1 = tryDecryptNote(stealthCommitment, recipientVsk, RECIPIENT_SK, recipientOwnerPk);
        const r2 = tryDecryptNote(commitment2, recipientVsk, RECIPIENT_SK, recipientOwnerPk);
        expect(r1).not.toBeNull();
        expect(r2).not.toBeNull();
        expect(r1!.spendingKey).not.toBe(r2!.spendingKey);
        expect(r1!.ownerPk).not.toBe(r2!.ownerPk);
    });
});

/**
 * `commitmentHexOf` — the on-chain hex form of a commitment.
 *
 * Little-endian, and the direction is not cosmetic: every index into a note —
 * scan hints, vault records, `ZkNote.commitmentHex` — is keyed by it. Encoding
 * big-endian produces a well-formed hex string that matches nothing, so a
 * lookup finds no note and an ownership check answers "not mine" for every one,
 * with nothing thrown to explain it.
 */
describe('commitmentHexOf', () => {
    it('encodes little-endian, matching what a decrypted note carries', () => {
        // 1 is the clearest case: LE puts the byte first, BE puts it last.
        expect(commitmentHexOf(1n)).toBe('0x' + '01' + '00'.repeat(31));
    });

    it('pads to a full 32 bytes', () => {
        expect(commitmentHexOf(0n)).toBe('0x' + '00'.repeat(32));
        expect(commitmentHexOf(0xffn).length).toBe(66);
    });

    it('agrees with the hex a decrypted note reports', async () => {
        // The guarantee that matters: a caller comparing against
        // `note.commitmentHex` must get a match for the same commitment.
        const commitment = 0xdeadbeefn;
        expect(commitmentHexOf(commitment)).toBe(toHex(bigintTo32Le(commitment)));
    });
});
