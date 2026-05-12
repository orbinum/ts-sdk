import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ArtifactProvider, DisclosureProofOutput } from '../../src/proof-generator/fee-claim';

// ─── Mock @orbinum/proof-generator ────────────────────────────────────────────

vi.mock('@orbinum/proof-generator', () => ({
    CircuitType: {
        Unshield: 'unshield',
        Transfer: 'transfer',
        Disclosure: 'disclosure',
    },
    generateDisclosureProof: vi.fn(),
    WebArtifactProvider: vi.fn().mockImplementation(function (this: object) { return this; }),
}));

import { generateFeeClaimProof } from '../../src/proof-generator/fee-claim';
import { generateDisclosureProof } from '@orbinum/proof-generator';

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Build a 0x-prefixed 64-char LE hex signal from a raw bigint.
 * The signal is stored little-endian: low byte at hex[0..2].
 */
function leHex(value: bigint, bytes = 32): string {
    let v = value;
    const out: string[] = [];
    for (let i = 0; i < bytes; i++) {
        out.push((Number(v & 0xffn)).toString(16).padStart(2, '0'));
        v >>= 8n;
    }
    return '0x' + out.join('').padEnd(64, '0');
}

/** Build a mock DisclosureProofOutput for the given commitment, amount, assetId. */
function mockDisclosureOutput(
    commitment: bigint,
    amount: bigint,
    assetId: bigint,
): DisclosureProofOutput {
    return {
        proof: '0x' + 'ab'.repeat(64),
        publicSignals: [
            leHex(0n),             // [0] epk_x
            leHex(0n),             // [1] epk_y
            leHex(amount),         // [2] enc_value (enc = plaintext in this test mock)
            leHex(assetId),        // [3] enc_asset_id
            leHex(0n),             // [4] enc_owner_hash (zeroed, discloseOwner=false)
            leHex(commitment),     // [5] commitment
            leHex(0n),             // [6] auditor_pk_x
            leHex(0n),             // [7] auditor_pk_y
        ],
        revealedData: {
            commitment: leHex(commitment),
            value: amount.toString(),
            assetId: Number(assetId),
        },
    } as unknown as DisclosureProofOutput;
}

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const COMMITMENT = 0xdeadbeefn;
const AMOUNT     = 500_000_000_000n;   // 500 ORB in planck
const ASSET_ID   = 1n;
const OWNER_PK   = 12345n;
const BLINDING   = 99999n;

const BASE_INPUTS = {
    commitment: COMMITMENT,
    amount:     AMOUNT,
    assetId:    ASSET_ID,
    ownerPubkey: OWNER_PK,
    blinding:    BLINDING,
};

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('generateFeeClaimProof', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        vi.mocked(generateDisclosureProof).mockResolvedValue(
            mockDisclosureOutput(COMMITMENT, AMOUNT, ASSET_ID),
        );
    });

    // ── delegation to disclosure circuit ───────────────────────────────────────

    it('calls generateDisclosureProof with the correct positional args', async () => {
        await generateFeeClaimProof(BASE_INPUTS);

        expect(generateDisclosureProof).toHaveBeenCalledOnce();
        const [amount, ownerPubkey, blinding, assetId, commitment, _pkX, _pkY, _r, mask, opts] =
            vi.mocked(generateDisclosureProof).mock.calls[0]!;

        expect(amount).toBe(AMOUNT);
        expect(ownerPubkey).toBe(OWNER_PK);
        expect(blinding).toBe(BLINDING);
        expect(assetId).toBe(ASSET_ID);
        expect(commitment).toBe(COMMITMENT);
        expect(mask).toEqual({
            discloseValue: true,
            discloseAssetId: true,
            discloseOwner: false,
        });
        // opts may be undefined or {}
        void _pkX; void _pkY; void _r; void opts;
    });

    it('passes a custom provider to generateDisclosureProof', async () => {
        const customProvider = {} as ArtifactProvider;
        await generateFeeClaimProof(BASE_INPUTS, { provider: customProvider });

        const [, , , , , , , , , opts] = vi.mocked(generateDisclosureProof).mock.calls[0]!;
        expect((opts as Record<string, unknown>)?.['provider']).toBe(customProvider);
    });

    it('passes verbose=true to generateDisclosureProof when requested', async () => {
        await generateFeeClaimProof(BASE_INPUTS, { verbose: true });

        const [, , , , , , , , , opts] = vi.mocked(generateDisclosureProof).mock.calls[0]!;
        expect((opts as Record<string, unknown>)?.['verbose']).toBe(true);
    });

    // ── proof passthrough ───────────────────────────────────────────────────────

    it('returns the raw proof string unchanged', async () => {
        const result = await generateFeeClaimProof(BASE_INPUTS);
        expect(result.proof).toBe('0x' + 'ab'.repeat(64));
    });

    // ── publicSignals layout ────────────────────────────────────────────────────

    it('returns publicSignals as a 76-element number[]', async () => {
        const result = await generateFeeClaimProof(BASE_INPUTS);
        expect(result.publicSignals).toHaveLength(76);
        expect(result.publicSignals.every((b) => Number.isInteger(b) && b >= 0 && b <= 255)).toBe(true);
    });

    it('packs commitment into bytes [0..32] in LE order', async () => {
        const result = await generateFeeClaimProof(BASE_INPUTS);
        const commitmentBytes = result.publicSignals.slice(0, 32);

        // COMMITMENT = 0xdeadbeef → LE bytes: ef be ad de 00 ...
        expect(commitmentBytes[0]).toBe(0xef);
        expect(commitmentBytes[1]).toBe(0xbe);
        expect(commitmentBytes[2]).toBe(0xad);
        expect(commitmentBytes[3]).toBe(0xde);
        expect(commitmentBytes[4]).toBe(0x00);
    });

    it('packs amount into bytes [32..40] as u64 LE', async () => {
        const result = await generateFeeClaimProof(BASE_INPUTS);
        const valueBytes = result.publicSignals.slice(32, 40);

        // Reconstruct u64 LE from the 8 packed bytes
        let recovered = 0n;
        for (let i = 7; i >= 0; i--) {
            recovered = (recovered << 8n) | BigInt(valueBytes[i]!);
        }
        expect(recovered).toBe(AMOUNT);
    });

    it('packs assetId into bytes [40..44] as u32 LE', async () => {
        const result = await generateFeeClaimProof(BASE_INPUTS);
        const assetIdBytes = result.publicSignals.slice(40, 44);

        const recovered =
            assetIdBytes[0]! |
            (assetIdBytes[1]! << 8) |
            (assetIdBytes[2]! << 16) |
            (assetIdBytes[3]! << 24);
        expect(recovered).toBe(Number(ASSET_ID));
    });

    it('zeroes bytes [44..76] (owner_hash not disclosed)', async () => {
        const result = await generateFeeClaimProof(BASE_INPUTS);
        const ownerBytes = result.publicSignals.slice(44, 76);
        expect(ownerBytes.every((b) => b === 0)).toBe(true);
    });

    // ── layout with a larger assetId ───────────────────────────────────────────

    it('packs assetId=42 correctly into bytes [40..44]', async () => {
        const assetId = 42n;
        vi.mocked(generateDisclosureProof).mockResolvedValueOnce(
            mockDisclosureOutput(COMMITMENT, AMOUNT, assetId),
        );

        const result = await generateFeeClaimProof({ ...BASE_INPUTS, assetId });
        const assetIdBytes = result.publicSignals.slice(40, 44);
        expect(assetIdBytes[0]).toBe(42);
        expect(assetIdBytes[1]).toBe(0);
    });

    // ── value boundary ─────────────────────────────────────────────────────────

    it('handles amount=1n correctly', async () => {
        vi.mocked(generateDisclosureProof).mockResolvedValueOnce(
            mockDisclosureOutput(COMMITMENT, 1n, ASSET_ID),
        );

        const result = await generateFeeClaimProof({ ...BASE_INPUTS, amount: 1n });
        const valueBytes = result.publicSignals.slice(32, 40);
        expect(valueBytes[0]).toBe(1);
        expect(valueBytes.slice(1).every((b) => b === 0)).toBe(true);
    });

    it('handles u64 max amount correctly', async () => {
        const maxU64 = 18446744073709551615n;
        vi.mocked(generateDisclosureProof).mockResolvedValueOnce(
            mockDisclosureOutput(COMMITMENT, maxU64, ASSET_ID),
        );

        const result = await generateFeeClaimProof({ ...BASE_INPUTS, amount: maxU64 });
        const valueBytes = result.publicSignals.slice(32, 40);
        expect(valueBytes.every((b) => b === 0xff)).toBe(true);
    });

    // ── zero values ────────────────────────────────────────────────────────────

    it('handles zero commitment correctly', async () => {
        vi.mocked(generateDisclosureProof).mockResolvedValueOnce(
            mockDisclosureOutput(0n, AMOUNT, ASSET_ID),
        );

        const result = await generateFeeClaimProof({ ...BASE_INPUTS, commitment: 0n });
        const commitmentBytes = result.publicSignals.slice(0, 32);
        expect(commitmentBytes.every((b) => b === 0)).toBe(true);
    });
});
