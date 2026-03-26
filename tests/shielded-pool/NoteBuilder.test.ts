import { describe, it, expect } from 'vitest';
import { NoteBuilder } from '../../src/shielded-pool/NoteBuilder';
import { ENCRYPTED_MEMO_SIZE } from '../../src/shielded-pool/EncryptedMemo';

// ─── NoteBuilder.build ────────────────────────────────────────────────────────

describe('NoteBuilder.build', () => {
  it('returns a ZkNote with all required fields', async () => {
    const note = await NoteBuilder.build({ value: 1000n, blinding: 1n });
    expect(note.value).toBe(1000n);
    expect(typeof note.commitment).toBe('bigint');
    expect(typeof note.nullifier).toBe('bigint');
    expect(note.commitmentHex).toMatch(/^0x[0-9a-f]+$/);
    expect(note.nullifierHex).toMatch(/^0x[0-9a-f]+$/);
  });

  it('commitment and nullifier hex are 32 bytes (64 nibbles)', async () => {
    const note = await NoteBuilder.build({ value: 1n, blinding: 1n });
    expect(note.commitmentHex).toMatch(/^0x[0-9a-f]{64}$/);
    expect(note.nullifierHex).toMatch(/^0x[0-9a-f]{64}$/);
  });

  it('defaults assetId to 0n', async () => {
    const note = await NoteBuilder.build({ value: 1n, blinding: 1n });
    expect(note.assetId).toBe(0n);
  });

  it('defaults ownerPk to 0n', async () => {
    const note = await NoteBuilder.build({ value: 1n, blinding: 1n });
    expect(note.ownerPk).toBe(0n);
  });

  it('defaults spendingKey to 0n', async () => {
    const note = await NoteBuilder.build({ value: 1n, blinding: 1n });
    expect(note.spendingKey).toBe(0n);
  });

  it('commitment is deterministic for same inputs', async () => {
    const input = { value: 42n, assetId: 1n, ownerPk: 123n, blinding: 456n, spendingKey: 789n };
    const a = await NoteBuilder.build(input);
    const b = await NoteBuilder.build(input);
    expect(a.commitment).toBe(b.commitment);
    expect(a.nullifier).toBe(b.nullifier);
    expect(a.commitmentHex).toBe(b.commitmentHex);
    expect(a.nullifierHex).toBe(b.nullifierHex);
  });

  it('different values produce different commitments', async () => {
    const base = { value: 100n, assetId: 0n, ownerPk: 0n, blinding: 1n, spendingKey: 0n };
    const a = await NoteBuilder.build(base);
    const b = await NoteBuilder.build({ ...base, value: 200n });
    expect(a.commitment).not.toBe(b.commitment);
  });

  it('different assetIds produce different commitments', async () => {
    const base = { value: 100n, ownerPk: 0n, blinding: 1n, spendingKey: 0n };
    const a = await NoteBuilder.build({ ...base, assetId: 0n });
    const b = await NoteBuilder.build({ ...base, assetId: 1n });
    expect(a.commitment).not.toBe(b.commitment);
  });

  it('different blindings produce different commitments (same other inputs)', async () => {
    const base = { value: 100n, assetId: 0n, ownerPk: 0n, spendingKey: 0n };
    const a = await NoteBuilder.build({ ...base, blinding: 1n });
    const b = await NoteBuilder.build({ ...base, blinding: 2n });
    expect(a.commitment).not.toBe(b.commitment);
  });

  it('different spending keys produce the same commitment but different nullifiers', async () => {
    const base = { value: 100n, assetId: 0n, ownerPk: 0n, blinding: 1n };
    const a = await NoteBuilder.build({ ...base, spendingKey: 1n });
    const b = await NoteBuilder.build({ ...base, spendingKey: 2n });
    expect(a.commitment).toBe(b.commitment);
    expect(a.nullifier).not.toBe(b.nullifier);
  });

  it('nullifier depends on commitment (same spendingKey, different commitment)', async () => {
    const a = await NoteBuilder.build({ value: 10n, blinding: 1n, spendingKey: 7n });
    const b = await NoteBuilder.build({ value: 20n, blinding: 1n, spendingKey: 7n });
    expect(a.nullifier).not.toBe(b.nullifier);
  });

  it('preserves explicitly provided fields', async () => {
    const input = { value: 99n, assetId: 5n, ownerPk: 0x1234n, blinding: 0x5678n, spendingKey: 0xabcdn };
    const note = await NoteBuilder.build(input);
    expect(note.value).toBe(99n);
    expect(note.assetId).toBe(5n);
    expect(note.ownerPk).toBe(0x1234n);
    expect(note.blinding).toBe(0x5678n);
    expect(note.spendingKey).toBe(0xabcdn);
  });
});

// ─── NoteBuilder.buildMemo ────────────────────────────────────────────────────

describe('NoteBuilder.buildMemo', () => {
  it('returns a Uint8Array of ENCRYPTED_MEMO_SIZE bytes', async () => {
    const note = await NoteBuilder.build({ value: 100n, blinding: 1n });
    const memo = NoteBuilder.buildMemo(note);
    expect(memo).toBeInstanceOf(Uint8Array);
    expect(memo).toHaveLength(ENCRYPTED_MEMO_SIZE);
  });

  it('produces different memos on each call (random nonce)', async () => {
    const note = await NoteBuilder.build({ value: 100n, blinding: 1n });
    const a = NoteBuilder.buildMemo(note);
    const b = NoteBuilder.buildMemo(note);
    // nonces differ with overwhelming probability
    expect(a.slice(0, 12)).not.toEqual(b.slice(0, 12));
  });

  it('accepts a custom 32-byte recipient viewing key', async () => {
    const note = await NoteBuilder.build({ value: 100n, blinding: 1n });
    const vk = new Uint8Array(32).fill(0x05);
    const memo = NoteBuilder.buildMemo(note, vk);
    expect(memo).toHaveLength(ENCRYPTED_MEMO_SIZE);
  });

  it('is synchronous (returns Uint8Array directly, not a Promise)', async () => {
    const note = await NoteBuilder.build({ value: 1n, blinding: 1n });
    const result = NoteBuilder.buildMemo(note);
    expect(result).toBeInstanceOf(Uint8Array);
  });
});
