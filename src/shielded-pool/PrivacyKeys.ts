/**
 * PrivacyKeys
 *
 * Pure cryptographic derivation functions for the Orbinum shielded pool identity.
 * These are protocol-level operations — independent of storage, UI, or session.
 *
 * Derivation scheme:
 *   viewingKey = HKDF-SHA256(ikm=spendingKey_bytes, info="orbinum-ivk-v1") → 32 bytes
 *   ownerPk    = BabyJubJub Ax from (spendingKey * Base8)                  → bigint
 *
 * Spending key derivation (from wallet signature):
 *   message    = "orbinum-spending-key-v1\n${chainId}\n${address.toLowerCase()}"
 *   skBytes    = HKDF-SHA256(ikm=sig_bytes, salt=empty, info="orbinum-sk-v1:${chainId}:${address}")
 *   spendingKey = BigInt(skBytes_as_big_endian) % BN254_R  (if 0 → 1)
 *
 * The viewingKey is the symmetric key used by EncryptedMemo (ChaCha20-Poly1305).
 * The ownerPk (x-coordinate) is included in note commitments.
 */

import { hkdf } from '@noble/hashes/hkdf.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { mulPointEscalar, Base8 } from '@zk-kit/baby-jubjub';
import { bigintTo32Le } from '../utils/bytes';
import { BN254_R } from './constants';

const IVK_DOMAIN = new TextEncoder().encode('orbinum-ivk-v1');

// ─── Key derivation from wallet signature ─────────────────────────────────────

/**
 * Returns the message string the user must sign with their wallet to derive
 * a deterministic Orbinum spending key.
 */
export function deriveSpendingKeyMessage(chainId: number, address: string): string {
    return `orbinum-spending-key-v1\n${chainId}\n${address.toLowerCase()}`;
}

/**
 * Derives an Orbinum spending key from a wallet signature.
 *
 * Uses HKDF-SHA256(ikm=sigBytes, salt=empty, info="orbinum-sk-v1:{chainId}:{address}")
 * and reduces the resulting 32-byte value modulo BN254_R.
 *
 * @param signatureHex  0x-prefixed or bare hex of the wallet signature.
 * @param chainId       Chain ID used when building the signing message.
 * @param address       Signer address (EVM or SS58) used in the signing message.
 * @returns bigint in [1, BN254_R)
 */
export async function deriveSpendingKeyFromSignature(
    signatureHex: string,
    chainId: number,
    address: string
): Promise<bigint> {
    const hex = signatureHex.startsWith('0x') ? signatureHex.slice(2) : signatureHex;
    const sigBytes = new Uint8Array((hex.match(/.{2}/g) ?? []).map((b) => parseInt(b, 16)));
    const info = new TextEncoder().encode(`orbinum-sk-v1:${chainId}:${address.toLowerCase()}`);
    const skBytes = hkdf(sha256, sigBytes, new Uint8Array(0), info, 32);
    const skBigint =
        BigInt(
            '0x' +
                Array.from(skBytes)
                    .map((b) => b.toString(16).padStart(2, '0'))
                    .join('')
        ) % BN254_R;
    return skBigint === 0n ? 1n : skBigint;
}

// ─── Key derivation from spending key ─────────────────────────────────────────

/**
 * Derive a 32-byte viewing key from a spending key.
 *   viewingKey = HKDF-SHA256(ikm=spendingKey_bytes, info="orbinum-ivk-v1")
 */
export function deriveViewingKey(spendingKey: bigint): Uint8Array {
    const ikm = bigintTo32Le(spendingKey);
    return hkdf(sha256, ikm, undefined, IVK_DOMAIN, 32);
}

/**
 * Derive the BabyJubJub Ax (x-coordinate of the public key) from a spending key.
 *   ownerPk = (spendingKey * BabyJubJub.Base8)[0]
 *
 * Returns 0n if BabyJubJub computation fails (e.g. invalid scalar).
 */
export function deriveOwnerPk(spendingKey: bigint): bigint {
    try {
        const pubPoint = mulPointEscalar(Base8, spendingKey);
        return pubPoint[0];
    } catch {
        return 0n;
    }
}
