/**
 * Canonical account identifier for spending-key derivation.
 *
 * The address string is load-bearing twice: it goes into the signed payload AND
 * into the HKDF `info`. So whatever identifies the account must be stable for
 * the lifetime of that account — anything else silently rotates the spending key
 * and orphans every note already shielded.
 *
 * SS58 IS NOT STABLE. The same public key encodes to a different string per
 * network prefix:
 *
 *   prefix   42 → 5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY
 *   prefix 2700 → kcuMUgT1VAJR8MtE22C5cmoAR96qsTMLYzmEuyCKUj48jYHqR
 *
 * A wallet that lists an account under the generic prefix today and under the
 * chain's own prefix tomorrow (a wallet setting, a chain-metadata update) would
 * hand us a different string for the same key. Deriving from it directly means
 * the user opens the app to an empty vault with no error and no explanation.
 *
 * So Substrate accounts are identified by their decoded 32-byte public key,
 * which no prefix can change. EVM addresses are already canonical and pass
 * through unchanged.
 */

import { getSs58AddressInfo } from 'polkadot-api';
import { toHex } from '../../foundation/encoding/hex';

/**
 * Reduces an address to the form used for derivation.
 *
 * SS58 → `0x`-prefixed hex of the underlying public key, so every prefix of the
 * same account maps to one identifier. Anything else (EVM `0x…`) is returned
 * lowercased and unchanged.
 *
 * Not a validator: an unrecognised string passes through, because rejecting it
 * here would break EVM callers. The signature guard in `PrivacyKeys` is what
 * fails closed on unusable input.
 */
export function canonicalAccountId(address: string): string {
    const info = getSs58AddressInfo(address);
    return info.isValid ? toHex(info.publicKey) : address.toLowerCase();
}
