/**
 * Re-issuing a payment slip from recovered history.
 *
 * A slip is sealed toward the RECIPIENT, so the sender never held a readable
 * copy. But a slip carries only PUBLIC facts — commitment, memo, leaf index —
 * so once those are looked up on chain the sender can seal a NEW envelope with
 * the same contents, without ever reading the memo. Different bytes (fresh
 * ephemeral and nonce), identical fields on opening.
 *
 * Not a capability anyone else gains: it needs the recipient's viewing key,
 * which the sender holds only because they were given a privacy address.
 */
import { sealPaymentSlip, encodePaymentSlip } from '../../protocol/memo/PaymentSlip';
import { ENCRYPTED_MEMO_SIZE } from '../../protocol/memo/EncryptedMemo';
import { isValidLeafIndex } from '../../protocol/spend/coinSelection';
import { isHexOfLength } from '../../foundation/encoding/hex';
import type { NoteFacts } from '../../protocol/types';

/**
 * Seal a fresh `orbslip1:` slip for a transfer recovered from history.
 *
 * VALIDATES ON THIS SIDE OF THE WIRE. The facts crossed a trust boundary (they
 * were looked up by commitment) and sealing them produces an AUTHENTICATED
 * envelope: a valid MAC proves the sender knew the recipient's viewing key, not
 * that the server which answered was honest. The recipient's wallet then renders
 * those fields with the authority of a decrypted slip, on a device that cannot
 * tell where they came from.
 *
 * Throws on a malformed commitment, memo or leaf index — they are the note's
 * identity, and a slip carrying a wrong one is broken, not degraded. `txHash` is
 * informational, so it is DROPPED instead.
 *
 * @param facts               public facts of the sent note, looked up by commitment
 * @param recipientIvkPacked  32-byte packed viewing key from the recipient's privacy address
 * @param txHash              the transfer's hash, when known — informational
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
        // The recipient renders this as an explorer link, so an unconstrained
        // string is a URL injection wearing the authority of a decrypted slip.
        ...(isHexOfLength(txHash, 32) ? { txHash } : {}),
    });
    return encodePaymentSlip(envelope);
}
