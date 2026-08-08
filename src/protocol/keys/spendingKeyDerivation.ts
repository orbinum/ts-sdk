/**
 * Deriving the spending key from a wallet signature.
 *
 * Split from `PrivacyKeys` because these two functions are the only ones that
 * take an ADDRESS, and resolving an address to a canonical identifier needs an
 * SS58 decoder — which is `polkadot-api`, a peer dependency.
 *
 * That import used to reach every module importing `PrivacyKeys`, including the
 * decryption kernel, which wants `deriveViewingPublicKey` (pure curve math) and
 * nothing else. The result: `@orbinum/sdk/worker` refused to load without a
 * chain library installed, for a code path a worker never executes.
 *
 * The pure derivations stay in `PrivacyKeys`; anything address-shaped lives here.
 */
import { hkdf } from '@noble/hashes/hkdf.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { fromHex } from '../../foundation/encoding/hex';
import { canonicalAccountId } from './accountIdentity';
import { deriveSpendingKeyFromMaster, KEY_VERSION } from './PrivacyKeys';

/**
 * Shortest signature any supported signer produces: sr25519 VRF output is 32
 * bytes, ed25519 is 64, ECDSA `personal_sign` is 65. Anything shorter is not a
 * signature, so it must never reach the KDF.
 */
export const MIN_SIGNATURE_BYTES = 32;

/**
 * Distinct byte values a real signature must contain.
 *
 * A genuine signature is indistinguishable from random, so 32 bytes carry ~32
 * distinct values and 65 carry ~57. The degenerate inputs this rejects — all
 * zeros, all `0xff`, a short repeated pattern — sit at 1 to 4. The threshold is
 * set far below any real signature and far above any placeholder, so it can
 * never reject a valid one.
 */
const MIN_DISTINCT_BYTES = 8;

/**
 * Rejects input that is not a real signature before it seeds the identity.
 *
 * HKDF accepts ANY input, including all-zero bytes, so without this a stub
 * signature still yields a perfectly usable spending key — one derived entirely
 * from PUBLIC inputs (chainId, address), which means anyone who knows the
 * account can reproduce it and spend whatever the user shielded into it.
 *
 * Length alone does not establish that. A wallet returning 65 zero bytes, an
 * error string padded to signature length, or a fixed placeholder all clear a
 * length check while carrying no secret at all — so the entropy of the bytes is
 * checked too.
 *
 * This is a sanity gate, not a randomness test: it catches the placeholder-
 * shaped failures a broken or hostile signer actually produces. A signer that
 * returns plausible-looking but attacker-chosen bytes is outside what any local
 * check can detect.
 *
 * Fail closed: an unusable signature is a bug or a hostile signer, never a
 * degraded-but-acceptable identity.
 */
function assertUsableSignature(sigBytes: Uint8Array): void {
    if (sigBytes.length < MIN_SIGNATURE_BYTES) {
        throw new Error(
            `Cannot derive a spending key: signature is ${sigBytes.length} bytes, ` +
                `expected at least ${MIN_SIGNATURE_BYTES}. The wallet did not return a signature.`
        );
    }

    const distinct = new Set(sigBytes).size;
    if (distinct < MIN_DISTINCT_BYTES) {
        throw new Error(
            `Cannot derive a spending key: signature contains only ${distinct} distinct byte ` +
                'value(s), so it is a placeholder rather than a signature. Deriving from it ' +
                'would produce a key reproducible by anyone who knows this account.'
        );
    }
}

/**
 * Derives the 32-byte master key bytes from a wallet signature.
 *
 * masterBytes = HKDF-SHA256(ikm=sigBytes, salt=empty, info="orbinum-sk-v2:{chainId}:{address}")
 *
 * These bytes are the stable root for ALL derived keys:
 *   - spendingKey (circuit scalar) = BigInt(masterBytes) % BABYJUB_SUBORDER
 *   - viewingSecretKey              = HKDF(bigintTo32Le(spendingKey), info="orbinum-ivk-v1")
 *   - vaultKey                     = HKDF(masterBytes, info="orbinum-vault-key-v1")
 *
 * Separating masterBytes from the circuit scalar means the viewingSecretKey and
 * vault key are STABLE across any future change to the modulus — they never
 * depend on which prime field the circuit uses.
 *
 * @throws If the signature is not valid hex, or carries less entropy than the
 *         shortest real signing scheme (see {@link MIN_SIGNATURE_BYTES}).
 */
export async function deriveMasterKeyBytes(
    signatureHex: string,
    chainId: number,
    address: string
): Promise<Uint8Array> {
    const sigBytes = fromHex(signatureHex);
    assertUsableSignature(sigBytes);
    const info = new TextEncoder().encode(
        `orbinum-sk-${KEY_VERSION}:${chainId}:${canonicalAccountId(address)}`
    );
    return hkdf(sha256, sigBytes, new Uint8Array(0), info, 32);
}

/**
 * Derives an Orbinum spending key from a wallet signature.
 *
 * Uses HKDF-SHA256(ikm=sigBytes, salt=empty, info="orbinum-sk-v2:{chainId}:{address}")
 * and reduces the resulting 32-byte value modulo BABYJUB_SUBORDER.
 *
 * IMPORTANT: viewingSecretKey and vaultKey must be derived from masterBytes (via
 * deriveMasterKeyBytes), NOT from this spending key scalar. This ensures those
 * keys remain stable if the circuit's modulus ever changes again.
 *
 * @param signatureHex  0x-prefixed or bare hex of the wallet signature.
 * @param chainId       Chain ID used when building the signing message.
 * @param address       Signer address (EVM or SS58) used in the signing message.
 * @returns bigint in [1, BABYJUB_SUBORDER)
 * @throws If the signature is not valid hex or is shorter than
 *         {@link MIN_SIGNATURE_BYTES} — see `deriveMasterKeyBytes`.
 */
export async function deriveSpendingKeyFromSignature(
    signatureHex: string,
    chainId: number,
    address: string
): Promise<bigint> {
    return deriveSpendingKeyFromMaster(await deriveMasterKeyBytes(signatureHex, chainId, address));
}
