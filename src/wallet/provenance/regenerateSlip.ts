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
import type { NoteFacts } from '../../protocol/types';

/**
 * Seal a fresh `orbslip1:` slip for a transfer recovered from history.
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
    const envelope = sealPaymentSlip(recipientIvkPacked, {
        commitmentHex: facts.commitmentHex,
        encryptedMemo: facts.encryptedMemo,
        ...(facts.leafIndex !== undefined ? { leafIndex: facts.leafIndex } : {}),
        ...(txHash ? { txHash } : {}),
    });
    return encodePaymentSlip(envelope);
}
