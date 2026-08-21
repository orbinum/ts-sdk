/**
 * Building a new note.
 *
 * The interesting decision here is which ephemeral key the note publishes,
 * because it decides how the recipient finds it later:
 *
 *   - **self** (shield, change, self-transfer): a deterministic ephemeral, so a
 *     cold restore recognises the note by ephPk lookup with zero trial ECDH.
 *   - **paying a privacy address**: an ephemeral from the sender's OUTGOING
 *     viewing key, so they can recognise their own payment later and read back
 *     what they sent. Not the spending key — predicting these points is the
 *     capability "see what I sent", which must not travel with the authority to
 *     move funds. The published point is PRF-derived and indistinguishable from
 *     the random one it replaces.
 *   - **anything else**: random, and the recipient pays for a full trial scan.
 *
 * A reservation that cannot name an index degrades to random rather than to
 * index zero: a reused index republishes an ephPk and links the two notes as
 * sharing a creator, which is a worse outcome than a slow scan.
 */
import { NoteBuilder } from '../../../protocol/note/index';
import { randomBlinding } from '../../../foundation/crypto/blinding';
import { deriveSelfEphSk, deriveOutgoingEphSk } from '../../../protocol/eph/index';
import { stampCreatedAt } from '../../vault/index';
import { toHex } from '../../../foundation/encoding/hex';
import {
    reserveSelfEphIndex,
    reserveOutgoingIndex,
    registerPairwiseCounterparty,
} from '../../vault/index';
import type { NoteStorage } from '../../vault/index';
import type { ZkNote } from '../../../protocol/types';

/** The wallet keys a note is built against. */
export interface NoteBuildKeys {
    ownerPk: bigint;
    spendingKey: bigint;
    /** Packed viewing public key — the memo is encrypted so this wallet can reopen it. */
    viewingPublicKey: Uint8Array;
    /** Needed only for pairwise derivation; omit to disable that path. */
    viewingSecretKey?: Uint8Array | undefined;
    /**
     * Outgoing viewing key (ovk). Omit and a payment falls back to a random
     * ephemeral: still spendable by the recipient, but the sender loses the
     * ability to read it back later.
     */
    outgoingViewingKey?: Uint8Array | undefined;
}

export interface BuildNoteParams {
    /** Note value in the asset's indivisible units. Must be greater than zero. */
    value: bigint;
    assetId?: bigint | undefined;
    /** Defaults to the wallet's own ownerPk. */
    ownerPk?: bigint | undefined;
    blinding?: bigint | undefined;
    /** Defaults to the wallet's own spending key. */
    spendingKey?: bigint | undefined;
    /** Packed viewing public key of the RECIPIENT, from their privacy address. */
    viewingPublicKey?: Uint8Array | undefined;
    /** Counterparty ownerPk. Zero for shield/unshield notes. */
    sourcePk?: bigint | undefined;
    /** Recipient's global ownerPk. With `viewingPublicKey`, enables stealth. */
    recipientOwnerPk?: bigint | undefined;
    /**
     * Next outgoing index as reconstructed from chain data, for the first
     * payment after a restore. Taken as a floor only — see `reserveOutgoingIndex`.
     */
    outgoingIndexFromChain?: number | undefined;
    /**
     * Circuit version to stamp. A fresh note carries no proof, so this only
     * matters when it is later spent — pass the version the chain reports as
     * active rather than a constant, or a spend can be rejected after a rotation.
     */
    circuitVersion: number;
}

export interface BuildNoteDeps {
    keys: NoteBuildKeys;
    /**
     * Where ephemeral indexes are reserved. Omit to always use a random
     * ephemeral: correct, but the note then costs the recipient a trial scan.
     */
    storage?: NoteStorage | undefined;
}

/** A built note, plus the outgoing index it published when it is a payment. */
interface BuiltNote {
    note: ZkNote;
    /**
     * Which index of the outgoing sequence this note used, when it is a payment
     * to a privacy address. Absent for self notes and for a payment that fell
     * back to a random ephemeral.
     *
     * The transfer reads it as a flag: an index present means this payment can
     * be recovered later, so its change note is worth giving a recipient book
     * entry. The entry is keyed on the payment's commitment, not on this index.
     */
    outgoingIndex?: number;
}

export async function buildZkNoteWithIndex(
    params: BuildNoteParams,
    deps: BuildNoteDeps
): Promise<BuiltNote> {
    // ── 1. Resolve the identity this note is built against ────────────────────
    const { keys, storage } = deps;
    const ownerPk = params.ownerPk ?? keys.ownerPk;
    const spendingKey = params.spendingKey ?? keys.spendingKey;
    const viewingPublicKey = params.viewingPublicKey ?? keys.viewingPublicKey;

    // ── 2. Pick the ephemeral ─────────────────────────────────────────────────
    // Each branch below may fail to reserve an index; all of them then fall
    // through to a RANDOM ephemeral rather than to index zero.
    const isSelf = params.viewingPublicKey === undefined && params.recipientOwnerPk === undefined;
    let ephSkOverride: Uint8Array | undefined;
    let outgoingIndex: number | undefined;

    if (isSelf && storage && keys.viewingSecretKey) {
        // 2a. Own note — a deterministic ephemeral a cold restore recognises.
        try {
            // The SECRET viewing key, never the public one: predicting the point
            // and opening the note are the same capability, so seeding from the
            // public half would let anyone holding an address derive it.
            ephSkOverride = deriveSelfEphSk(
                keys.viewingSecretKey,
                await reserveSelfEphIndex(storage)
            );
        } catch {
            // No reachable vault config (locked flows, tests) — random ephemeral.
        }
    } else if (params.viewingPublicKey && storage && keys.outgoingViewingKey) {
        // 2b. Paying a privacy address — an ephemeral from the SENDER's own
        // sequence, so a restored sender recognises this payment without
        // knowing who it went to.
        try {
            const index = await reserveOutgoingIndex(storage, params.outgoingIndexFromChain);
            ephSkOverride = deriveOutgoingEphSk(keys.outgoingViewingKey, index);
            outgoingIndex = index;
        } catch {
            // Vault unreachable — random ephemeral. The recipient still finds
            // the note by trial decryption; only the sender's own history is
            // lost, and a wrong index would be far worse than a missing one.
        }
        // 2c. Register the counterparty, which makes the REVERSE direction
        // cheap: their future payments become a hash lookup instead of one
        // trial ECDH per note in the pool. Kept in its own try because it must
        // survive the reservation failing — and its own failure costs only
        // scan speed.
        try {
            await registerPairwiseCounterparty(storage, toHex(params.viewingPublicKey));
        } catch {
            // Vault unreachable. Their notes stay on the trial-decrypt path.
        }
    }

    // ── 3. Build ──────────────────────────────────────────────────────────────
    const note = await NoteBuilder.build({
        value: params.value,
        assetId: params.assetId ?? 0n,
        ownerPk,
        blinding: params.blinding ?? randomBlinding(),
        spendingKey,
        viewingPublicKey,
        circuitVersion: params.circuitVersion,
        // Omitted rather than passed as undefined: the builder distinguishes an
        // absent recipient (a self note) from one explicitly set.
        ...(params.sourcePk !== undefined && { sourcePk: params.sourcePk }),
        ...(params.recipientOwnerPk !== undefined && {
            recipientOwnerPk: params.recipientOwnerPk,
        }),
        ...(ephSkOverride !== undefined && { ephSkOverride }),
    });
    return {
        note: stampCreatedAt(note, Date.now()),
        ...(outgoingIndex !== undefined ? { outgoingIndex } : {}),
    };
}

export async function buildZkNote(params: BuildNoteParams, deps: BuildNoteDeps): Promise<ZkNote> {
    return (await buildZkNoteWithIndex(params, deps)).note;
}
