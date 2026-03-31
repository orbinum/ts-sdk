import { describe, it, expect, beforeAll } from 'vitest';
import { tryDecryptNote, type ScanCommitment } from '../../src/shielded-pool/NoteDecryptor';
import { NoteBuilder } from '../../src/shielded-pool/NoteBuilder';
import { deriveViewingKey } from '../../src/shielded-pool/PrivacyKeys';
import { toHex } from '../../src/utils/hex';
import type { ZkNote } from '../../src/shielded-pool/types';

// ─── Test fixtures ────────────────────────────────────────────────────────────

const SPENDING_KEY = 12345678901234567890n;
let viewingKey: Uint8Array;
let note: ZkNote;
let validCommitment: ScanCommitment;

beforeAll(async () => {
  viewingKey = deriveViewingKey(SPENDING_KEY);
  note = await NoteBuilder.build({
    value: 1000n,
    assetId: 0n,
    ownerPk: 0n,
    blinding: 42n,
    spendingKey: SPENDING_KEY,
  });
  const memoBytes = NoteBuilder.buildMemo(note, viewingKey);
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
    expect(result.memo).toHaveLength(104);
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
    const otherVk = deriveViewingKey(999n);
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
