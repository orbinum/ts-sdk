/**
 * The recipient book — who this wallet paid, carried in its own change notes.
 *
 * A payment's amount and recipient live in a memo sealed toward someone else.
 * The sender can reopen it (see `outgoingEph`) but only knowing the recipient's
 * viewing key, and that key lives in vault state a restore wipes.
 *
 * The channel already exists: every transfer also produces a CHANGE note,
 * sealed toward the sender's own viewing key with a `selfEph` ephemeral, so a
 * restored wallet reads it from the seed alone. The recipient's viewing key
 * rides in that note's `sourcePk` — metadata, never part of
 * `Poseidon4(value, assetId, ownerPk, blinding)` and never in the circuit, so
 * the 32 bytes are free.
 *
 * ## Sealed, and under the OUTGOING key
 *
 * A viewing key is meant to be handed out — an auditor, a watch-only device.
 * In plaintext, every such disclosure would hand over the whole payment GRAPH,
 * a far larger secret than the amounts an incoming viewing key reveals.
 *
 * So it is sealed under the ovk, a branch of its own: the incoming key reads
 * every amount and not one counterparty; the ovk reads the graph and cannot
 * spend. Sealing under the SPENDING key would tie "who did I pay" to "can move
 * the money" — and hand the graph to whoever steals it.
 *
 * ## No MAC, and why that is sound
 *
 * The field is exactly 32 bytes, leaving no room for a tag, so this is a
 * keystream XOR with no integrity of its own. It needs none: a key recovered
 * here is only ever used to open a payment memo, which is AEAD-sealed. A
 * corrupted key yields a different shared secret and that memo's MAC rejects
 * it — the authentication is real, one step downstream.
 *
 * It does NOT protect against a party who knows the ovk, who is exactly who
 * this data is for.
 */
import { sha256 } from '@noble/hashes/sha2.js';
import { bigintTo32Le } from '../../foundation/encoding/bytes';

const RECIPIENT_BOOK_DOMAIN = new TextEncoder().encode('orbinum-recipient-book-v3');

/** Packed viewing keys are 32 bytes; so is the field that carries them. */
const IVK_SIZE = 32;

/**
 * The keystream for one book entry.
 *
 * Keyed on the PAYMENT's commitment — the note the entry describes, not the
 * change note that carries it. That is deliberate and worth stating, because
 * the entry lives in the change note and keying it on its own container reads
 * as the obvious choice: the reader is a SCAN, which meets the payment first
 * and only ever needs the entry while holding that payment. Its commitment is
 * the one value present on both sides at the moment each needs it.
 *
 * An index would seem natural and is a trap: the entry is sealed against the
 * OUTGOING sequence and read while scanning a note from the SELF sequence. One
 * shield advances the self counter alone and the two drift apart for good —
 * silently, since a wrong keystream yields a plausible 32 bytes that simply
 * never opens a memo.
 *
 * The commitment has none of that coupling, and it is unique per note, so
 * paying the same person twice still produces two unrelated ciphertexts.
 * Without that last property, anyone holding the change plaintexts could group
 * payments by equal ciphertext and recover the shape of the address book
 * without decrypting any of it.
 */
function bookKeystream(outgoingViewingKey: Uint8Array, paymentCommitmentHex: string): Uint8Array {
    // A degenerate ovk makes this keystream PUBLIC — anyone recomputes it and
    // reads the whole address book in the clear. SHA256 answers for any input,
    // so an empty or all-zero key (a missing field, an uninitialised buffer)
    // fails silently into exactly that. Refused here as well as in
    // `outgoingEph`: the two derive from the same key by different paths, and a
    // guard on one is not a guard on the other.
    if (outgoingViewingKey.length !== 32) {
        throw new Error(
            `recipientBook: outgoingViewingKey must be 32 bytes, got ${outgoingViewingKey.length}`
        );
    }
    if (outgoingViewingKey.every((b) => b === 0)) {
        throw new Error(
            'recipientBook: outgoingViewingKey is all zeros — the book would be public'
        );
    }
    // Normalised to bare lowercase hex before hashing. Case and the `0x` prefix
    // are serving decisions — one feed sends `0xAB…`, another `ab…` — and
    // hashing the string as given makes either one silently derive a different
    // keystream. The failure would be invisible: a wrong keystream yields 32
    // plausible bytes that simply never open a memo.
    const normalised = paymentCommitmentHex.toLowerCase().replace(/^0x/, '');
    const h = sha256.create();
    h.update(RECIPIENT_BOOK_DOMAIN);
    h.update(outgoingViewingKey);
    h.update(new TextEncoder().encode(normalised));
    return h.digest();
}

/**
 * Seal (or open — XOR is its own inverse) a recipient's packed viewing key for
 * carriage in a change note's `sourcePk`.
 *
 * Returns the input unchanged when it is not 32 bytes: a caller with a
 * malformed key must not silently ship a truncated one, and every consumer
 * here already treats an unusable book entry as "no recipient known".
 *
 * @param ivkPacked            32-byte packed viewing key, sealed or plain
 * @param outgoingViewingKey   this wallet's OUTGOING viewing key (ovk) — the
 *                             capability "see what I sent", delegable on its own
 * @param paymentCommitmentHex  the PAYMENT's commitment — NOT the change note's.
 *                               It is the one value both sides hold: the sender
 *                               has it while building, and a restored wallet has
 *                               it the moment the outgoing window matches that
 *                               payment, which is the only time the entry is
 *                               needed.
 */
export function sealRecipientBookEntry(
    ivkPacked: Uint8Array,
    outgoingViewingKey: Uint8Array,
    paymentCommitmentHex: string
): Uint8Array {
    if (ivkPacked.length !== IVK_SIZE) return ivkPacked;
    const keystream = bookKeystream(outgoingViewingKey, paymentCommitmentHex);
    const out = new Uint8Array(IVK_SIZE);
    for (let i = 0; i < IVK_SIZE; i++) out[i] = ivkPacked[i]! ^ keystream[i]!;
    return out;
}

/**
 * Recover a recipient's packed viewing key from a change note's `sourcePk`.
 *
 * The value is transported as a raw 32-byte little-endian integer with no field
 * reduction, so a ciphertext above the BN254 modulus survives intact — which
 * matters, because most of them are.
 *
 * The result is unverified by construction: whether it is really a viewing key
 * is settled by trying to open the payment memo with it.
 *
 * Returns 32 zero bytes for anything that cannot be a `sourcePk` — negative, or
 * wider than the 32 bytes the field is carved from. A memo can never yield one
 * (the slice is 32 bytes), but this is public API taking a bigint, and every
 * neighbour here answers an impossible input with a value no memo will open
 * rather than an exception a caller has to catch mid-scan.
 */
export function openRecipientBookEntry(
    sealedSourcePk: bigint,
    outgoingViewingKey: Uint8Array,
    paymentCommitmentHex: string
): Uint8Array {
    if (sealedSourcePk < 0n || sealedSourcePk >> 256n !== 0n) return new Uint8Array(IVK_SIZE);
    return sealRecipientBookEntry(
        bigintTo32Le(sealedSourcePk),
        outgoingViewingKey,
        paymentCommitmentHex
    );
}
