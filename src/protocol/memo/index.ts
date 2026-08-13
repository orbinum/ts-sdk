/**
 * The encrypted memo: the note's plaintext, sealed to the recipient.
 *
 * The bottom of the protocol — a memo is what makes a note recoverable at all,
 * and its 180-byte layout is the normative wire format. The chain stores it as
 * an opaque blob, so this code, not the runtime, defines it.
 */
export { EncryptedMemo, ENCRYPTED_MEMO_SIZE, bytesToBjjScalar } from './EncryptedMemo';
export { serializeMemo, deriveViewTag } from './plaintext';

// Payment slip: the sealed handoff a sender gives a recipient to skip scanning.
//
// This is also how a sender re-hands a slip after losing their device: a slip
// carries only the commitment, the memo, and the leaf index — all public — so
// re-issuing one needs no ability to reopen the memo, only to forward it.
export {
    sealPaymentSlip,
    openPaymentSlip,
    encodePaymentSlip,
    decodePaymentSlip,
    PAYMENT_SLIP_SCHEME,
} from './PaymentSlip';
export type { PaymentSlipFields } from './PaymentSlip';
