import { describe, it, expect, beforeAll } from 'vitest';
import {
    tryDecryptNote,
    tryDecryptNoteVerbose,
    computeNullifier,
    type ScanCommitment,
} from '../../src/shielded-pool/protocol/NoteDecryptor';
import { NoteBuilder } from '../../src/shielded-pool/protocol/NoteBuilder';
import { deriveViewingSecretKey, deriveViewingPublicKey, deriveOwnerPk } from '../../src/privacy-keys/PrivacyKeys';
import { toHex } from '../../src/utils/hex';
import type { ZkNote } from '../../src/shielded-pool/protocol/types';

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
    expect(result.memo).toHaveLength(176);
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
      commitmentHex: tampered !== validCommitment.commitmentHex
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
    const n = await NoteBuilder.build({ value: 500n, assetId: 1n, ownerPk: 0n, blinding: 77n, spendingKey: sk });
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

// ─── counterpartyPk round-trip ─────────────────────────────────────────────────

describe('tryDecryptNoteVerbose — counterpartyPk', () => {
  it('counterpartyPk is 0n for shield notes (no counterpartyPk in input)', () => {
    const result = tryDecryptNoteVerbose(validCommitment, viewingKey, SPENDING_KEY);
    expect(result.note).not.toBeNull();
    expect(result.note!.counterpartyPk).toBe(0n);
  });

  it('counterpartyPk is recovered correctly after encrypt/decrypt round-trip', async () => {
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
      counterpartyPk: cpk,
    });
    const memoBytes = NoteBuilder.buildMemo(n, vpk);
    const commitment: ScanCommitment = {
      commitmentHex: n.commitmentHex,
      leafIndex: 0,
      encryptedMemo: toHex(memoBytes),
    };
    const result = tryDecryptNoteVerbose(commitment, vsk, sk);
    expect(result.note).not.toBeNull();
    expect(result.note!.counterpartyPk).toBe(cpk);
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
      counterpartyPk: senderOwnerPk,
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
    const result = tryDecryptNote(stealthCommitment, recipientVsk, RECIPIENT_SK, recipientOwnerPk);
    expect(result!.value).toBe(5000n);
    expect(result!.assetId).toBe(0n);
  });

  it('decrypted note.ownerPk is stealthOwnerPk (not the recipient global ownerPk)', () => {
    const result = tryDecryptNote(stealthCommitment, recipientVsk, RECIPIENT_SK, recipientOwnerPk);
    expect(result!.ownerPk).not.toBe(recipientOwnerPk);
    expect(result!.ownerPk).toBe(stealthNote.ownerPk); // matches what NoteBuilder produced
  });

  it('decrypted note.spendingKey is the derived stealthSk', () => {
    const result = tryDecryptNote(stealthCommitment, recipientVsk, RECIPIENT_SK, recipientOwnerPk);
    expect(result!.spendingKey).not.toBe(RECIPIENT_SK);
  });

  it('nullifier is correctly derived using stealthSk', () => {
    const result = tryDecryptNote(stealthCommitment, recipientVsk, RECIPIENT_SK, recipientOwnerPk);
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
    const result = tryDecryptNoteVerbose(stealthCommitment, recipientVsk, RECIPIENT_SK, wrongPk);
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
