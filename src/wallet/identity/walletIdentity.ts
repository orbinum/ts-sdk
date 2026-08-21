/**
 * The set of keys a wallet is unlocked as.
 *
 * The branches are SIBLINGS of a root, not a chain, so no one of them derives
 * another and the wallet has to hold each one it needs:
 *
 *   - `spendingKey` — authorises a spend, and does NOT decrypt. The scalar that
 *     spends a received note is `deriveStealthSk(sharedSecret, …)`, and the
 *     shared secret comes from the viewing key: spending needs both.
 *   - `viewingSecretKey` — reads what arrives, and seeds `selfEph`, so it also
 *     finds the wallet's own notes.
 *   - `outgoingViewingKey` — reads what was SENT: seeds the outgoing ephemerals
 *     and opens the recipient book. Strictly more sensitive than the incoming
 *     key — it yields the payment GRAPH, not just amounts — so it is optional,
 *     letting a watch-only wallet be handed everything except this.
 *
 * The root is not a field: it reconstructs every branch, spending key included,
 * so keeping it here would make the separation decorative. Consumed and dropped.
 */
import {
    deriveOwnerPk,
    deriveSpendingKeyV3,
    deriveViewingPublicKey,
    deriveViewingSecretKeyV3,
    deriveOutgoingViewingKeyV3,
} from '../../protocol/keys/PrivacyKeys';
import type { IdentityVersion } from './vaultName';

export interface WalletIdentity {
    version: IdentityVersion;
    spendingKey: bigint;
    ownerPk: bigint;
    viewingSecretKey: Uint8Array;
    viewingPublicKey: Uint8Array;
    /** Absent on a watch-only identity, which is handed everything except this. */
    outgoingViewingKey?: Uint8Array;
}

/**
 * Assemble the identity. v3 is the only scheme.
 *
 * Throws on a root that is not 32 bytes or is all zeros. Neither is an error the
 * derivation itself would raise: the branches are pure HKDF, so they answer for
 * ANY input — an empty one included — with a complete, deterministic and
 * publicly derivable identity. This is the only place that catches a caller who
 * wired the root from something that was not there.
 *
 * Nothing migrates from an older scheme: a note is committed on chain under the
 * `ownerPk` inside the Merkle tree, so re-deriving an identity does not move it,
 * it orphans it. Holders unshield first.
 *
 * @param rootSecret 32 bytes — the master key material. Not retained.
 */
export function deriveIdentity(rootSecret: Uint8Array, version: IdentityVersion): WalletIdentity {
    if (rootSecret.length !== 32) {
        throw new Error(`deriveIdentity: rootSecret must be 32 bytes, got ${rootSecret.length}`);
    }
    if (rootSecret.every((b) => b === 0)) {
        throw new Error('deriveIdentity: rootSecret is all zeros — every wallet would share it');
    }

    if (version !== 'v3') {
        // Unreachable from TypeScript, reachable from JavaScript — which is what
        // it is for. The label picks the vault name and the cache key, so an
        // unknown string that fell through would derive the RIGHT keys and open
        // the wrong, empty vault.
        throw new Error(`deriveIdentity: unknown identity version ${String(version)}`);
    }

    const spendingKey = deriveSpendingKeyV3(rootSecret);
    const viewingSecretKey = deriveViewingSecretKeyV3(rootSecret);
    return {
        version,
        spendingKey,
        ownerPk: deriveOwnerPk(spendingKey),
        viewingSecretKey,
        viewingPublicKey: deriveViewingPublicKey(viewingSecretKey),
        outgoingViewingKey: deriveOutgoingViewingKeyV3(rootSecret),
    };
}

/**
 * What a watch-only holder is given: read access, no spend authority.
 *
 * The spending key is absent by TYPE, not by a runtime check — a credential
 * cannot be passed where a spend needs one.
 *
 * `includeOutgoing` is opt-in and stays that way: the incoming key reveals what
 * arrived, the outgoing one reveals who was PAID. Bundling them by default would
 * hand the payment graph to anyone granted a look at the balance.
 */
export interface ViewingCredential {
    version: IdentityVersion;
    ownerPk: bigint;
    viewingSecretKey: Uint8Array;
    viewingPublicKey: Uint8Array;
    outgoingViewingKey?: Uint8Array;
}

export function exportViewingCredential(
    identity: WalletIdentity,
    options: { includeOutgoing?: boolean } = {}
): ViewingCredential {
    // COPIED, not aliased: a credential leaves this process — a file, a worker,
    // a host that may zero its buffers when done. A live array would let any of
    // that reach back into the unlocked wallet, surfacing as notes that stop
    // decrypting rather than as an error.
    return {
        version: identity.version,
        ownerPk: identity.ownerPk,
        viewingSecretKey: Uint8Array.from(identity.viewingSecretKey),
        viewingPublicKey: Uint8Array.from(identity.viewingPublicKey),
        ...(options.includeOutgoing && identity.outgoingViewingKey
            ? { outgoingViewingKey: Uint8Array.from(identity.outgoingViewingKey) }
            : {}),
    };
}
