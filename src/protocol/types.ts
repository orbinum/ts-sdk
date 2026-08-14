/**
 * What a note IS.
 *
 * The protocol's own vocabulary: a note, the inputs that build one, and the
 * plaintext recovered from its memo. Nothing here describes an extrinsic — the
 * argument shapes the pallet accepts live in `pallet/extrinsicParams.ts`,
 * because a wallet can build, decrypt and select notes without ever submitting
 * anything.
 */

/** On-chain Merkle tree state for the shielded pool. */
export type MerkleTreeInfo = {
    /** 0x-prefixed current Merkle root hex. */
    root: string;
    /** Number of leaves (commitments) inserted so far. */
    treeSize: number;
    /** Tree depth (levels from leaf to root). */
    depth: number;
};

/** A commitment surfaced by the indexer scan feed, for trial-decryption. */
export type ScanCommitment = {
    /** 0x-prefixed 32-byte commitment hex. */
    commitmentHex: string;
    /** Leaf position of the commitment in the Merkle tree. */
    leafIndex: number;
    /** 0x-prefixed encrypted memo hex, or null if none was published. */
    encryptedMemo: string | null;
};

/** Plaintext fields recovered from a note's encrypted memo. */
export type DecryptedMemo = {
    /** Note amount in planck. */
    value: bigint;
    /** Owner's BabyJubJub Ax coordinate. */
    ownerPk: bigint;
    /** Blinding scalar used in the commitment. */
    blinding: bigint;
    /** Asset ID of the note. */
    assetId: bigint;
    /** Counterparty BabyJubJub Ax coordinate. Zero for shield/unshield notes. */
    sourcePk: bigint;
    /** ZK circuit version the note is spent under, recovered from the memo plaintext. */
    circuitVersion: number;
};

/** Input params for NoteBuilder.build(). All fields except value have defaults. */
export type NoteInput = {
    /** Amount in planck (required). */
    value: bigint;
    /** Asset ID — default 0 (native ORB-Privacy). */
    assetId?: bigint;
    /** BabyJubJub Ax coordinate (owner public key x). Default 0n. */
    ownerPk?: bigint;
    /** Random blinding scalar. Defaults to BigInt(Date.now()). */
    blinding?: bigint;
    /** Secret spending key used to derive the nullifier. Default 0n. */
    spendingKey?: bigint;
    /**
     * 32-byte LE-encoded packed BJJ viewing public key of the recipient (from their privacy address).
     * When provided, NoteBuilder.build() will auto-generate the 180-byte ECDH-encrypted memo.
     * Omit to skip memo generation (use buildMemo() separately if needed).
     */
    viewingPublicKey?: Uint8Array;
    /**
     * BabyJubJub Ax coordinate of the recipient (from their privacy address).
     * Required together with viewingPublicKey to enable stealth address derivation:
     * the commitment will use stealthOwnerPk instead of ownerPk, making each
     * transaction unlinkable even when the same privacy address is reused.
     */
    recipientOwnerPk?: bigint;
    /** Counterparty BabyJubJub Ax coordinate. Zero for shield/unshield notes. Default 0n. */
    sourcePk?: bigint;
    /** Circuit version to stamp on the note. Defaults to `CURRENT_CIRCUIT_VERSION`. */
    circuitVersion?: number;
    /**
     * 32-byte ephemeral secret for the memo ECDH. Default: random.
     *
     * Two callers supply one, and both do it so the RECIPIENT can predict the
     * published ephPk and match it by table lookup instead of one trial ECDH per
     * pool hint: self-notes pass `deriveSelfEphSk`, and a payment to a known
     * counterparty passes `derivePairwiseEphSk`.
     *
     * Honoured on the stealth path too, where the same ephSk drives both the
     * memo encryption and the stealth-owner derivation. Passing one is a promise
     * that the value is unique — reusing it republishes an ephPk and links the
     * two notes in public.
     */
    ephSkOverride?: Uint8Array;
    /**
     * Sender's 32-byte outgoing viewing key (ovk). When present on the stealth
     * path, `build()` seals the memo's shared secret into a 56-byte `ovkBlob` so
     * the sender can recover this transfer after a cold restore. Absent → no blob
     * (the app applies the ⊥ default at submit time, never the SDK).
     */
    outgoingViewingKey?: Uint8Array;
};

/**
 * Circuit version notes are created under today. A note carries its version
 * (`ZkNote.circuitVersion`) so that, after a VK rotation, it is always proven
 * and verified against the circuit that created it. Only one version exists
 * today; callers may pass the chain's active version explicitly.
 */
export const CURRENT_CIRCUIT_VERSION = 1;

/**
 * Computed ZK note (commitment + nullifier). Built entirely off-chain.
 *
 * commitment = Poseidon(value, assetId, ownerPk, blinding)
 * nullifier  = Poseidon(commitment, spendingKey)
 */
export type ZkNote = {
    /** Note amount in planck. */
    value: bigint;
    /** Asset ID of the note. */
    assetId: bigint;
    /** Owner's BabyJubJub Ax coordinate (or stealth owner Pk for stealth notes). */
    ownerPk: bigint;
    /** Blinding scalar mixed into the commitment. */
    blinding: bigint;
    /** Secret spending key used to derive the nullifier. */
    spendingKey: bigint;
    /** Circuit version this note was created under (see `CURRENT_CIRCUIT_VERSION`). Required. */
    circuitVersion: number;
    /**
     * Global Merkle leaf index, when known. Optional so pre-forest vaults
     * need no migration: notes without it predate the first tree seal and
     * belong to tree 0. Populated on shield and on scan; used only to derive
     * the forest tree for same-tree coin selection (`treeIdOf`).
     */
    leafIndex?: number;
    /** Whether the note has been spent/nullified on-chain. */
    spent: boolean;
    /** Local timestamp when this note was marked spent, or null if still active/unknown. */
    spentAt: number | null;
    /** Poseidon commitment scalar. */
    commitment: bigint;
    /** Poseidon nullifier scalar. */
    nullifier: bigint;
    /** 0x-prefixed 32-byte little-endian hex commitment. */
    commitmentHex: string;
    /** 0x-prefixed 32-byte little-endian hex nullifier. */
    nullifierHex: string;
    /**
     * 180-byte encrypted memo (ChaCha20-Poly1305 ECDH) as number[] for SCALE encoding.
     * Always populated: uses a dummy memo when no viewingPublicKey is provided.
     */
    memo: number[];
    /** Counterparty BabyJubJub Ax coordinate. Zero for shield/unshield notes. */
    sourcePk: bigint;
    /**
     * 56-byte outgoing-viewing-key blob (per-note in the domain object; becomes a
     * per-transaction field at submit, see the OVK plan §4.1). Present only on a
     * stealth recipient note built with an `outgoingViewingKey`. It wraps the
     * memo's shared secret under the sender's ovk so the sender can recover the
     * transfer; the recipient never needs it. Not persisted in the vault.
     */
    ovkBlob?: number[];
};

/**
 * A sender's record of a note they SENT, recovered via the OVK blob. Not a
 * spendable note: it deliberately carries no `spendingKey`, no `nullifier`, no
 * `spent` flag — the sender does not own the recipient's note, only the memory of
 * having sent it. Used to rebuild the outgoing history after a cold restore.
 */
export type OutgoingNoteRecord = {
    /** 0x-prefixed 32-byte LE commitment hex of the recipient output. */
    commitmentHex: string;
    /** Global Merkle leaf index, when the hint carried one. */
    leafIndex?: number;
    /** Amount sent, in planck. */
    value: bigint;
    /** Asset ID of the sent note. */
    assetId: bigint;
    /** The recipient's one-time stealth owner public key (BJJ Ax). */
    recipientStealthPk: bigint;
    /** Blinding scalar of the recipient output. With value/assetId/stealthPk it
     *  recomputes the commitment — needed to rebuild a payment slip for the note. */
    blinding: bigint;
    /** Counterparty BabyJubJub Ax coordinate stamped in the memo. */
    sourcePk: bigint;
    /** Circuit version the sent note was created under. */
    circuitVersion: number;
};

/**
 * What a sender can still say about a note they sent, using only public data.
 *
 * No decryption and no key: the memo travels verbatim, exactly as published.
 * The point is to FORWARD it to the recipient inside a fresh payment slip, not
 * to read it — the recipient opens it with their own viewing key as always.
 *
 * That is what makes a slip recoverable after a lost device. What is NOT
 * recoverable this way is the amount and the recipient, which live inside the
 * sealed memo: a sender restoring from a seed alone gets working slips, not
 * their outgoing history.
 */
export type NoteFacts = {
    /** 0x-prefixed 32-byte LE commitment hex of the recipient output. */
    commitmentHex: string;
    /** Global Merkle leaf index, when known. */
    leafIndex?: number;
    /**
     * The note's 180-byte encrypted memo, 0x-prefixed, exactly as published.
     *
     * Carried verbatim, never decrypted here — the sender has no key for it.
     * Handing it back to the recipient inside a fresh slip is what re-issuing a
     * slip means.
     */
    encryptedMemo: string;
};
