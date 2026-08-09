/**
 * The encrypted memo: the note's plaintext, sealed to the recipient.
 *
 * The bottom of the protocol — a memo is what makes a note recoverable at all,
 * and its 180-byte layout is the normative wire format. The chain stores it as
 * an opaque blob, so this code, not the runtime, defines it.
 */
export { EncryptedMemo, ENCRYPTED_MEMO_SIZE, bytesToBjjScalar } from './EncryptedMemo';
export { serializeMemo, deriveViewTag } from './plaintext';

// Outgoing viewing key: the sender-side blob that wraps a memo's shared secret.
export {
    OVK_BLOB_SIZE,
    deriveOutgoingCipherKey,
    sealOutgoingBlob,
    openOutgoingBlob,
    randomOutgoingBlob,
} from './OutgoingBlob';

// Payment slip: the sealed handoff a sender gives a recipient to skip scanning.
export {
    sealPaymentSlip,
    openPaymentSlip,
    encodePaymentSlip,
    decodePaymentSlip,
    PAYMENT_SLIP_SCHEME,
} from './PaymentSlip';
export type { PaymentSlipFields } from './PaymentSlip';
