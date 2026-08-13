/**
 * Building a new note.
 *
 * The interesting decision here is which ephemeral key the note publishes,
 * because it decides how the recipient finds it later:
 *
 *   - **self** (shield, change, self-transfer): a deterministic ephemeral, so a
 *     cold restore recognises the note by ephPk lookup with zero trial ECDH.
 *   - **paying a known privacy address**: an ephemeral derived from the secret
 *     both sides share, so the RECIPIENT finds it by hash lookup instead of one
 *     ECDH per note in the pool. The published point is PRF-derived and
 *     indistinguishable from the random one it replaces to anyone without that
 *     secret.
 *   - **anything else**: random, and the recipient pays for a full trial scan.
 *
 * A reservation that cannot name an index always degrades to random rather than
 * to index zero: a reused index republishes an ephPk and links the two notes as
 * sharing a creator, which is a worse outcome than a slow scan. That covers a
 * failed reservation AND a counterparty this vault has no counter for, since a
 * restored wallet cannot tell a first payment from a counter it lost.
 */
import { NoteBuilder } from '../../../protocol/note/index';
import { randomBlinding } from '../../../foundation/crypto/blinding';
import { deriveSelfEphSk } from '../../../protocol/eph/index';
import { derivePairwiseSharedSecret, derivePairwiseEphSk } from '../../../protocol/eph/index';
import { toHex } from '../../../foundation/encoding/hex';
import { stampCreatedAt } from '../../vault/index';
import { reserveSelfEphIndex, reservePairwiseIndex } from '../../vault/index';
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

export async function buildZkNote(params: BuildNoteParams, deps: BuildNoteDeps): Promise<ZkNote> {
    const { keys, storage } = deps;
    const ownerPk = params.ownerPk ?? keys.ownerPk;
    const spendingKey = params.spendingKey ?? keys.spendingKey;
    const viewingPublicKey = params.viewingPublicKey ?? keys.viewingPublicKey;

    const isSelf = params.viewingPublicKey === undefined && params.recipientOwnerPk === undefined;
    let ephSkOverride: Uint8Array | undefined;

    if (isSelf && storage) {
        try {
            ephSkOverride = deriveSelfEphSk(spendingKey, await reserveSelfEphIndex(storage));
        } catch {
            // No reachable vault config (locked flows, tests) — random ephemeral.
        }
    } else if (params.viewingPublicKey && storage && keys.viewingSecretKey) {
        try {
            const index = await reservePairwiseIndex(storage, toHex(params.viewingPublicKey));
            if (index !== null) {
                const pairSecret = derivePairwiseSharedSecret(
                    keys.viewingSecretKey,
                    params.viewingPublicKey
                );
                ephSkOverride = derivePairwiseEphSk(pairSecret, index);
            }
        } catch {
            // Vault unreachable, or a key that is not a curve point — random
            // ephemeral. The note is still recoverable, just the slow way.
        }
    }

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
    return stampCreatedAt(note, Date.now());
}
