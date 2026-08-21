/**
 * PrivacyKeyManager
 *
 * In-memory manager for the user's Orbinum shielded-pool identity.
 * Protocol-level module — no UI, no localStorage, no sessionStorage dependencies.
 *
 * Create one instance per user session:
 *   const pkm = new PrivacyKeyManager();
 *   await pkm.load(spendingKey, masterBytes);
 *
 * The caller (application layer) is responsible for key persistence and session
 * caching. Each instance holds independent state — safe for multi-wallet use.
 *
 * Derivation scheme (from wallet signature) — every branch hangs off the root:
 *   sig → HKDF → masterBytes (32 bytes, stable root for all derived keys)
 *     ├── spendingKey       = HKDF(masterBytes, info="orbinum-spend-v3")  (circuit scalar)
 *     ├── viewingSecretKey  = HKDF(masterBytes, info="orbinum-ivk-v3")  ← delegable
 *     ├── outgoingViewingKey= HKDF(masterBytes, info="orbinum-ovk-v3")  ← own-payment recovery
 *     ├── viewingPublicKey  = packPoint(BJJ_mul(Base8, ivsk_scalar))  ← in the privacy address
 *     ├── ownerPk           = BabyJubJub Ax from (spendingKey × Base8)
 *     └── vaultKey          = HKDF(masterBytes, info="orbinum-vault-key-v1")  ← stable
 *
 * The branches are DISJOINT: knowing one reveals nothing about the others, so a
 * viewing key can be handed out without handing out the ability to spend.
 *
 * Cache format: "mk:0x{masterBytes_hex}" — storing masterBytes (not the sk scalar)
 * ensures the vault key remains stable if the circuit modulus ever changes.
 */

import { sha256 } from '@noble/hashes/sha2.js';
import {
    deriveViewingPublicKey,
    deriveOwnerPk,
    deriveSpendingKeyV3,
    deriveViewingSecretKeyV3,
    deriveOutgoingViewingKeyV3,
} from './PrivacyKeys';
import type { IdentityVersion } from './PrivacyKeys';
import { toHex, scalarToHex, isHexOfLength, fromHex } from '../../foundation/encoding/hex';
import { bigintTo32Le, bytesToBigintLE } from '../../foundation/encoding/bytes';
import { unpackUsableViewingKey } from '../../foundation/crypto/bjj';
import { assertSecretKeyBytes } from '../../foundation/crypto/keyGuards';

// ─── Privacy address checksum ──────────────────────────────────────────────────
// A privacy address travels by copy/paste and QR. `orbpriv1` had no integrity
// check, so a single corrupted character still parsed — and a payment built on a
// mangled ownerPk lands in a note nobody can ever spend. `orbpriv2` appends a
// checksum: the first 4 bytes of sha256 over the "orbpriv2:{ownerPk}:{ivk}" body,
// as 8 lowercase hex chars. One flipped character fails to parse instead of
// silently burning funds. The field semantics are unchanged from v1 — ownerPk is
// still the BJJ x-coordinate scalar, ivk still the packed LE point — so notes and
// the circuit are untouched.

/**
 * The scheme prefix is also the DERIVATION version.
 *
 * Two schemes produce different keys for the same account, and the fields look
 * identical — two scalars either way. Without the prefix saying which, a stale
 * `orbpriv2:` address copied from before a migration still parses, still looks
 * valid, and pays into notes the newer wallet never scans for. The prefix is
 * the only place that distinction fits without changing the field layout.
 */
const SCHEME_BY_VERSION = { v2: 'orbpriv2', v3: 'orbpriv3' } as const;

/**
 * Every address scheme this decoder still READS.
 *
 * Reading an old address is not the same as supporting the old identity: an
 * address is just an owner key plus a viewing key, and paying one works no
 * matter which scheme derived it. Only `orbpriv3` is ever EMITTED — see
 * `encodePrivacyAddress`.
 */
export type PrivacyAddressScheme = 'orbpriv1' | 'orbpriv2' | 'orbpriv3';

/**
 * The fields an address may carry, checked before it is ever used.
 *
 * The checksum is UNKEYED, so it proves the address was not corrupted in
 * transit and nothing more: anyone can mint a matching one for any body. The
 * only thing standing between a pasted string and the note builder is this.
 *
 * Two failures it exists to stop, both silent:
 *
 *   - a NON-HEX field flows out of here as a string a host will hand to
 *     `fromHex`, which throws somewhere far from the paste that caused it;
 *   - an ALL-ZERO viewing key is the wire convention for a PUBLIC note
 *     (`EncryptedMemo.encrypt` reads it as "no recipient": zero shared secret,
 *     zero ephPk). A well-formed address advertising one makes the sender
 *     publish an unencrypted memo while believing they paid privately. That is
 *     a privacy bypass triggered by a pasted address, so it is rejected here.
 *
 * Case is normalised rather than accepted as-is: hashing the body as given
 * would mint two valid, byte-different addresses for one identity, and any
 * host deduplicating addresses by string would treat them as two recipients.
 */
function usableAddressFields(
    ownerPkHex: string,
    ivkHex: string
): { ownerPkHex: string; viewingPublicKeyHex: string } | null {
    const ownerPk = ownerPkHex.toLowerCase();
    const ivk = ivkHex.toLowerCase();
    if (!isHexOfLength(ownerPk, 32) || !isHexOfLength(ivk, 32)) return null;
    // An all-zero ownerPk is no identity either — nobody can spend a note
    // committed to it.
    if (/^0x0+$/.test(ownerPk) || /^0x0+$/.test(ivk)) return null;
    // The zero test is necessary and NOT sufficient. BabyJubJub has cofactor 8,
    // so a viewing key from the small subgroup makes every ECDH against it take
    // at most 8 values, and a memo sealed toward such an address is readable by
    // anyone who tries them. That key need not look degenerate: the all-zero
    // PACKED value is a real point of order 4, which this regex passes.
    //
    // Refused at the address boundary as well as at the sealing ones, because an
    // address is what a stranger hands over — it is the only one of the three an
    // attacker chooses freely.
    // Parsed LE, matching how the packed key is transported. `BigInt(hex)` reads
    // BIG-endian and would validate a different point than the one that gets
    // used — passing garbage and rejecting good keys, both silently.
    if (!unpackUsableViewingKey(bytesToBigintLE(fromHex(ivk)))) return null;
    return { ownerPkHex: ownerPk, viewingPublicKeyHex: ivk };
}

function privacyAddressChecksum(scheme: string, ownerPkHex: string, ivkHex: string): string {
    // The scheme is INSIDE the checksummed body, so an address cannot be
    // relabelled from one version to another without breaking the checksum.
    const body = `${scheme}:${ownerPkHex}:${ivkHex}`;
    const digest = sha256(new TextEncoder().encode(body));
    return toHex(digest.slice(0, 4)).slice(2); // drop the "0x" prefix
}

// ─── State ────────────────────────────────────────────────────────────────────

interface PrivacyKeyState {
    spendingKey: bigint | null;
    masterBytes: Uint8Array | null;
    /** 32-byte HKDF viewing secret key (ivsk). Never exposed in addresses. */
    viewingSecretKey: Uint8Array | null;
    /** 32-byte LE-encoded packed BJJ viewing public key (ivk). Embedded in privacy addresses. */
    viewingPublicKeyPacked: Uint8Array | null;
    ownerPk: bigint | null;
}

// ─── PrivacyKeyManager ────────────────────────────────────────────────────────

export class PrivacyKeyManager {
    private _state: PrivacyKeyState = {
        spendingKey: null,
        masterBytes: null,
        viewingSecretKey: null,
        viewingPublicKeyPacked: null,
        ownerPk: null,
    };

    /**
     * Load a spending key and its corresponding master bytes into the in-memory session.
     * Derives viewingSecretKey, viewingPublicKeyPacked, and ownerPk immediately.
     * Replaces any previously loaded key.
     *
     * @param _legacySpendingKey  IGNORED. Kept so v2-era callers still compile;
     *                             the scalar is re-derived from `masterBytes`.
     * @param masterBytes  Raw 32-byte HKDF output. The root every v3 branch and
     *                     the stable vault key hang off.
     */
    async load(_legacySpendingKey: bigint, masterBytes: Uint8Array): Promise<void> {
        // Derived from the MASTER, not from the scalar the caller passes.
        //
        // Under v2 the viewing key hung off the spending key, so a caller could
        // hand over the scalar alone. v3 branches are siblings of the root:
        // there is no way to reach the viewing key from the spending key, and
        // deriving it that way would produce a DIFFERENT identity from the one
        // `OrbinumWallet` opens under the same master — two identities from one
        // signature, each holding notes the other cannot see.
        //
        // The first parameter is kept so existing callers still compile, and
        // ignored so they cannot be wrong.
        const spendingKey = deriveSpendingKeyV3(masterBytes);
        const viewingSecretKey = deriveViewingSecretKeyV3(masterBytes);
        const viewingPublicKeyPacked = deriveViewingPublicKey(viewingSecretKey);
        const ownerPk = deriveOwnerPk(spendingKey);
        this._state = {
            spendingKey,
            masterBytes,
            viewingSecretKey,
            viewingPublicKeyPacked,
            ownerPk,
        };
    }

    /** Clear all key material from memory. Call on vault lock / sign-out. */
    clear(): void {
        this._state = {
            spendingKey: null,
            masterBytes: null,
            viewingSecretKey: null,
            viewingPublicKeyPacked: null,
            ownerPk: null,
        };
    }

    /** Returns true if a spending key has been loaded. */
    isLoaded(): boolean {
        return this._state.spendingKey !== null;
    }

    /** Returns the spending key. Throws if not loaded. */
    getSpendingKey(): bigint {
        if (this._state.spendingKey === null) {
            throw new Error('PrivacyKeyManager: no key loaded. Call load() first.');
        }
        return this._state.spendingKey;
    }

    /**
     * Returns the 32-byte viewing secret key (ivsk).
     * Used internally for decrypting received notes during rescan.
     * SECURITY: never expose this in addresses or network requests.
     * Throws if not loaded.
     */
    getViewingSecretKey(): Uint8Array {
        if (this._state.viewingSecretKey === null) {
            throw new Error('PrivacyKeyManager: no key loaded. Call load() first.');
        }
        return this._state.viewingSecretKey;
    }

    /**
     * Returns the 32-byte LE-encoded packed BJJ viewing public key (ivk).
     * This is the component embedded in the privacy address and passed to senders
     * so they can encrypt memos only the recipient can decrypt.
     * Throws if not loaded.
     */
    getViewingPublicKeyPacked(): Uint8Array {
        if (this._state.viewingPublicKeyPacked === null) {
            throw new Error('PrivacyKeyManager: no key loaded. Call load() first.');
        }
        return this._state.viewingPublicKeyPacked;
    }

    /**
     * The OUTGOING viewing key (ovk) — reads what this wallet SENT.
     *
     * Seeds the outgoing ephemeral sequence and opens the recipient book, so a
     * holder can enumerate every payment the wallet made and name who received
     * it. That makes it strictly more sensitive than the incoming viewing key,
     * which yields amounts and no counterparties: hand it out only where the
     * payment graph is meant to travel with it.
     *
     * A scan without it still finds every note the wallet OWNS and simply
     * reconstructs no sent history — the watch-only case.
     *
     * SECURITY: never expose this in an address or a network request.
     * Throws if not loaded.
     */
    getOutgoingViewingKey(): Uint8Array {
        return deriveOutgoingViewingKeyV3(this.getMasterBytes());
    }

    /** Returns the BabyJubJub owner public key (x-coordinate). Throws if not loaded. */
    getOwnerPk(): bigint {
        if (this._state.ownerPk === null) {
            throw new Error('PrivacyKeyManager: no key loaded. Call load() first.');
        }
        return this._state.ownerPk;
    }

    /** Returns the spending key as a 32-byte little-endian Uint8Array. Throws if not loaded. */
    getSpendingKeyBytes(): Uint8Array {
        return bigintTo32Le(this.getSpendingKey());
    }

    /**
     * Returns the 32-byte master key bytes (pre-modulus HKDF output).
     * Used to derive the stable vault AES key. Throws if not loaded.
     */
    getMasterBytes(): Uint8Array {
        if (this._state.masterBytes === null) {
            throw new Error('PrivacyKeyManager: no key loaded. Call load() first.');
        }
        return this._state.masterBytes;
    }

    /**
     * Exports the master key bytes as a "mk:0x{hex}" string.
     * Storing masterBytes (not the sk scalar) ensures the vault key and
     * rescan can always be reconstructed regardless of any future modulus change.
     * Throws if not loaded.
     */
    exportHex(): string {
        const mb = this.getMasterBytes();
        return 'mk:' + toHex(mb);
    }

    /**
     * Exports a shareable privacy address encoding the owner public key and
     * viewing PUBLIC key of the currently loaded identity.
     *
     * Format: `orbpriv3:{ownerPk_hex}:{viewingPublicKey_hex}:{checksum}`
     *
     * The recipient uses this address so the sender can:
     *  1. Embed `ownerPk` in the note commitment (Poseidon4 input).
     *  2. Encrypt the memo via ECDH with the recipient's `viewingPublicKey`.
     *
     * The trailing checksum (see `privacyAddressChecksum`) makes a corrupted
     * paste fail to decode rather than pay into an unspendable note.
     *
     * SECURITY: Only the viewing PUBLIC key is embedded — the viewing secret key
     * (used for decryption) is never exported. Holders of this address cannot
     * decrypt the recipient's notes.
     *
     * Throws if no key is loaded.
     */
    encodePrivacyAddress(version: IdentityVersion = 'v3'): string {
        const ownerPk = this.getOwnerPk();
        const ivkPacked = this.getViewingPublicKeyPacked();
        const ownerPkHex = scalarToHex(ownerPk);
        const ivkHex = toHex(ivkPacked);
        const scheme = SCHEME_BY_VERSION[version];
        const checksum = privacyAddressChecksum(scheme, ownerPkHex, ivkHex);
        return `${scheme}:${ownerPkHex}:${ivkHex}:${checksum}`;
    }

    /**
     * Decode a privacy address into `{ ownerPkHex, viewingPublicKeyHex }`, or
     * `null` if it does not parse.
     *
     * Reads every scheme ever emitted; only `orbpriv3` is written.
     *
     *  - `orbpriv3` / `orbpriv2` — checksum verified; a mismatch (corrupted
     *    paste, or a relabelled prefix) returns null.
     *  - `orbpriv1` — legacy, predates the checksum entirely. The FIELDS are
     *    validated exactly as above, since this branch has no integrity check
     *    of its own.
     *
     * Reading an old address is not the same as supporting an old identity. An
     * address is an owner key and a viewing key; paying one works whatever
     * scheme derived it, and whoever shares it may not have upgraded yet.
     * Refusing them here would break incoming payments for no gain.
     */
    static decodePrivacyAddress(
        address: string
    ): { ownerPkHex: string; viewingPublicKeyHex: string; scheme: PrivacyAddressScheme } | null {
        const parts = address.split(':');

        for (const version of ['v2', 'v3'] as const) {
            if (parts[0] !== SCHEME_BY_VERSION[version]) continue;
            // [scheme, ownerPkHex, ivkHex, checksum]
            if (parts.length !== 4) return null;
            const [, ownerPkHex, viewingPublicKeyHex, checksum] = parts;
            if (!ownerPkHex || !viewingPublicKeyHex || !checksum) return null;
            if (
                privacyAddressChecksum(
                    SCHEME_BY_VERSION[version],
                    ownerPkHex,
                    viewingPublicKeyHex
                ) !== checksum
            ) {
                return null;
            }
            const fields = usableAddressFields(ownerPkHex, viewingPublicKeyHex);
            return fields ? { ...fields, scheme: SCHEME_BY_VERSION[version] } : null;
        }

        if (parts[0] === 'orbpriv1') {
            // ["orbpriv1", ownerPkHex, ivkHex] — legacy, and it predates the
            // checksum entirely. Still read so addresses shared before v2
            // resolve, but the FIELDS are validated exactly as above: this
            // branch has no integrity check at all, so it is the easiest way to
            // smuggle a zero viewing key past the scheme.
            //
            // Reported as `orbpriv1`, the scheme actually spelled by the
            // prefix — a caller switching on it needs the wire form, not a
            // guess at which derivation produced it.
            if (parts.length !== 3) return null;
            const [, ownerPkHex, viewingPublicKeyHex] = parts;
            if (!ownerPkHex || !viewingPublicKeyHex) return null;
            const fields = usableAddressFields(ownerPkHex, viewingPublicKeyHex);
            return fields ? { ...fields, scheme: 'orbpriv1' } : null;
        }

        return null;
    }

    /**
     * Load keys from a cached "mk:0x{masterBytes_hex}" string produced by exportHex().
     *
     * Throws on a bad prefix, on non-hex content, and on a master that is not
     * 32 usable bytes — an all-zero one included, since every wallet would
     * derive the same identity from it.
     */
    async importFromHex(hex: string): Promise<void> {
        if (!hex.startsWith('mk:')) {
            throw new Error(
                'PrivacyKeyManager: invalid cache format. Expected "mk:0x{masterBytes_hex}".'
            );
        }
        // `fromHex`, not a hand-rolled parse: `parseInt('zz', 16)` is NaN and
        // `Uint8Array` silently stores that as 0, so a corrupted cache decoded
        // to 32 zero bytes — the right LENGTH, so the check below passed, and a
        // wallet unlocked on an all-zero master every other wallet also derives.
        const masterBytes = fromHex(hex.slice(3));
        assertSecretKeyBytes(masterBytes, 'PrivacyKeyManager: master');
        // The scalar is not computed here: `load` derives it from the master
        // through the v3 branch, and computing it with the v2 formula only to
        // have it ignored left a second definition of "the spending key".
        await this.load(0n, masterBytes);
    }
}
