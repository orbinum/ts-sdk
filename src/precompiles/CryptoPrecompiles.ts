import type { EvmClient } from '../evm/EvmClient';
import { toHex } from '../utils/hex';
import { hexToBytes } from './abi';
import { PRECOMPILE_ADDR } from './addresses';

/**
 * Low-level bindings for cryptographic EVM precompiles.
 *
 * These precompiles use **raw input** (no ABI selector) and are called via
 * `eth_call`. They are useful for on-chain-verified cryptographic operations,
 * particularly `curve25519Add` and `curve25519ScalarMul` for Ristretto ZK math.
 *
 * Gas costs are deterministic but metered by the EVM; for off-chain operations
 * prefer the `@noble/*` libraries directly.
 */
export class CryptoPrecompiles {
    constructor(private readonly evm: EvmClient) {}

    // ─── ECRecover (0x0001) ───────────────────────────────────────────────────

    /**
     * Recovers the Ethereum address from an ECDSA signature.
     *
     * Classic Ethereum ECRecover (EIP-spec): input is always 128 bytes:
     *   hash(32) + v_padded(32, v=27 or 28) + r(32) + s(32)
     *
     * Returns a 0x-prefixed lowercase 20-byte EVM address.
     */
    async ecRecover(hash: Uint8Array, v: 27 | 28, r: Uint8Array, s: Uint8Array): Promise<string> {
        const input = new Uint8Array(128);
        input.set(hash.slice(0, 32), 0);
        // v: uint256 right-aligned in slot [32..64]
        input[63] = v;
        input.set(r.slice(0, 32), 64);
        input.set(s.slice(0, 32), 96);

        const raw = hexToBytes(await this.evm.call(PRECOMPILE_ADDR.EC_RECOVER, toHex(input)));
        if (raw.length < 32) return '0x' + '00'.repeat(20);
        // Output: 32-byte zero-padded address (last 20 bytes are the address)
        return '0x' + toHex(raw.slice(12, 32)).slice(2);
    }

    /**
     * Recovers the **full uncompressed public key** (64 bytes, no 0x04 prefix)
     * from an ECDSA signature.
     *
     * Same input format as `ecRecover`. Output is 64 bytes (32-byte X + 32-byte Y).
     */
    async ecRecoverPublicKey(
        hash: Uint8Array,
        v: 27 | 28,
        r: Uint8Array,
        s: Uint8Array
    ): Promise<Uint8Array> {
        const input = new Uint8Array(128);
        input.set(hash.slice(0, 32), 0);
        input[63] = v;
        input.set(r.slice(0, 32), 64);
        input.set(s.slice(0, 32), 96);

        return hexToBytes(await this.evm.call(PRECOMPILE_ADDR.EC_RECOVER_PUBKEY, toHex(input)));
    }

    // ─── SHA-256 (0x0002) ─────────────────────────────────────────────────────

    /**
     * Computes SHA-256 of arbitrary bytes via EVM precompile.
     * Returns a 32-byte digest.
     */
    async sha256(data: Uint8Array): Promise<Uint8Array> {
        return hexToBytes(await this.evm.call(PRECOMPILE_ADDR.SHA256, toHex(data)));
    }

    // ─── RIPEMD-160 (0x0003) ──────────────────────────────────────────────────

    /**
     * Computes RIPEMD-160 of arbitrary bytes via EVM precompile.
     * Returns the 20-byte digest right-padded to 32 bytes (standard ABI output).
     */
    async ripemd160(data: Uint8Array): Promise<Uint8Array> {
        const raw = hexToBytes(await this.evm.call(PRECOMPILE_ADDR.RIPEMD160, toHex(data)));
        // Output: 12 zero bytes + 20-byte digest → return just the 20-byte digest
        return raw.length >= 32 ? raw.slice(12, 32) : raw;
    }

    // ─── Identity (0x0004) ────────────────────────────────────────────────────

    /**
     * Data copy via EVM precompile (identity). Returns the input unchanged.
     * Mainly useful for gas benchmarking.
     */
    async identity(data: Uint8Array): Promise<Uint8Array> {
        return hexToBytes(await this.evm.call(PRECOMPILE_ADDR.IDENTITY, toHex(data)));
    }

    // ─── SHA3-FIPS-256 / Keccak-256 (0x0400) ─────────────────────────────────

    /**
     * Computes Keccak-256 (= SHA3-FIPS-256 as used by Ethereum) of arbitrary bytes.
     * Returns a 32-byte digest.
     */
    async keccak256(data: Uint8Array): Promise<Uint8Array> {
        return hexToBytes(await this.evm.call(PRECOMPILE_ADDR.SHA3_FIPS256, toHex(data)));
    }

    // ─── Curve25519 / Ristretto (0x0402, 0x0403) ─────────────────────────────

    /**
     * Adds up to 10 Ristretto (Curve25519) compressed points via EVM precompile.
     *
     * Input: N × 32-byte CompressedRistretto points concatenated (N ≤ 10).
     * Output: 32-byte CompressedRistretto sum.
     *
     * Useful for ZK protocols that require verifiable Pedersen commitments.
     */
    async curve25519Add(points: Uint8Array[]): Promise<Uint8Array> {
        if (points.length === 0 || points.length > 10) {
            throw new Error(`curve25519Add: expected 1–10 points, got ${points.length}`);
        }
        const input = new Uint8Array(points.length * 32);
        for (let i = 0; i < points.length; i++) {
            const pt = points[i];
            if (!pt || pt.length !== 32) {
                throw new Error(`curve25519Add: point[${i}] must be exactly 32 bytes`);
            }
            input.set(pt, i * 32);
        }
        return hexToBytes(await this.evm.call(PRECOMPILE_ADDR.CURVE25519_ADD, toHex(input)));
    }

    /**
     * Multiplies a Ristretto compressed point by a scalar via EVM precompile.
     *
     * Input: 32-byte scalar (little-endian) + 32-byte CompressedRistretto point.
     * Output: 32-byte CompressedRistretto result.
     *
     * Useful for computing key images and Pedersen commitments in ZK protocols.
     */
    async curve25519ScalarMul(scalar: Uint8Array, point: Uint8Array): Promise<Uint8Array> {
        if (scalar.length !== 32) throw new Error('curve25519ScalarMul: scalar must be 32 bytes');
        if (point.length !== 32) throw new Error('curve25519ScalarMul: point must be 32 bytes');
        const input = new Uint8Array(64);
        input.set(scalar, 0);
        input.set(point, 32);
        return hexToBytes(await this.evm.call(PRECOMPILE_ADDR.CURVE25519_SCALAR_MUL, toHex(input)));
    }
}
