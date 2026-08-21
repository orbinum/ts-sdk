/**
 * Runtime parameters of `pallet-shielded-pool`.
 *
 * Consensus values, not preferences: the chain rejects an extrinsic that
 * disagrees with them. They live here because a wallet has no way to derive
 * them and no business choosing them — `planTransfer` and `planUnshield` take a
 * `fee`, and without this a host is left reverse-engineering the number from a
 * failed extrinsic.
 *
 * These are the current chain's values, which is what every caller needs today.
 * A chain that has moved on should pass its own — and note that not all of them
 * need a runtime upgrade to move: see `MIN_GASLESS_FEE`.
 */

/**
 * Smallest fee an unsigned (gasless) shielded-pool extrinsic may carry, in
 * planck — the default of `pallet-relayer`'s `MinRelayFee`.
 *
 * MUTABLE STORAGE, not a runtime constant: governance moves it with
 * `set_min_relay_fee`, no upgrade required. A wallet that hardcodes this value
 * starts failing with `FeeTooLow` the moment the floor rises, so read
 * `min_relay_fee()` when the answer has to be current.
 *
 * Below it the pallet rejects with `FeeTooLow`. The fee is paid to the block
 * author by the runtime, which is what lets a user with no public balance spend
 * a shielded note at all.
 *
 * Unshield fixes the fee at exactly this value; a private transfer may pay more
 * (the sender chooses), which is why a reconstructed transfer fee is unknown
 * rather than assumed — see `scanner/history/extrinsicFacts`.
 */
export const MIN_GASLESS_FEE = 1_000_000_000_000_000n; // 0.001 ORB

/**
 * Inputs and outputs in one private transfer.
 *
 * The circuit is fixed at 2-in/2-out: a spend with one real input pads with a
 * dummy, and change is always the second output even when it is zero.
 */
export const TRANSFER_INPUTS = 2;
export const TRANSFER_OUTPUTS = 2;

/**
 * Asset id of the chain's native token.
 *
 * Zero is the runtime's reserved id, not a convention a wallet may pick. It
 * decides real behaviour: balances across different assets must never be summed,
 * and a note's asset is part of its commitment, so mistaking a token for the
 * native asset produces a total that means nothing.
 */
export const NATIVE_ASSET_ID = 0n;

/**
 * Whether an asset id refers to the native token.
 *
 * Absent counts as native: a record written before the pool carried multiple
 * assets has no asset id, and every one of those was ORB.
 */
export function isNativeAsset(assetId: bigint | number | string | null | undefined): boolean {
    if (assetId === null || assetId === undefined || assetId === '') return true;
    try {
        return BigInt(assetId) === NATIVE_ASSET_ID;
    } catch {
        // An unparseable id is not the native asset — treating it as one would
        // fold an unknown token into an ORB total.
        return false;
    }
}
