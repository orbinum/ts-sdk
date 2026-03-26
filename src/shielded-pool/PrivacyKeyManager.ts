/**
 * PrivacyKeyManager
 *
 * In-memory manager for the user's Orbinum shielded-pool identity.
 * Protocol-level module — no UI, no localStorage, no sessionStorage dependencies.
 *
 * Call `PrivacyKeyManager.load(spendingKey)` after deriving the key from a wallet
 * signature (see `deriveSpendingKeyFromSignature`).  The caller (application layer)
 * is responsible for key persistence and session caching.
 *
 * Derivation scheme:
 *   spendingKey (bigint, BN254 scalar)
 *     └── viewingKey   = HKDF-SHA256(spendingKey_bytes, info="orbinum-ivk-v1")  → 32 bytes
 *     └── ownerPk      = BabyJubJub Ax from (spendingKey * Base8)               → bigint
 */

import { deriveViewingKey, deriveOwnerPk } from './PrivacyKeys';
import { bigintTo32Le } from '../utils/bytes';

// ─── Constants ────────────────────────────────────────────────────────────────

/** BN254 scalar field order */
const BN254_R = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;

// ─── State ────────────────────────────────────────────────────────────────────

interface PrivacyKeyState {
    spendingKey: bigint | null;
    viewingKey: Uint8Array | null;
    ownerPk: bigint | null;
}

let _state: PrivacyKeyState = {
    spendingKey: null,
    viewingKey: null,
    ownerPk: null,
};

// ─── PrivacyKeyManager ────────────────────────────────────────────────────────

export const PrivacyKeyManager = {
    /**
     * Load a spending key into the in-memory session.
     * Derives viewingKey and ownerPk immediately.
     * Replaces any previously loaded key.
     */
    async load(spendingKey: bigint): Promise<void> {
        const viewingKey = deriveViewingKey(spendingKey);
        const ownerPk = deriveOwnerPk(spendingKey);
        _state = { spendingKey, viewingKey, ownerPk };
    },

    /** Clear all key material from memory. Call on vault lock / sign-out. */
    clear(): void {
        _state = { spendingKey: null, viewingKey: null, ownerPk: null };
    },

    /** Returns true if a spending key has been loaded. */
    isLoaded(): boolean {
        return _state.spendingKey !== null;
    },

    /** Returns the spending key. Throws if not loaded. */
    getSpendingKey(): bigint {
        if (_state.spendingKey === null) {
            throw new Error('PrivacyKeyManager: no key loaded. Call load() first.');
        }
        return _state.spendingKey;
    },

    /** Returns the 32-byte viewing key. Throws if not loaded. */
    getViewingKey(): Uint8Array {
        if (_state.viewingKey === null) {
            throw new Error('PrivacyKeyManager: no key loaded. Call load() first.');
        }
        return _state.viewingKey;
    },

    /** Returns the BabyJubJub owner public key (x-coordinate). Throws if not loaded. */
    getOwnerPk(): bigint {
        if (_state.ownerPk === null) {
            throw new Error('PrivacyKeyManager: no key loaded. Call load() first.');
        }
        return _state.ownerPk;
    },

    /** Returns the spending key as a 32-byte little-endian Uint8Array. Throws if not loaded. */
    getSpendingKeyBytes(): Uint8Array {
        return bigintTo32Le(this.getSpendingKey());
    },

    /** Exports the spending key as a 0x-prefixed 64-char hex string. Throws if not loaded. */
    exportHex(): string {
        return '0x' + this.getSpendingKey().toString(16).padStart(64, '0');
    },

    /**
     * Load a spending key from a 0x-prefixed or bare hex string.
     * Validates the key is in the valid range [1, BN254_R).
     */
    async importFromHex(hex: string): Promise<void> {
        const key = BigInt(hex.startsWith('0x') ? hex : '0x' + hex);
        if (key === 0n || key >= BN254_R) {
            throw new Error('PrivacyKeyManager: invalid spending key — out of BN254 range.');
        }
        await this.load(key);
    },
};
