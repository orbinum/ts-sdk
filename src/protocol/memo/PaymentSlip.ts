/**
 * Payment slip — a note the SENDER of a private transfer hands the RECIPIENT so
 * they rebuild it without scanning the pool.
 *
 * ## What it carries
 *
 * The minimum a recipient needs to locate and reconstruct their note, all of it
 * already PUBLIC on-chain: the recipient output's `commitmentHex`, its
 * `encryptedMemo`, and (optionally) its `leafIndex`. The recipient opens the memo
 * with their own viewing key (`tryDecryptNote`), which decrypts the fields,
 * derives the stealth spending key, and verifies the commitment — so the slip
 * grants no spend power and reveals nothing the chain does not already hold.
 *
 * ## Why it is still encrypted
 *
 * The slip's fields are public, but *pairing* them off-chain leaks a correlation:
 * whoever intercepts a plaintext slip learns that this recipient is expecting this
 * payment. So the slip is sealed toward the recipient with the same ECDH the memo
 * uses. The ephemeral public key travels in the clear inside the envelope; the
 * recipient runs ECDH with their `ivsk` to recover the shared secret, derives the
 * slip key, and opens it. An interceptor without the recipient's `ivsk` sees only
 * random bytes.
 *
 * ## Format
 *
 * Envelope bytes: `ephPk(32) || nonce(8) || ciphertext || MAC(16)`.
 * Cipher: ChaCha20-Poly1305, `slipKey = HKDF(sharedSecret, info="orbinum-payment-slip-v1")`.
 * The wire string is `orbslip1:{base64url(envelope)}:{checksum}` (see
 * `encodePaymentSlip` / `decodePaymentSlip` below).
 */
import { chacha20poly1305 } from '@noble/ciphers/chacha.js';
import { randomBytes } from '@noble/ciphers/utils.js';
import { hkdf } from '@noble/hashes/hkdf.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { packPoint, unpackPoint } from '@zk-kit/baby-jubjub';
import { fastMulBase, fastMulPoint } from '../../foundation/crypto/bjj-fast';
import { bigintTo32Le, bytesToBigintLE } from '../../foundation/encoding/bytes';
import { toHex, isHexOfLength } from '../../foundation/encoding/hex';
import { base64UrlEncode, base64UrlDecode } from '../../foundation/encoding/base64url';
import { bytesToBjjScalar, ENCRYPTED_MEMO_SIZE } from './EncryptedMemo';

// ─── Frozen format constants ─────────────────────────────────────────────────
// Do NOT change after launch without versioning — the golden vector fixes them.

/** HKDF info for the slip cipher key. Distinct domain from the memo's. */
const SLIP_DOMAIN = new TextEncoder().encode('orbinum-payment-slip-v1');
/** 4-byte constant nonce prefix, not transmitted — domain separation at the nonce level. */
const NONCE_PREFIX = new TextEncoder().encode('SLP1');
const EPH_PK_SIZE = 32;
const NONCE_SUFFIX_SIZE = 8;

/** The fields a payment slip carries — all public on-chain. */
export interface PaymentSlipFields {
    /** 0x-prefixed 32-byte LE commitment hex of the recipient output. */
    commitmentHex: string;
    /** 0x-prefixed encrypted memo hex (180 bytes) of the recipient output. */
    encryptedMemo: string;
    /** Merkle leaf index, when known. Informational — spends re-fetch the proof. */
    leafIndex?: number;
    /** Transaction hash of the transfer, when known. Informational — a reference
     *  the recipient can show as proof of the payment; not needed to reconstruct. */
    txHash?: string;
}

/** Derive the 32-byte slip key from the ECDH shared secret. */
function deriveSlipKey(sharedSecret: Uint8Array): Uint8Array {
    return hkdf(sha256, sharedSecret, undefined, SLIP_DOMAIN, 32);
}

/** Build the 12-byte nonce: "SLP1" || suffix(8). Prefix is constant, not stored. */
function buildNonce(suffix: Uint8Array): Uint8Array {
    const nonce = new Uint8Array(12);
    nonce.set(NONCE_PREFIX, 0);
    nonce.set(suffix, 4);
    return nonce;
}

/**
 * Seal slip fields toward a recipient.
 *
 * A fresh ephemeral keypair is generated; `sharedSecret = [ephSk]·recipientIvk`
 * is the ECDH secret only the recipient can reproduce (with their `ivsk`). The
 * ephemeral public key travels in the clear so the recipient can run ECDH.
 *
 * @param recipientIvkPacked  32-byte LE packed BJJ viewing public key of the recipient
 * @param fields              the slip fields to seal
 * @returns envelope: ephPk(32) || nonce_suffix(8) || ciphertext || MAC(16)
 */
export function sealPaymentSlip(
    recipientIvkPacked: Uint8Array,
    fields: PaymentSlipFields
): Uint8Array {
    if (recipientIvkPacked.length !== 32) {
        throw new Error(
            `PaymentSlip: recipientIvk must be 32 bytes, got ${recipientIvkPacked.length}`
        );
    }
    const ivkPoint = unpackPoint(bytesToBigintLE(recipientIvkPacked));
    if (!ivkPoint) throw new Error('PaymentSlip: invalid recipient viewing public key');

    // A fresh ephemeral keypair PER SLIP, never a caller-supplied one.
    //
    // This is what makes the 8-byte nonce suffix safe. Eight random bytes alone
    // would collide by the birthday bound around 2^32 slips, but the key is
    // derived from this ephSk, so every envelope encrypts under a different
    // key — the (key, nonce) pair that ChaCha20-Poly1305 actually requires to
    // be unique cannot repeat. The random suffix is the second layer, not the
    // first. Accepting an ephSk override here would collapse both at once.
    const ephSkScalar = bytesToBjjScalar(randomBytes(32));
    const ephPkPacked = bigintTo32Le(packPoint(fastMulBase(ephSkScalar)) as bigint);

    const sharedPoint = fastMulPoint(ivkPoint, ephSkScalar);
    const sharedSecret = bigintTo32Le(sharedPoint[0]);

    const slipKey = deriveSlipKey(sharedSecret);
    const suffix = randomBytes(NONCE_SUFFIX_SIZE);
    const cipher = chacha20poly1305(slipKey, buildNonce(suffix));
    const plaintext = new TextEncoder().encode(JSON.stringify(fields));
    const sealed = cipher.encrypt(plaintext); // ciphertext || MAC

    const envelope = new Uint8Array(EPH_PK_SIZE + NONCE_SUFFIX_SIZE + sealed.length);
    envelope.set(ephPkPacked, 0);
    envelope.set(suffix, EPH_PK_SIZE);
    envelope.set(sealed, EPH_PK_SIZE + NONCE_SUFFIX_SIZE);
    return envelope;
}

/**
 * Open a payment slip with the recipient's viewing secret key. Returns the fields
 * or null (not ours / corrupt). Never throws — safe in import loops.
 */
export function openPaymentSlip(
    recipientIvsk: Uint8Array,
    envelope: Uint8Array
): PaymentSlipFields | null {
    if (envelope.length < EPH_PK_SIZE + NONCE_SUFFIX_SIZE + 16) return null;
    try {
        const ephPkPacked = envelope.subarray(0, EPH_PK_SIZE);
        const ephPkPoint = unpackPoint(bytesToBigintLE(ephPkPacked));
        if (!ephPkPoint) return null;

        // sharedSecret = [ivsk]·ephPk — the same value the sender computed.
        const ivskScalar = bytesToBjjScalar(recipientIvsk);
        const sharedSecret = bigintTo32Le(fastMulPoint(ephPkPoint, ivskScalar)[0]);

        const slipKey = deriveSlipKey(sharedSecret);
        const suffix = envelope.subarray(EPH_PK_SIZE, EPH_PK_SIZE + NONCE_SUFFIX_SIZE);
        const sealed = envelope.subarray(EPH_PK_SIZE + NONCE_SUFFIX_SIZE);
        const cipher = chacha20poly1305(slipKey, buildNonce(suffix));
        const plaintext = cipher.decrypt(sealed); // throws on MAC failure

        const parsed = JSON.parse(new TextDecoder().decode(plaintext)) as Record<string, unknown>;

        // Rebuild the object field by field instead of returning the parsed one.
        //
        // The MAC proves the sender knew the recipient's viewing key. It does
        // NOT make them honest: whoever was handed a privacy address can seal a
        // slip, so every field below is attacker-chosen data that merely arrived
        // authenticated. Shape is checked here, at the boundary, because past
        // this point the fields are indistinguishable from scanned ones.
        if (!isHexOfLength(parsed['commitmentHex'], 32)) return null;
        if (!isHexOfLength(parsed['encryptedMemo'], ENCRYPTED_MEMO_SIZE)) return null;

        const leafIndex = parsed['leafIndex'];
        if (leafIndex !== undefined && (!Number.isInteger(leafIndex) || (leafIndex as number) < 0))
            return null;

        // A tx hash is displayed — typically as a link into a block explorer —
        // so an unconstrained string here is a script/URL injection that reaches
        // the UI wearing the authority of a decrypted slip. Constrained to the
        // one shape a real hash has; anything else drops the field rather than
        // failing the slip, since the hash is informational and the note behind
        // it is still valid.
        const rawTxHash = parsed['txHash'];
        const txHash = isHexOfLength(rawTxHash, 32) ? (rawTxHash as string) : undefined;

        return {
            commitmentHex: parsed['commitmentHex'] as string,
            encryptedMemo: parsed['encryptedMemo'] as string,
            ...(leafIndex !== undefined ? { leafIndex: leafIndex as number } : {}),
            ...(txHash !== undefined ? { txHash } : {}),
        };
    } catch {
        return null;
    }
}

// ─── Wire format: orbslip1:{payload}:{checksum} ──────────────────────────────

/** URI scheme prefix. The version is in the name, so a v2 reader can refuse a v1. */
export const PAYMENT_SLIP_SCHEME = 'orbslip1:';

/** 8 lowercase hex chars — first 4 bytes of sha256 over the payload. */
function slipChecksum(payload: string): string {
    const digest = sha256(new TextEncoder().encode(PAYMENT_SLIP_SCHEME + payload));
    return toHex(digest.slice(0, 4)).slice(2);
}

/** Encode a sealed slip envelope into a shareable `orbslip1:` string. */
export function encodePaymentSlip(envelope: Uint8Array): string {
    const payload = base64UrlEncode(toHex(envelope));
    return `${PAYMENT_SLIP_SCHEME}${payload}:${slipChecksum(payload)}`;
}

/**
 * Decode an `orbslip1:` string back into the sealed envelope, or null. A wrong
 * scheme, a bad checksum (mistyped/truncated), or malformed payload returns null.
 */
export function decodePaymentSlip(text: string): Uint8Array | null {
    if (!text.startsWith(PAYMENT_SLIP_SCHEME)) return null;
    const rest = text.slice(PAYMENT_SLIP_SCHEME.length);
    const sep = rest.lastIndexOf(':');
    if (sep < 0) return null;
    const payload = rest.slice(0, sep);
    const checksum = rest.slice(sep + 1);
    if (slipChecksum(payload) !== checksum) return null;
    try {
        const hex = base64UrlDecode(payload);
        const clean = hex.startsWith('0x') ? hex.slice(2) : hex;
        if (clean.length % 2 !== 0) return null;
        const bytes = new Uint8Array(clean.length / 2);
        for (let i = 0; i < bytes.length; i++) {
            bytes[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
        }
        return bytes;
    } catch {
        return null;
    }
}
