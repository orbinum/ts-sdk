/**
 * Marshalling a freshly built note into shield extrinsic arguments.
 *
 * Small, but the one detail here fails silently and unrecoverably: the
 * commitment goes on chain LITTLE-ENDIAN. `ShieldParams.commitment` only says
 * "32-byte hex", so a caller reaching for the obvious big-endian encoding
 * produces a commitment the chain accepts and a note NOBODY can ever find —
 * not the sender's scan, not a rescan, not the recipient. The funds are gone.
 *
 * The transfer and unshield paths already own their marshalling; this closes
 * the gap for shield.
 */
import { bigintTo32LeArr } from '../../../foundation/encoding/bytes';
import { toHex } from '../../../foundation/encoding/hex';
import type { ZkNote } from '../../../protocol/index';
import type { ShieldParams } from '../../../chain/pallet/shielded-pool/extrinsicParams';

/** Shield arguments for one note. */
export function buildShieldParams(note: ZkNote): ShieldParams {
    return {
        assetId: Number(note.assetId),
        amount: note.value,
        commitment: toHex(new Uint8Array(bigintTo32LeArr(note.commitment))),
        encryptedMemo: note.memo instanceof Uint8Array ? note.memo : Uint8Array.from(note.memo),
    };
}

/**
 * Batch arguments, as the pallet's `shield_batch` positional tuple:
 * `(asset_id, amount, commitment, encrypted_memo)`.
 *
 * Positional rather than named because that is what the extrinsic's codec
 * expects — a named object is silently mis-encoded.
 */
export function buildShieldBatchOperations(
    notes: ZkNote[]
): Array<[number, bigint, string, Uint8Array]> {
    return notes.map((note) => {
        const params = buildShieldParams(note);
        return [params.assetId, params.amount, params.commitment, params.encryptedMemo];
    });
}
