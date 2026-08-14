/**
 * Re-issuing a payment slip from recovered history.
 *
 * A slip is sealed toward the RECIPIENT, so the sender keeps no copy they can
 * decrypt — losing the local record used to mean the recipient could never be
 * handed one again, and had to fall back to a full chain scan.
 *
 * That stops being true once the facts are looked up on chain. A slip contains
 * only the commitment, the memo, and the leaf index — all public — so the
 * sender can seal a NEW envelope carrying the same facts without ever reading
 * the memo. The result is not the original bytes (a fresh ephemeral key and
 * nonce make every envelope different) but it opens to exactly the same fields.
 *
 * What this does NOT do is let anyone else re-issue a slip: it needs the
 * recipient's viewing key, which the sender only holds because they were given
 * a privacy address in the first place.
 */
import { sealPaymentSlip, encodePaymentSlip } from '../../protocol/memo/PaymentSlip';
import { ENCRYPTED_MEMO_SIZE } from '../../protocol/memo/EncryptedMemo';
import { isValidLeafIndex } from '../../protocol/spend/coinSelection';
import { isHexOfLength } from '../../foundation/encoding/hex';
import type { NoteFacts } from '../../protocol/types';

/**
 * Seal a fresh `orbslip1:` slip for a transfer recovered from history.
 *
 * ## Why the facts are checked here
 *
 * They were looked up by commitment, so they crossed a trust boundary, and
 * sealing them produces an AUTHENTICATED envelope. A valid MAC proves the
 * sender knew the recipient's viewing key — not that they are honest, and not
 * that whatever server answered the lookup was. The recipient's wallet then
 * renders those fields with the authority of a decrypted slip, on a device
 * where nothing explains which server supplied them.
 *
 * So the check belongs on THIS side of the wire: a value that slipped through
 * would fail on the recipient's device, or worse, not fail at all.
 *
 * Throws on a malformed commitment, memo or leaf index — those are the note's
 * identity, and a slip carrying a wrong one is not a degraded slip but a broken
 * one. `txHash` is informational, so it is DROPPED rather than fatal.
 *
 * @param facts               public facts of the sent note, looked up by commitment
 * @param recipientIvkPacked  32-byte packed viewing key from the recipient's privacy address
 * @param txHash              the transfer's hash, when known — informational, shown as proof of payment
 */
export function regeneratePaymentSlip(
    facts: NoteFacts,
    recipientIvkPacked: Uint8Array,
    txHash?: string
): string {
    if (!isHexOfLength(facts.commitmentHex, 32)) {
        throw new Error('regeneratePaymentSlip: commitmentHex must be 32 bytes of hex');
    }
    if (!isHexOfLength(facts.encryptedMemo, ENCRYPTED_MEMO_SIZE)) {
        throw new Error(
            `regeneratePaymentSlip: encryptedMemo must be ${ENCRYPTED_MEMO_SIZE} bytes of hex`
        );
    }
    if (facts.leafIndex !== undefined && !isValidLeafIndex(facts.leafIndex)) {
        throw new Error('regeneratePaymentSlip: leafIndex must be a real tree position');
    }

    const envelope = sealPaymentSlip(recipientIvkPacked, {
        commitmentHex: facts.commitmentHex,
        encryptedMemo: facts.encryptedMemo,
        ...(facts.leafIndex !== undefined ? { leafIndex: facts.leafIndex } : {}),
        // Rendered as an explorer link by the recipient, where an unconstrained
        // string is a URL injection wearing the authority of a decrypted slip.
        // Dropped rather than fatal: the slip still rebuilds the note, which is
        // the part that matters.
        ...(isHexOfLength(txHash, 32) ? { txHash } : {}),
    });
    return encodePaymentSlip(envelope);
}
