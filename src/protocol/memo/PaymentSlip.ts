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
 * ## What the MAC does NOT prove
 *
 * It proves the sender knew the recipient's viewing key — nothing about the
 * fields being true. Anyone handed a privacy address can seal a slip, so what
 * comes out of `openPaymentSlip` is attacker-chosen data that merely arrived
 * authenticated, and past that point it is indistinguishable from a field the
 * wallet scanned itself. Hence the shape checks there, at the boundary.
 *
 * A slip that lies about the note itself is caught further in, by two
 * independent defences either of which suffices: the commitment is mixed into
 * the memo's encryption key (`deriveEncryptionKey`), and `tryDecryptNote`
 * recomputes the commitment from the decrypted plaintext.
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
import { isValidLeafIndex } from '../spend/coinSelection';

// ─── Frozen format constants ─────────────────────────────────────────────────
// Do NOT change after launch without versioning — the golden vector fixes them.

/** HKDF info for the slip cipher key. Distinct domain from the memo's. */
const SLIP_DOMAIN = new TextEncoder().encode('orbinum-payment-slip-v1');
/** 4-byte constant nonce prefix, not transmitted — domain separation at the nonce level. */
const NONCE_PREFIX = new TextEncoder().encode('SLP1');
const EPH_PK_SIZE = 32;
const NONCE_SUFFIX_SIZE = 8;

/**
 * Ceiling on an envelope, in bytes.
 *
 * Every field a slip carries is fixed-width, so a full one measures 624 bytes
 * JSON-encoded. The cap sits well above that — it is not a size budget but a
 * refusal to let the SENDER decide how much the recipient decrypts and parses.
 *
 * The wire string is the tighter constraint in practice: 624 bytes encode to
 * ~1685 characters, against the ~1800 a single QR holds at error-correction
 * level M. A new field eats that margin before it eats this one.
 */
const MAX_SLIP_ENVELOPE_SIZE = 4096;

// ─── Fields ──────────────────────────────────────────────────────────────────

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

// ─── Sealing and opening ─────────────────────────────────────────────────────

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
 * Open a payment slip with the recipient's viewing secret key.
 *
 * Returns the fields, or null when the slip is not ours, is corrupt, or carries
 * a field that cannot be what it claims. Never throws: the input is a string a
 * user pasted, and an exception here takes down the paste handler rather than
 * one import.
 *
 * The result is REBUILT field by field rather than returned from `JSON.parse` —
 * see the note on the MAC at the top of this file for why a decrypted slip is
 * still untrusted input.
 */
export function openPaymentSlip(
    recipientIvsk: Uint8Array,
    envelope: Uint8Array
): PaymentSlipFields | null {
    // Both bounds are checked BEFORE any decryption or parsing: the work an
    // oversized envelope costs lands before a single field is ever inspected.
    if (envelope.length < EPH_PK_SIZE + NONCE_SUFFIX_SIZE + 16) return null;
    if (envelope.length > MAX_SLIP_ENVELOPE_SIZE) return null;
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

        // Identity of the note: a wrong value here is not a degraded slip but a
        // different one, so it fails the whole thing.
        if (!isHexOfLength(parsed['commitmentHex'], 32)) return null;
        if (!isHexOfLength(parsed['encryptedMemo'], ENCRYPTED_MEMO_SIZE)) return null;

        // `isValidLeafIndex` is the SDK's one definition of a tree position.
        // A bare `Number.isInteger` would admit 2^53 and 1e300, which the u32
        // index cannot represent.
        const leafIndex = parsed['leafIndex'];
        if (leafIndex !== undefined && !isValidLeafIndex(leafIndex as number)) return null;

        // Informational, and rendered as an explorer link — where an
        // unconstrained string is a URL injection carrying the authority of a
        // slip the recipient just decrypted. DROPPED rather than fatal: the note
        // behind it is still valid without the reference.
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

/**
 * 8 lowercase hex chars — first 4 bytes of sha256 over the payload.
 *
 * A typo/truncation check for a string humans copy around, NOT authentication:
 * anyone can recompute it over bytes they chose. Tampering is caught by the
 * envelope's MAC, which needs the recipient's viewing key.
 */
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
