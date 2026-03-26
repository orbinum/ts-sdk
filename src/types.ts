export type OrbinumClientConfig = {
    /** WebSocket URL of the Orbinum node (e.g. "ws://localhost:9944") */
    substrateWs: string;
    /** HTTP URL of the EVM JSON-RPC endpoint (e.g. "http://localhost:9933") */
    evmRpc?: string;
    /** Connection timeout in ms. Default: 15_000 */
    connectTimeoutMs?: number;
};

export type TxResult = {
    txHash: string;
    blockHash: string;
    blockNumber: number;
    /** Whether the extrinsic succeeded (no ExtrinsicFailed event). */
    ok: boolean;
    /** Dispatch error type string when ok = false. */
    error?: string;
};

export type MerkleTreeInfo = {
    root: string;
    treeSize: number;
    depth: number;
};

/** Aggregate shielded pool statistics (merkle tree + total locked balance). */
export type PoolStats = {
    merkleRoot: string;
    commitmentCount: number;
    /** Total native balance locked in the pool (u128 as decimal string). */
    totalBalance: string;
    treeDepth: number;
};

export type MerkleProof = {
    root: string;
    leafIndex: number;
    siblings: string[];
};

export type CommitmentMerkleProof = MerkleProof;

export type NullifierStatus = {
    nullifier: string;
    isSpent: boolean;
};

export type PoolBalance = {
    assetId: number;
    balance: bigint;
};

// ─── Shielded Pool params ────────────────────────────────────────────────────

export type ShieldParams = {
    assetId: number;
    amount: bigint;
    /** 0x-prefixed 32-byte commitment hex */
    commitment: string;
    /** Optional encrypted memo bytes. Auto-generates a dummy memo if absent. */
    encryptedMemo?: Uint8Array;
};

export type UnshieldParams = {
    /** ZK proof bytes */
    proof: Uint8Array;
    /** 0x-prefixed merkle root hex */
    merkleRoot: string;
    /** 0x-prefixed nullifier hex */
    nullifier: string;
    assetId: number;
    amount: bigint;
    /** SS58 or 0x-prefixed 32-byte address */
    recipientAddress: string;
};

export type TransferInput = {
    /** 0x-prefixed nullifier hex */
    nullifier: string;
    /** 0x-prefixed commitment hex */
    commitment: string;
};

export type TransferOutput = {
    /** 0x-prefixed commitment hex */
    commitment: string;
    encryptedMemo?: Uint8Array;
};

export type PrivateTransferParams = {
    inputs: TransferInput[];
    outputs: TransferOutput[];
    /** ZK proof bytes */
    proof: Uint8Array;
    /** 0x-prefixed merkle root hex */
    merkleRoot: string;
};

// ─── ZK Note (shielded pool) ─────────────────────────────────────────────────

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
     * 32-byte recipient viewing key used to encrypt the memo (ChaCha20-Poly1305).
     * When provided, NoteBuilder.build() will auto-generate the 104-byte encrypted memo.
     * Omit to skip memo generation (use buildMemo() separately if needed).
     */
    viewingKey?: Uint8Array;
};

/**
 * Computed ZK note (commitment + nullifier). Built entirely off-chain.
 *
 * commitment = Poseidon(value, assetId, ownerPk, blinding)
 * nullifier  = Poseidon(commitment, spendingKey)
 */
export type ZkNote = {
    value: bigint;
    assetId: bigint;
    ownerPk: bigint;
    blinding: bigint;
    spendingKey: bigint;
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
     * 104-byte encrypted memo (ChaCha20-Poly1305) as number[] for SCALE encoding.
     * Always populated: uses a dummy memo when no viewingKey is provided.
     */
    memo: number[];
};

/** Result of buildAndShield: the submitted tx and the note to keep safe. */
export type ShieldResult = {
    txResult: TxResult;
    note: ZkNote;
};

// ─── Chain info ──────────────────────────────────────────────────────────────

export type ChainInfo = {
    name: string;
    version: string;
    ss58Prefix: number;
};

export type FullIdentityInfo = {
    substrateAddress: string | null;
    evmAddress: string | null;
    alias: string | null;
};

// ─── Account Mapping ─────────────────────────────────────────────────────────

/**
 * Signature verification scheme for cross-chain links.
 * Mirrors `SignatureScheme` in pallet-account-mapping.
 */
export type SignatureScheme = 'Eip191' | 'Ed25519';

/** A verified public link to an external chain wallet. */
export type ChainLink = {
    chainId: number;
    address: string; // hex-encoded external address bytes
};

/** A private link: only the Poseidon commitment is stored on-chain. */
export type PrivateLink = {
    chainId: number;
    commitment: string; // 0x-prefixed 32-byte hex
};

/** Public profile metadata set by the account owner. */
export type AccountMetadata = {
    displayName: string | null;
    bio: string | null;
    avatar: string | null;
};

/** Identity info by alias: owner, optional EVM address, link count. */
export type AliasInfo = {
    /** 0x-prefixed 32-byte AccountId32 hex. */
    owner: string;
    /** Normalized EVM address (0x + 40 hex chars), or null. */
    evmAddress: string | null;
    chainLinksCount: number;
};

/**
 * Full identity for an alias: owner, EVM address, all public chain links, metadata.
 * Returned by `accountMapping_getFullIdentity` (alias-based lookup).
 */
export type AliasFullIdentity = {
    owner: string;
    evmAddress: string | null;
    chainLinks: ChainLink[];
    metadata: AccountMetadata | null;
};

/** Sale listing info for an alias on the marketplace. */
export type ListingInfo = {
    price: bigint;
    /** True if sale is private (whitelist-only). */
    private: boolean;
    whitelistCount: number;
};

/** An alias actively listed for sale with its full info. */
export type AccountListing = {
    alias: string;
    listing: ListingInfo;
};

/** A supported chain and its signature verification scheme. */
export type SupportedChain = {
    chainId: number;
    scheme: SignatureScheme;
};

/**
 * Bitmask to convert a SLIP-0044 coin type into an Orbinum ChainId.
 * Example: `SLIP0044_NAMESPACE | 501` = Solana.
 */
export const SLIP0044_NAMESPACE = 0x8000_0000;
