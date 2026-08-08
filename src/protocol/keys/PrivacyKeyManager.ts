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
 * Derivation scheme (from wallet signature):
 *   sig → HKDF → masterBytes (32 bytes, stable root for all derived keys)
 *     ├── spendingKey       = BigInt(masterBytes) % BABYJUB_SUBORDER  (circuit scalar)
 *     ├── viewingSecretKey  = HKDF(bigintTo32Le(spendingKey), info="orbinum-ivk-v1")  ← NEVER shared
 *     ├── viewingPublicKey  = packPoint(BJJ_mul(Base8, ivsk_scalar))  ← embedded in privacy address
 *     ├── ownerPk           = BabyJubJub Ax from (spendingKey × Base8)
 *     └── vaultKey          = HKDF(masterBytes, info="orbinum-vault-key-v1")  ← stable
 *
 * Cache format: "mk:0x{masterBytes_hex}" — storing masterBytes (not the sk scalar)
 * ensures the vault key remains stable if the circuit modulus ever changes.
 */

import { sha256 } from '@noble/hashes/sha2.js';
import { deriveViewingSecretKey, deriveViewingPublicKey, deriveOwnerPk } from './PrivacyKeys';
import { toHex, scalarToHex } from '../../foundation/encoding/hex';
import { bigintTo32Le } from '../../foundation/encoding/bytes';
import { BABYJUB_SUBORDER } from '../../foundation/crypto/constants';

// ─── Privacy address checksum ──────────────────────────────────────────────────
// A privacy address travels by copy/paste and QR. `orbpriv1` had no integrity
// check, so a single corrupted character still parsed — and a payment built on a
// mangled ownerPk lands in a note nobody can ever spend. `orbpriv2` appends a
// checksum: the first 4 bytes of sha256 over the "orbpriv2:{ownerPk}:{ivk}" body,
// as 8 lowercase hex chars. One flipped character fails to parse instead of
// silently burning funds. The field semantics are unchanged from v1 — ownerPk is
// still the BJJ x-coordinate scalar, ivk still the packed LE point — so notes and
// the circuit are untouched.

function privacyAddressChecksum(ownerPkHex: string, ivkHex: string): string {
    const body = `orbpriv2:${ownerPkHex}:${ivkHex}`;
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
     * @param spendingKey  Circuit scalar: BigInt(masterBytes) % BABYJUB_SUBORDER, clamped to [1, ∞).
     * @param masterBytes  Raw 32-byte HKDF output before modular reduction. Used to derive
     *                     the stable vault key (HKDF(masterBytes, info="orbinum-vault-key-v1")).
     */
    async load(spendingKey: bigint, masterBytes: Uint8Array): Promise<void> {
        const viewingSecretKey = deriveViewingSecretKey(spendingKey);
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
     * Format: `orbpriv2:{ownerPk_hex}:{viewingPublicKey_hex}:{checksum}`
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
    encodePrivacyAddress(): string {
        const ownerPk = this.getOwnerPk();
        const ivkPacked = this.getViewingPublicKeyPacked();
        const ownerPkHex = scalarToHex(ownerPk);
        const ivkHex = toHex(ivkPacked);
        const checksum = privacyAddressChecksum(ownerPkHex, ivkHex);
        return `orbpriv2:${ownerPkHex}:${ivkHex}:${checksum}`;
    }

    /**
     * Decode a privacy address into `{ ownerPkHex, viewingPublicKeyHex }`, or
     * `null` if it does not parse.
     *
     * Accepts both:
     *  - `orbpriv2:{ownerPk}:{ivk}:{checksum}` — checksum verified; a mismatch
     *    (corrupted paste) returns null.
     *  - `orbpriv1:{ownerPk}:{ivk}` — legacy, no checksum. Still read so addresses
     *    shared before v2 keep resolving; only v2 is emitted.
     */
    static decodePrivacyAddress(
        address: string
    ): { ownerPkHex: string; viewingPublicKeyHex: string } | null {
        const parts = address.split(':');

        if (parts[0] === 'orbpriv2') {
            // ["orbpriv2", ownerPkHex, ivkHex, checksum]
            if (parts.length !== 4) return null;
            const [, ownerPkHex, viewingPublicKeyHex, checksum] = parts;
            if (!ownerPkHex || !viewingPublicKeyHex || !checksum) return null;
            if (privacyAddressChecksum(ownerPkHex, viewingPublicKeyHex) !== checksum) return null;
            return { ownerPkHex, viewingPublicKeyHex };
        }

        if (parts[0] === 'orbpriv1') {
            // ["orbpriv1", ownerPkHex, ivkHex] — legacy, unchecked.
            if (parts.length !== 3) return null;
            const [, ownerPkHex, viewingPublicKeyHex] = parts;
            if (!ownerPkHex || !viewingPublicKeyHex) return null;
            return { ownerPkHex, viewingPublicKeyHex };
        }

        return null;
    }

    /**
     * Load keys from a cached "mk:0x{masterBytes_hex}" string produced by exportHex().
     * Throws if the format is invalid or masterBytes length is not 32 bytes.
     */
    async importFromHex(hex: string): Promise<void> {
        if (!hex.startsWith('mk:')) {
            throw new Error(
                'PrivacyKeyManager: invalid cache format. Expected "mk:0x{masterBytes_hex}".'
            );
        }
        const raw = hex.slice(3); // strip "mk:"
        const h = raw.startsWith('0x') ? raw.slice(2) : raw;
        const masterBytes = new Uint8Array((h.match(/.{2}/g) ?? []).map((b) => parseInt(b, 16)));
        if (masterBytes.length !== 32) {
            throw new Error('PrivacyKeyManager: invalid master bytes — expected 32 bytes.');
        }
        const masterBigint = BigInt('0x' + h);
        const sk = masterBigint % BABYJUB_SUBORDER || 1n;
        await this.load(sk, masterBytes);
    }
}
