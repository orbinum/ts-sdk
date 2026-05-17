/**
 * NoteDisclosure
 *
 * Utilities for creating and decoding single-note disclosure keys.
 * A disclosure key is a compact, shareable string encoding the plaintext
 * preimage of one specific note commitment. Anyone with the key can verify
 * the note's value and asset — without gaining any spending capability.
 *
 * Format: "orbdisc:<base64url(JSON)>"
 *
 * Revealed by the key:
 *   - value, assetId, ownerPk (BJJ Ax — not linked to EVM address), blinding
 *   - commitment (cryptographically verified via Poseidon4)
 *
 * NOT revealed by the key:
 *   - spendingKey, nullifier, viewingSecretKey
 *   - any other note belonging to the same user
 *
 * Security: the commitment verification in decodeNoteDisclosureKey is a
 * cryptographic proof-of-knowledge of the preimage. A forged key (mismatched
 * preimage) will fail verification and return null.
 */

import { poseidon4 } from 'poseidon-lite';
import type { ZkNote } from './types';

const PREFIX = 'orbdisc:';
const VERSION = 1;

// ─── Public types ─────────────────────────────────────────────────────────────

/**
 * Decoded and cryptographically verified contents of a note disclosure key.
 *
 * The `commitment` field is guaranteed to equal Poseidon4(value, assetId, ownerPk, blinding)
 * — this is verified by decodeNoteDisclosureKey before returning.
 */
export interface NoteDisclosure {
    /** Poseidon4(value, assetId, ownerPk, blinding) — matches the on-chain commitment. */
    commitment: bigint;
    /** Note value in the smallest unit (e.g. attoORB). */
    value: bigint;
    /** Asset ID as registered in the shielded pool. */
    assetId: bigint;
    /** BabyJubJub Ax coordinate of the note owner (not directly linkable to an EVM address). */
    ownerPk: bigint;
    /** Random blinding scalar chosen at note creation. */
    blinding: bigint;
}

// ─── Internal payload shape ───────────────────────────────────────────────────

interface DisclosurePayload {
    v: number;
    c: string; // commitment (hex)
    val: string; // value (hex)
    aid: string; // assetId (hex)
    opk: string; // ownerPk (hex)
    bld: string; // blinding (hex)
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function toHex(n: bigint): string {
    return '0x' + n.toString(16);
}

function fromHex(s: string): bigint {
    return BigInt(s);
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Encodes a single ZkNote's plaintext preimage into a shareable disclosure key.
 *
 * The key does NOT include the spendingKey or nullifier. It is safe to share
 * with any party that should be able to verify the note's value and asset
 * without being able to spend it.
 *
 * @param note  A fully populated ZkNote (as returned by the vault / rescan).
 * @returns     A "orbdisc:…" string suitable for copy-paste or QR encoding.
 */
export function createNoteDisclosureKey(note: ZkNote): string {
    const payload: DisclosurePayload = {
        v: VERSION,
        c: toHex(note.commitment),
        val: toHex(note.value),
        aid: toHex(note.assetId),
        opk: toHex(note.ownerPk),
        bld: toHex(note.blinding),
    };
    const json = JSON.stringify(payload);
    const b64 = btoa(json).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    return PREFIX + b64;
}

/**
 * Decodes and cryptographically verifies a note disclosure key.
 *
 * Verification: recomputes Poseidon4(value, assetId, ownerPk, blinding) and
 * asserts it equals the embedded commitment. This ensures the preimage is
 * consistent and cannot be tampered with.
 *
 * @param key  A "orbdisc:…" string produced by createNoteDisclosureKey.
 * @returns    The verified NoteDisclosure, or null if the key is malformed,
 *             has an unknown version, or fails Poseidon4 verification.
 */
export function decodeNoteDisclosureKey(key: string): NoteDisclosure | null {
    try {
        if (!key.startsWith(PREFIX)) return null;
        const b64 = key.slice(PREFIX.length).replace(/-/g, '+').replace(/_/g, '/');
        const json = atob(b64);
        const payload = JSON.parse(json) as DisclosurePayload;
        if (payload.v !== VERSION) return null;

        const disclosure: NoteDisclosure = {
            commitment: fromHex(payload.c),
            value: fromHex(payload.val),
            assetId: fromHex(payload.aid),
            ownerPk: fromHex(payload.opk),
            blinding: fromHex(payload.bld),
        };

        // Cryptographic preimage verification
        const recomputed = poseidon4([
            disclosure.value,
            disclosure.assetId,
            disclosure.ownerPk,
            disclosure.blinding,
        ]);
        if (recomputed !== disclosure.commitment) return null;

        return disclosure;
    } catch {
        return null;
    }
}
