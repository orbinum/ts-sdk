/**
 * Adversarial tests for the shielded-pool calldata builders.
 *
 * The node rejects malformed calldata, but it rejects it SILENTLY: a wrong
 * selector or a short body comes back as "unsupported selector", the same
 * answer a legitimate rejection gets. A stale selector can therefore ship and
 * break every transfer without producing a single distinguishable error. So the
 * SDK has to be the layer that fails loudly.
 *
 * Two properties are asserted throughout:
 *   - the selector and argument count are FROZEN, because keccak covers the
 *     whole signature and one extra argument silently breaks every transfer;
 *   - values that cannot be encoded are rejected here, not truncated into
 *     calldata the node will refuse for reasons the user cannot see.
 */
import { describe, it, expect } from 'vitest';
import { ShieldedPoolPrecompile } from '../../../src/chain/evm/precompiles/ShieldedPoolPrecompile';
import { SP_SEL } from '../../../src/chain/evm/precompiles/addresses';
import type { EvmClient } from '../../../src/chain/evm/EvmClient';

const mockEvm = () => ({}) as unknown as EvmClient;

const MEMO = new Uint8Array(180).fill(0xcd);
const H32 = (b: string) => '0x' + b.repeat(32);

const TRANSFER_PARAMS = {
    proof: new Uint8Array(256).fill(0xaa),
    merkleRoot: H32('11'),
    inputs: [{ nullifier: H32('22'), commitment: H32('21') }],
    outputs: [{ commitment: H32('33'), encryptedMemo: MEMO }],
    assetId: 0,
    circuitVersion: 1,
};

// ─── The selector is the contract ────────────────────────────────────────────

describe('the privateTransfer selector cannot drift', () => {
    it('is exactly the four bytes the precompile decodes', () => {
        // keccak256("privateTransfer(bytes,bytes32,bytes32[],bytes32[],bytes[],
        //            uint32,uint256,uint32)")[0..4]
        expect(Array.from(SP_SEL.PRIVATE_TRANSFER)).toEqual([0x66, 0xed, 0x2c, 0xd4]);
    });

    it('is not the nine-argument selector the node refuses', () => {
        // 0x1ec439cf is keccak of a signature with one extra trailing `bytes`.
        // Shipping it means every private transfer comes back "unsupported
        // selector" — the same answer a legitimate rejection gets, which is why
        // this needs a test rather than a bug report.
        expect(Array.from(SP_SEL.PRIVATE_TRANSFER)).not.toEqual([0x1e, 0xc4, 0x39, 0xcf]);
    });

    it('every built calldata starts with it', () => {
        const p = new ShieldedPoolPrecompile(mockEvm());
        // An omitted fee and an explicit one must produce the same selector: the
        // selector covers the signature, never the values.
        expect(p.buildPrivateTransferCalldata(TRANSFER_PARAMS).slice(0, 10)).toBe('0x66ed2cd4');
        for (const fee of [0n, 1n, 10n ** 30n]) {
            const cd = p.buildPrivateTransferCalldata({ ...TRANSFER_PARAMS, fee });
            expect(cd.slice(0, 10)).toBe('0x66ed2cd4');
        }
    });
});

// ─── Head shape ──────────────────────────────────────────────────────────────

describe('the head stays 8 slots, whatever the payload', () => {
    /** Params section, without the 0x and the 4-byte selector. */
    const paramsOf = (cd: string) => cd.slice(10);
    const slot = (cd: string, i: number) => paramsOf(cd).slice(i * 64, (i + 1) * 64);

    it('the fee lands in slot 6 — where the relay reads it', () => {
        // The relay extracts calldata[196..228] (slot 6 past the selector) and
        // compares it against its fee floor. A shifted head means the relay
        // reads a different field and rejects a correctly-paid transfer.
        const p = new ShieldedPoolPrecompile(mockEvm());
        for (const fee of [0n, 1n, 1_000_000n, 2n ** 200n]) {
            const cd = p.buildPrivateTransferCalldata({ ...TRANSFER_PARAMS, fee });
            expect(BigInt('0x' + slot(cd, 6))).toBe(fee);
        }
    });

    it('the circuit version is slot 7, and nothing follows it in the head', () => {
        const p = new ShieldedPoolPrecompile(mockEvm());
        const cd = p.buildPrivateTransferCalldata({ ...TRANSFER_PARAMS, circuitVersion: 3 });
        expect(BigInt('0x' + slot(cd, 7))).toBe(3n);

        // Slots 0, 2, 3, 4 are offsets into the tail; the first must point at
        // 8 × 32 = 256, i.e. immediately past an 8-slot head. A ninth argument
        // would push this to 288 — the regression this pins.
        expect(BigInt('0x' + slot(cd, 0))).toBe(256n);
    });

    it('grows only in the tail as outputs are added', () => {
        const p = new ShieldedPoolPrecompile(mockEvm());
        const one = p.buildPrivateTransferCalldata(TRANSFER_PARAMS);
        const two = p.buildPrivateTransferCalldata({
            ...TRANSFER_PARAMS,
            inputs: [
                { nullifier: H32('22'), commitment: H32('21') },
                { nullifier: H32('44'), commitment: H32('43') },
            ],
            outputs: [
                { commitment: H32('33'), encryptedMemo: MEMO },
                { commitment: H32('55'), encryptedMemo: MEMO },
            ],
        });
        // Same head, longer body.
        expect(slot(two, 0)).toBe(slot(one, 0));
        expect(two.length).toBeGreaterThan(one.length);
    });
});

// ─── Hostile field values ────────────────────────────────────────────────────

describe('values that cannot be encoded are refused, not truncated', () => {
    const p = () => new ShieldedPoolPrecompile(mockEvm());

    it('rejects a memo that is not exactly 180 bytes', () => {
        // The memo length is the wire format. A short one encodes fine here and
        // fails inside the pallet, where the error says nothing useful.
        for (const bad of [new Uint8Array(0), new Uint8Array(179), new Uint8Array(181)]) {
            expect(() =>
                p().buildPrivateTransferCalldata({
                    ...TRANSFER_PARAMS,
                    outputs: [{ commitment: H32('33'), encryptedMemo: bad }],
                })
            ).toThrow();
        }
    });

    it('rejects malformed hex in a commitment, nullifier, or root', () => {
        for (const bad of ['0xzz', 'no-0x-prefix', '0x123', '']) {
            expect(() =>
                p().buildPrivateTransferCalldata({ ...TRANSFER_PARAMS, merkleRoot: bad })
            ).toThrow();
            expect(() =>
                p().buildPrivateTransferCalldata({
                    ...TRANSFER_PARAMS,
                    inputs: [{ nullifier: bad, commitment: H32('21') }],
                })
            ).toThrow();
        }
    });

    it('rejects a negative fee rather than encoding it as a huge uint', () => {
        // Two's-complement wraparound would encode -1 as 2^256-1, clearing every
        // fee floor the relay applies while the user believes they paid nothing.
        expect(() => p().buildPrivateTransferCalldata({ ...TRANSFER_PARAMS, fee: -1n })).toThrow();
    });

    it('rejects a fee that does not fit in a uint256', () => {
        expect(() =>
            p().buildPrivateTransferCalldata({ ...TRANSFER_PARAMS, fee: 2n ** 256n })
        ).toThrow();
    });

    it('rejects a negative or oversized circuit version', () => {
        // circuitVersion is a uint32 on chain. A value past that either wraps to
        // a version that exists — verifying against the WRONG verifying key — or
        // is refused by the decoder with no explanation.
        for (const bad of [-1, 2 ** 32, Number.MAX_SAFE_INTEGER]) {
            expect(() =>
                p().buildPrivateTransferCalldata({ ...TRANSFER_PARAMS, circuitVersion: bad })
            ).toThrow();
        }
    });

    it('rejects a negative or oversized asset id', () => {
        for (const bad of [-1, 2 ** 32]) {
            expect(() =>
                p().buildPrivateTransferCalldata({ ...TRANSFER_PARAMS, assetId: bad })
            ).toThrow();
        }
    });

    it('rejects a non-integer circuit version or asset id', () => {
        expect(() =>
            p().buildPrivateTransferCalldata({ ...TRANSFER_PARAMS, circuitVersion: 1.5 })
        ).toThrow();
        expect(() =>
            p().buildPrivateTransferCalldata({ ...TRANSFER_PARAMS, assetId: 0.1 })
        ).toThrow();
    });
});

// ─── The unshield recipient decides who gets paid ────────────────────────────

describe('the unshield recipient is never silently reshaped', () => {
    const UNSHIELD_PARAMS = {
        proof: new Uint8Array(128).fill(0xbb),
        merkleRoot: H32('11'),
        nullifier: H32('22'),
        assetId: 0,
        amount: 1000n,
        recipientAddress: H32('44'),
        circuitVersion: 1,
    };

    const build = (recipientAddress: string) =>
        new ShieldedPoolPrecompile(mockEvm()).buildUnshieldCalldata({
            ...UNSHIELD_PARAMS,
            recipientAddress,
        });

    it('refuses an address longer than 32 bytes instead of truncating it', () => {
        // The slot is bytes32. An over-long address used to be cut to its first
        // 32 bytes, so the funds left the pool toward an account the caller
        // never named — and the calldata looked perfectly well-formed.
        expect(() => build('0x' + '44'.repeat(33))).toThrow();
        expect(() => build('0x' + '44'.repeat(64))).toThrow();
    });

    it('right-pads a short address, which is what an EeSuffix account is', () => {
        // An H160 followed by twelve zero bytes is a legitimate AccountId32, so
        // this padding must keep working.
        const evmStyle = '0x' + 'ab'.repeat(20);
        expect(build(evmStyle)).toBe(build(evmStyle + '00'.repeat(12)));
    });

    it('accepts the address with or without the 0x prefix', () => {
        expect(build(H32('44'))).toBe(build('44'.repeat(32)));
    });

    it('refuses an address that is not hex at all', () => {
        // `padEnd` would happily extend "zz…" to 64 chars and hand it to the
        // decoder, which is where near-hex becomes attacker-chosen bytes.
        for (const bad of ['0xzz', '0x' + 'gg'.repeat(32), 'not-an-address']) {
            expect(() => build(bad)).toThrow();
        }
    });
});
