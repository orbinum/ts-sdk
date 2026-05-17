import { describe, it, expect } from 'vitest';
import { poseidon2, poseidon4 } from 'poseidon-lite';
import {
  createNoteDisclosureKey,
  decodeNoteDisclosureKey,
  type NoteDisclosure,
} from '../../src/shielded-pool/protocol/NoteDisclosure';
import type { ZkNote } from '../../src/shielded-pool/protocol/types';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeNote(overrides: Partial<ZkNote> = {}): ZkNote {
  const value = overrides.value ?? 1_000_000n;
  const assetId = overrides.assetId ?? 0n;
  const ownerPk = overrides.ownerPk ?? 123456789n;
  const blinding = overrides.blinding ?? 987654321n;
  const spendingKey = overrides.spendingKey ?? 111n;
  const commitment = overrides.commitment ?? poseidon4([value, assetId, ownerPk, blinding]);
  const nullifier = overrides.nullifier ?? poseidon2([commitment, spendingKey]);
  const commitmentHex = '0x' + commitment.toString(16).padStart(64, '0');
  const nullifierHex = '0x' + nullifier.toString(16).padStart(64, '0');

  return {
    value,
    assetId,
    ownerPk,
    blinding,
    spendingKey,
    commitment,
    nullifier,
    commitmentHex,
    nullifierHex,
    spent: false,
    spentAt: null,
    memo: [],
    counterpartyPk: 0n,
    ...overrides,
  };
}

// ─── createNoteDisclosureKey ──────────────────────────────────────────────────

describe('createNoteDisclosureKey', () => {
  it('returns a string starting with "orbdisc:"', () => {
    const key = createNoteDisclosureKey(makeNote());
    expect(key).toMatch(/^orbdisc:/);
  });

  it('is deterministic for the same note', () => {
    const note = makeNote();
    expect(createNoteDisclosureKey(note)).toBe(createNoteDisclosureKey(note));
  });

  it('produces different keys for different values', () => {
    const a = createNoteDisclosureKey(makeNote({ value: 100n, commitment: poseidon4([100n, 0n, 123456789n, 987654321n]) }));
    const b = createNoteDisclosureKey(makeNote({ value: 200n, commitment: poseidon4([200n, 0n, 123456789n, 987654321n]) }));
    expect(a).not.toBe(b);
  });

  it('produces different keys for different assetIds', () => {
    const a = createNoteDisclosureKey(makeNote({ assetId: 0n, commitment: poseidon4([1_000_000n, 0n, 123456789n, 987654321n]) }));
    const b = createNoteDisclosureKey(makeNote({ assetId: 1n, commitment: poseidon4([1_000_000n, 1n, 123456789n, 987654321n]) }));
    expect(a).not.toBe(b);
  });

  it('produces different keys for different ownerPks', () => {
    const a = createNoteDisclosureKey(makeNote({ ownerPk: 1n, commitment: poseidon4([1_000_000n, 0n, 1n, 987654321n]) }));
    const b = createNoteDisclosureKey(makeNote({ ownerPk: 2n, commitment: poseidon4([1_000_000n, 0n, 2n, 987654321n]) }));
    expect(a).not.toBe(b);
  });

  it('does NOT encode spendingKey (spending privacy preserved)', () => {
    const note = makeNote();
    const key = createNoteDisclosureKey(note);
    // The spending key should not appear in base64-decoded payload
    const b64 = key.slice('orbdisc:'.length).replace(/-/g, '+').replace(/_/g, '/');
    const json = atob(b64);
    expect(json).not.toContain(note.spendingKey.toString(16));
    const payload = JSON.parse(json);
    expect(payload).not.toHaveProperty('sk');
    expect(payload).not.toHaveProperty('spendingKey');
    expect(payload).not.toHaveProperty('nullifier');
  });

  it('encodes all required fields in the payload', () => {
    const note = makeNote();
    const key = createNoteDisclosureKey(note);
    const b64 = key.slice('orbdisc:'.length).replace(/-/g, '+').replace(/_/g, '/');
    const payload = JSON.parse(atob(b64));
    expect(payload).toHaveProperty('v');
    expect(payload).toHaveProperty('c');
    expect(payload).toHaveProperty('val');
    expect(payload).toHaveProperty('aid');
    expect(payload).toHaveProperty('opk');
    expect(payload).toHaveProperty('bld');
  });

  it('uses base64url encoding (no +, /, or = characters after prefix)', () => {
    const key = createNoteDisclosureKey(makeNote());
    const encoded = key.slice('orbdisc:'.length);
    expect(encoded).not.toContain('+');
    expect(encoded).not.toContain('/');
    expect(encoded).not.toContain('=');
  });
});

// ─── decodeNoteDisclosureKey ──────────────────────────────────────────────────

describe('decodeNoteDisclosureKey', () => {
  it('decodes a valid key and returns all fields', () => {
    const note = makeNote();
    const key = createNoteDisclosureKey(note);
    const result = decodeNoteDisclosureKey(key);
    expect(result).not.toBeNull();
    expect(result!.value).toBe(note.value);
    expect(result!.assetId).toBe(note.assetId);
    expect(result!.ownerPk).toBe(note.ownerPk);
    expect(result!.blinding).toBe(note.blinding);
    expect(result!.commitment).toBe(note.commitment);
  });

  it('cryptographically verifies the commitment matches Poseidon4', () => {
    const note = makeNote();
    const key = createNoteDisclosureKey(note);
    const result = decodeNoteDisclosureKey(key)!;
    const recomputed = poseidon4([result.value, result.assetId, result.ownerPk, result.blinding]);
    expect(recomputed).toBe(result.commitment);
  });

  it('returns null for wrong prefix', () => {
    expect(decodeNoteDisclosureKey('wrongprefix:abc')).toBeNull();
    expect(decodeNoteDisclosureKey('disc:abc')).toBeNull();
    expect(decodeNoteDisclosureKey('ORBDISC:abc')).toBeNull();
  });

  it('returns null for empty string', () => {
    expect(decodeNoteDisclosureKey('')).toBeNull();
  });

  it('returns null for only the prefix', () => {
    expect(decodeNoteDisclosureKey('orbdisc:')).toBeNull();
  });

  it('returns null for malformed base64', () => {
    expect(decodeNoteDisclosureKey('orbdisc:!!!invalid!!!')).toBeNull();
  });

  it('returns null for invalid JSON inside base64', () => {
    const bad = btoa('not-json').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    expect(decodeNoteDisclosureKey('orbdisc:' + bad)).toBeNull();
  });

  it('returns null for unknown version', () => {
    const note = makeNote();
    const key = createNoteDisclosureKey(note);
    const b64 = key.slice('orbdisc:'.length).replace(/-/g, '+').replace(/_/g, '/');
    const payload = JSON.parse(atob(b64));
    payload.v = 99;
    const tampered = btoa(JSON.stringify(payload)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    expect(decodeNoteDisclosureKey('orbdisc:' + tampered)).toBeNull();
  });

  it('returns null when commitment does not match preimage (tampered commitment)', () => {
    const note = makeNote();
    const key = createNoteDisclosureKey(note);
    const b64 = key.slice('orbdisc:'.length).replace(/-/g, '+').replace(/_/g, '/');
    const payload = JSON.parse(atob(b64));
    payload.c = '0x' + (note.commitment + 1n).toString(16);
    const tampered = btoa(JSON.stringify(payload)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    expect(decodeNoteDisclosureKey('orbdisc:' + tampered)).toBeNull();
  });

  it('returns null when value is tampered (preimage mismatch)', () => {
    const note = makeNote();
    const key = createNoteDisclosureKey(note);
    const b64 = key.slice('orbdisc:'.length).replace(/-/g, '+').replace(/_/g, '/');
    const payload = JSON.parse(atob(b64));
    payload.val = '0x' + (note.value + 1n).toString(16);
    const tampered = btoa(JSON.stringify(payload)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    expect(decodeNoteDisclosureKey('orbdisc:' + tampered)).toBeNull();
  });

  it('returns null when assetId is tampered (preimage mismatch)', () => {
    const note = makeNote();
    const key = createNoteDisclosureKey(note);
    const b64 = key.slice('orbdisc:'.length).replace(/-/g, '+').replace(/_/g, '/');
    const payload = JSON.parse(atob(b64));
    payload.aid = '0x' + (note.assetId + 1n).toString(16);
    const tampered = btoa(JSON.stringify(payload)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    expect(decodeNoteDisclosureKey('orbdisc:' + tampered)).toBeNull();
  });

  it('returns null when ownerPk is tampered (preimage mismatch)', () => {
    const note = makeNote();
    const key = createNoteDisclosureKey(note);
    const b64 = key.slice('orbdisc:'.length).replace(/-/g, '+').replace(/_/g, '/');
    const payload = JSON.parse(atob(b64));
    payload.opk = '0x' + (note.ownerPk + 1n).toString(16);
    const tampered = btoa(JSON.stringify(payload)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    expect(decodeNoteDisclosureKey('orbdisc:' + tampered)).toBeNull();
  });

  it('returns null when blinding is tampered (preimage mismatch)', () => {
    const note = makeNote();
    const key = createNoteDisclosureKey(note);
    const b64 = key.slice('orbdisc:'.length).replace(/-/g, '+').replace(/_/g, '/');
    const payload = JSON.parse(atob(b64));
    payload.bld = '0x' + (note.blinding + 1n).toString(16);
    const tampered = btoa(JSON.stringify(payload)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    expect(decodeNoteDisclosureKey('orbdisc:' + tampered)).toBeNull();
  });

  it('does not expose spendingKey or nullifier in the decoded result', () => {
    const note = makeNote();
    const key = createNoteDisclosureKey(note);
    const result = decodeNoteDisclosureKey(key)! as NoteDisclosure & Record<string, unknown>;
    expect(result).not.toHaveProperty('spendingKey');
    expect(result).not.toHaveProperty('nullifier');
  });
});

// ─── Round-trip ───────────────────────────────────────────────────────────────

describe('createNoteDisclosureKey / decodeNoteDisclosureKey round-trip', () => {
  it('preserves all fields across encode → decode', () => {
    const note = makeNote({ value: 500n, assetId: 3n, ownerPk: 42n, blinding: 7n });
    const key = createNoteDisclosureKey(note);
    const decoded = decodeNoteDisclosureKey(key)!;
    expect(decoded.value).toBe(note.value);
    expect(decoded.assetId).toBe(note.assetId);
    expect(decoded.ownerPk).toBe(note.ownerPk);
    expect(decoded.blinding).toBe(note.blinding);
    expect(decoded.commitment).toBe(note.commitment);
  });

  it('works for zero-value note (edge case)', () => {
    const commitment = poseidon4([0n, 0n, 0n, 1n]);
    const note = makeNote({ value: 0n, assetId: 0n, ownerPk: 0n, blinding: 1n, commitment });
    const key = createNoteDisclosureKey(note);
    const decoded = decodeNoteDisclosureKey(key)!;
    expect(decoded).not.toBeNull();
    expect(decoded.value).toBe(0n);
    expect(decoded.commitment).toBe(commitment);
  });

  it('works for large bigint values', () => {
    const value = 2n ** 128n - 1n;
    const assetId = 255n;
    const ownerPk = 2n ** 64n;
    const blinding = 2n ** 64n + 1n;
    const commitment = poseidon4([value, assetId, ownerPk, blinding]);
    const note = makeNote({ value, assetId, ownerPk, blinding, commitment });
    const key = createNoteDisclosureKey(note);
    const decoded = decodeNoteDisclosureKey(key)!;
    expect(decoded).not.toBeNull();
    expect(decoded.value).toBe(value);
    expect(decoded.assetId).toBe(assetId);
    expect(decoded.ownerPk).toBe(ownerPk);
    expect(decoded.blinding).toBe(blinding);
    expect(decoded.commitment).toBe(commitment);
  });

  it('different notes produce different disclosure keys', () => {
    const noteA = makeNote({ value: 100n, commitment: poseidon4([100n, 0n, 123456789n, 987654321n]) });
    const noteB = makeNote({ value: 101n, commitment: poseidon4([101n, 0n, 123456789n, 987654321n]) });
    expect(createNoteDisclosureKey(noteA)).not.toBe(createNoteDisclosureKey(noteB));
  });

  it('decoding noteA key with noteB data fails verification (cross-note forgery)', () => {
    const noteA = makeNote({ value: 100n, commitment: poseidon4([100n, 0n, 123456789n, 987654321n]) });
    const noteB = makeNote({ value: 200n, commitment: poseidon4([200n, 0n, 123456789n, 987654321n]) });
    // Build a key that has noteA's commitment but noteB's value → should fail Poseidon check
    const keyA = createNoteDisclosureKey(noteA);
    const b64 = keyA.slice('orbdisc:'.length).replace(/-/g, '+').replace(/_/g, '/');
    const payload = JSON.parse(atob(b64));
    payload.val = '0x' + noteB.value.toString(16); // swap value, keep commitment
    const forged = btoa(JSON.stringify(payload)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    expect(decodeNoteDisclosureKey('orbdisc:' + forged)).toBeNull();
  });
});
