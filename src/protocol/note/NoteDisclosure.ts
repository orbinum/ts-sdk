/**
 * Proving what ONE note holds, without granting any power to spend it.
 *
 * A disclosure key is a shareable string carrying the plaintext preimage of a
 * single commitment: `orbdisc:<base64url(JSON)>`. The holder can verify the
 * note's value and asset and nothing else.
 *
 * | Revealed | Withheld |
 * | --- | --- |
 * | value, assetId, blinding | spendingKey, nullifier, viewing secret key |
 * | ownerPk (a BJJ Ax, not an EVM address) | every other note of the same wallet |
 *
 * The commitment check on decode is a proof-of-knowledge of the preimage:
 * Poseidon4 is recomputed and compared, so a forged or edited key fails rather
 * than decoding into a lie. `null` is returned for every failure — malformed,
 * wrong version, bad preimage — because a caller showing a disclosure to a user
 * has one decision to make, not three.
 *
 * Encoding goes through the SDK's own base64url rather than `btoa`/`atob`:
 * neither exists in React Native, and a key the official mobile wallet cannot
 * produce or read is not a shareable format.
 */

import { poseidon4 } from 'poseidon-lite';
import { base64UrlEncode, base64UrlDecode } from '../../foundation/encoding/base64url';
import { BN254_R } from '../../foundation/crypto/constants';
import type { ZkNote } from '../types';

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
    return PREFIX + base64UrlEncode(JSON.stringify(payload));
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
        const payload = JSON.parse(base64UrlDecode(key.slice(PREFIX.length))) as DisclosurePayload;
        if (payload.v !== VERSION) return null;

        const disclosure: NoteDisclosure = {
            commitment: fromHex(payload.c),
            value: fromHex(payload.val),
            assetId: fromHex(payload.aid),
            ownerPk: fromHex(payload.opk),
            blinding: fromHex(payload.bld),
        };

        // Range checks BEFORE the preimage check. Poseidon reduces its inputs
        // mod r, so without these a crafted key could claim value = -5 (or
        // value + r) and still hash to a self-consistent commitment — the
        // verifier would display a figure no on-chain note can hold. Bounds
        // mirror the circuit's: value is u128, assetId u32, scalars in [0, r).
        if (disclosure.value < 0n || disclosure.value >= 1n << 128n) return null;
        if (disclosure.assetId < 0n || disclosure.assetId >= 1n << 32n) return null;
        if (disclosure.ownerPk < 0n || disclosure.ownerPk >= BN254_R) return null;
        if (disclosure.blinding < 0n || disclosure.blinding >= BN254_R) return null;
        if (disclosure.commitment < 0n || disclosure.commitment >= BN254_R) return null;

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
