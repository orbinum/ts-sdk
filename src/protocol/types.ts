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
    counterpartyPk: bigint;
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
    counterpartyPk?: bigint;
    /** Circuit version to stamp on the note. Defaults to `CURRENT_CIRCUIT_VERSION`. */
    circuitVersion?: number;
    /**
     * 32-byte ephemeral secret for the memo ECDH. Self-notes pass a
     * deterministic one (deriveSelfEphSk) so a cold restore recognizes them by
     * ephPk equality with no trial ECDH. Ignored on the stealth path (it
     * generates its own coordinated ephSk). Default: random.
     */
    ephSkOverride?: Uint8Array;
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
    counterpartyPk: bigint;
};
