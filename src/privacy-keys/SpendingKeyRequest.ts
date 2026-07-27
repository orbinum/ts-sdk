/**
 * SpendingKeyRequest
 *
 * What the user signs to derive their Orbinum spending key, per platform.
 *
 * These builders produce the *request* (typed data or message string). Turning a
 * signature into key material lives in `PrivacyKeys` — the split keeps the
 * platform-specific presentation away from the platform-agnostic KDF.
 *
 * SECURITY MODEL
 *
 * The signature seeds the spending key, so a deterministic signature over a
 * fixed, public string is a bearer token: any dapp the user connects to can
 * request the same string, obtain a byte-identical signature (ECDSA personal_sign
 * is deterministic, RFC-6979) and reconstruct the spending key, viewing key and
 * vault key. That is the v1 flaw these builders exist to close.
 *
 * The defense has two independent layers:
 *
 *   1. Message layer (here) — bind the signature to a domain the user can see.
 *      EVM uses EIP-712, whose domain the wallet renders. Substrate has no
 *      EIP-712, so the warning travels inside the signed text instead. NOTE this
 *      layer is about VISIBILITY, not impossibility: nothing stops a hostile
 *      origin from requesting the same payload, and no wallet verifies that
 *      `verifyingContract` matches the requesting origin.
 *   2. Derivation layer (`PrivacyKeys`) — the HKDF `info` carries the version, so
 *      v1 and v2 are disjoint identities even given identical signature bytes.
 *      This is the layer that holds when layer 1 fails (e.g. a wallet that
 *      truncates the warning text).
 *
 * DETERMINISM IS MANDATORY. No builder may add a nonce, timestamp or challenge:
 * the digest must stay a pure function of (chainId, address). A signature that
 * varies per session yields a different spending key each time, which makes
 * already-shielded notes unspendable — surfacing as an opaque Merkle constraint
 * failure during witness generation.
 */

import { PRECOMPILE_ADDR } from '../precompiles/addresses';

/**
 * EIP-712 `verifyingContract` for spending-key derivation: the shielded pool
 * precompile, i.e. the component that actually custodies shielded funds and so
 * the semantically correct domain anchor.
 *
 * WARNING: this value is part of the EIP-712 digest. Changing it changes every
 * derived spending key and orphans every existing note. It is a protocol
 * constant, not a config knob — which is why it is re-exported from the single
 * `PRECOMPILE_ADDR` source rather than written out a second time.
 */
export const SPENDING_KEY_VERIFYING_CONTRACT = PRECOMPILE_ADDR.SHIELDED_POOL;

/**
 * Shown to the user inside the wallet prompt. Wallets render EIP-712 message
 * fields (and Substrate raw text) verbatim, so this is the one surface a hostile
 * origin can neither suppress nor reword.
 */
export const SPENDING_KEY_WARNING =
    'Signing this grants full control of your Orbinum private funds. ' +
    'Only sign on the official Orbinum app.';

/** EIP-712 payload for `eth_signTypedData_v4`. */
export interface SpendingKeyTypedData {
    domain: {
        name: string;
        version: string;
        chainId: number;
        verifyingContract: string;
    };
    types: {
        SpendingKeyDerivation: ReadonlyArray<{ name: string; type: string }>;
    };
    primaryType: 'SpendingKeyDerivation';
    message: {
        warning: string;
        account: string;
    };
}

/**
 * EIP-712 typed data the user signs to derive their spending key (EVM route).
 * Pass the result to `eth_signTypedData_v4`.
 *
 * @param chainId Chain the identity belongs to; part of the domain separator.
 * @param address Signer address. Lowercased so checksum casing cannot fork the
 *                identity into two distinct keys for the same account.
 */
export function deriveSpendingKeyTypedData(chainId: number, address: string): SpendingKeyTypedData {
    return {
        domain: {
            name: 'Orbinum Shielded Pool',
            version: '2',
            chainId,
            verifyingContract: SPENDING_KEY_VERIFYING_CONTRACT,
        },
        types: {
            SpendingKeyDerivation: [
                { name: 'warning', type: 'string' },
                { name: 'account', type: 'address' },
            ],
        },
        primaryType: 'SpendingKeyDerivation',
        message: {
            warning: SPENDING_KEY_WARNING,
            account: address.toLowerCase(),
        },
    };
}

/**
 * Message the user signs on signers without EIP-712 (Substrate: sr25519 via VRF,
 * ed25519 via signRaw).
 *
 * Substrate wallets render the raw string, so the warning leads the text — it is
 * the only channel a malicious extension cannot rewrite. Its protection is
 * therefore conditional on the wallet not truncating the message; when it does,
 * only the HKDF domain separation in `PrivacyKeys` still applies.
 */
export function deriveSpendingKeyMessageV2(chainId: number, address: string): string {
    return (
        `⚠ ${SPENDING_KEY_WARNING}\n\n` +
        `orbinum-spending-key-v2\n${chainId}\n${address.toLowerCase()}`
    );
}
