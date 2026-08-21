import { describe, it, expect } from 'vitest';
import { decodePrecompileCalldata } from '../../../src/chain/evm/precompiles/decode';
import { ShieldedPoolPrecompile } from '../../../src/chain/evm/precompiles/ShieldedPoolPrecompile';
import { PRECOMPILE_ADDR } from '../../../src/chain/evm/precompiles/addresses';
import type { EvmClient } from '../../../src/chain/evm/EvmClient';

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const SP_ADDR = PRECOMPILE_ADDR.SHIELDED_POOL;

const COMMITMENT = '0x' + 'aa'.repeat(32);
const NULLIFIER = '0x' + 'bb'.repeat(32);
const ROOT = '0x' + 'cc'.repeat(32);
const PROOF = new Uint8Array([0x01, 0x02, 0x03]);
const RECIPIENT = '0x' + 'dd'.repeat(32);

function mockEvm(): EvmClient {
    return { call: async () => '0x', estimateGas: async () => 0n } as unknown as EvmClient;
}

// ─── Null / edge cases ────────────────────────────────────────────────────────

describe('decodePrecompileCalldata — null cases', () => {
    it('returns null for an unknown address', () => {
        expect(decodePrecompileCalldata('0xdeadbeef', '0x12345678')).toBeNull();
    });

    it('returns null for empty input', () => {
        expect(decodePrecompileCalldata(SP_ADDR, '')).toBeNull();
    });

    it('returns null for input shorter than 10 chars', () => {
        expect(decodePrecompileCalldata(SP_ADDR, '0x1234')).toBeNull();
    });

    it('returns null when selector is not registered', () => {
        expect(
            decodePrecompileCalldata(SP_ADDR, '0x' + 'ff'.repeat(4) + '00'.repeat(32))
        ).toBeNull();
    });

    it('is case-insensitive on address', () => {
        const calldata = new ShieldedPoolPrecompile(mockEvm()).buildShieldCalldata({
            assetId: 0,
            amount: 1n,
            commitment: COMMITMENT,
            encryptedMemo: new Uint8Array(180),
        });
        const upper = SP_ADDR.toUpperCase();
        const result = decodePrecompileCalldata(upper, calldata);
        expect(result).not.toBeNull();
        expect(result?.fnSig).toMatch(/^shield\(/);
    });
});

// ─── shield(uint32,bytes32,bytes) — round-trip ───────────────────────────────
// amount is msg.value (NOT in calldata)

describe('decodePrecompileCalldata — shield', () => {
    const sp = new ShieldedPoolPrecompile(mockEvm());

    it('decodes fnSig correctly', () => {
        const calldata = sp.buildShieldCalldata({
            assetId: 0,
            amount: 1_000n,
            commitment: COMMITMENT,
            encryptedMemo: new Uint8Array(180),
        });
        const result = decodePrecompileCalldata(SP_ADDR, calldata);
        expect(result?.fnSig).toBe('shield(uint32,bytes32,bytes)');
    });

    it('round-trips assetId', () => {
        const calldata = sp.buildShieldCalldata({
            assetId: 7,
            amount: 1n,
            commitment: COMMITMENT,
            encryptedMemo: new Uint8Array(180),
        });
        const result = decodePrecompileCalldata(SP_ADDR, calldata);
        expect(result?.args['assetId']).toBe(7n);
    });

    it('amount is NOT present in args (it is msg.value)', () => {
        const calldata = sp.buildShieldCalldata({
            assetId: 0,
            amount: 1_000_000_000_000_000_000n,
            commitment: COMMITMENT,
            encryptedMemo: new Uint8Array(180),
        });
        const result = decodePrecompileCalldata(SP_ADDR, calldata);
        expect(result?.args['amount']).toBeUndefined();
    });

    it('round-trips commitment as 0x-prefixed hex', () => {
        const calldata = sp.buildShieldCalldata({
            assetId: 0,
            amount: 1n,
            commitment: COMMITMENT,
            encryptedMemo: new Uint8Array(180),
        });
        const result = decodePrecompileCalldata(SP_ADDR, calldata);
        expect(typeof result?.args['commitment']).toBe('string');
        expect((result?.args['commitment'] as string).toLowerCase()).toBe(COMMITMENT.toLowerCase());
    });
});

// ─── unshield(bytes,bytes32,bytes32,uint32,uint256,bytes32,uint256,bytes32) — round-trip ──────

describe('decodePrecompileCalldata — unshield', () => {
    const sp = new ShieldedPoolPrecompile(mockEvm());

    const params = {
        proof: PROOF,
        merkleRoot: ROOT,
        nullifier: NULLIFIER,
        assetId: 1,
        amount: 500_000n,
        recipientAddress: RECIPIENT,
        circuitVersion: 1,
    };

    it('decodes fnSig correctly', () => {
        const calldata = sp.buildUnshieldCalldata(params);
        const result = decodePrecompileCalldata(SP_ADDR, calldata);
        expect(result?.fnSig).toBe(
            'unshield(bytes,bytes32,bytes32,uint32,uint256,bytes32,uint256,bytes32,bytes,uint32)'
        );
    });

    it('round-trips circuitVersion', () => {
        const calldata = sp.buildUnshieldCalldata({ ...params, circuitVersion: 7 });
        const result = decodePrecompileCalldata(SP_ADDR, calldata);
        expect(result?.args['circuitVersion']).toBe(7n);
    });

    it('round-trips root', () => {
        const calldata = sp.buildUnshieldCalldata(params);
        const result = decodePrecompileCalldata(SP_ADDR, calldata);
        expect((result?.args['root'] as string).toLowerCase()).toBe(ROOT.toLowerCase());
    });

    it('round-trips nullifier', () => {
        const calldata = sp.buildUnshieldCalldata(params);
        const result = decodePrecompileCalldata(SP_ADDR, calldata);
        expect((result?.args['nullifier'] as string).toLowerCase()).toBe(NULLIFIER.toLowerCase());
    });

    it('round-trips assetId', () => {
        const calldata = sp.buildUnshieldCalldata(params);
        const result = decodePrecompileCalldata(SP_ADDR, calldata);
        expect(result?.args['assetId']).toBe(1n);
    });

    it('round-trips amount', () => {
        const calldata = sp.buildUnshieldCalldata(params);
        const result = decodePrecompileCalldata(SP_ADDR, calldata);
        expect(result?.args['amount']).toBe(500_000n);
    });

    it('round-trips recipient', () => {
        const calldata = sp.buildUnshieldCalldata(params);
        const result = decodePrecompileCalldata(SP_ADDR, calldata);
        expect((result?.args['recipient'] as string).toLowerCase()).toBe(RECIPIENT.toLowerCase());
    });

    it('decodes fee as 0n when not specified', () => {
        const calldata = sp.buildUnshieldCalldata(params);
        const result = decodePrecompileCalldata(SP_ADDR, calldata);
        expect(result?.args['fee']).toBe(0n);
    });

    it('round-trips fee', () => {
        const calldata = sp.buildUnshieldCalldata({ ...params, fee: 1_000_000_000_000_000n });
        const result = decodePrecompileCalldata(SP_ADDR, calldata);
        expect(result?.args['fee']).toBe(1_000_000_000_000_000n);
    });
});

// ─── privateTransfer(bytes,bytes32,bytes32[],bytes32[],bytes[],uint32,uint256) — round-trip ──

describe('decodePrecompileCalldata — privateTransfer', () => {
    const sp = new ShieldedPoolPrecompile(mockEvm());

    const BASE_TRANSFER = {
        proof: PROOF,
        merkleRoot: ROOT,
        inputs: [{ nullifier: NULLIFIER, commitment: COMMITMENT }],
        outputs: [{ commitment: COMMITMENT, encryptedMemo: new Uint8Array(180) }],
        assetId: 0,
        circuitVersion: 1,
    };

    it('decodes fnSig correctly', () => {
        const calldata = sp.buildPrivateTransferCalldata(BASE_TRANSFER);
        const result = decodePrecompileCalldata(SP_ADDR, calldata);
        expect(result?.fnSig).toBe(
            'privateTransfer(bytes,bytes32,bytes32[],bytes32[],bytes[],uint32,uint256,uint32)'
        );
    });

    it('round-trips circuitVersion', () => {
        const calldata = sp.buildPrivateTransferCalldata({ ...BASE_TRANSFER, circuitVersion: 5 });
        const result = decodePrecompileCalldata(SP_ADDR, calldata);
        expect(result?.args['circuitVersion']).toBe(5n);
    });

    it('round-trips root', () => {
        const calldata = sp.buildPrivateTransferCalldata(BASE_TRANSFER);
        const result = decodePrecompileCalldata(SP_ADDR, calldata);
        expect((result?.args['root'] as string).toLowerCase()).toBe(ROOT.toLowerCase());
    });

    it('counts nullifiers correctly', () => {
        const calldata = sp.buildPrivateTransferCalldata({
            ...BASE_TRANSFER,
            inputs: [
                { nullifier: NULLIFIER, commitment: COMMITMENT },
                { nullifier: NULLIFIER, commitment: COMMITMENT },
            ],
        });
        const result = decodePrecompileCalldata(SP_ADDR, calldata);
        expect(result?.args['nullifiers']).toBe(2);
    });

    it('counts commitments correctly', () => {
        const calldata = sp.buildPrivateTransferCalldata({
            ...BASE_TRANSFER,
            outputs: [
                { commitment: COMMITMENT, encryptedMemo: new Uint8Array(180) },
                { commitment: COMMITMENT, encryptedMemo: new Uint8Array(180) },
            ],
        });
        const result = decodePrecompileCalldata(SP_ADDR, calldata);
        expect(result?.args['commitments']).toBe(2);
    });

    it('round-trips assetId', () => {
        const calldata = sp.buildPrivateTransferCalldata({ ...BASE_TRANSFER, assetId: 3 });
        const result = decodePrecompileCalldata(SP_ADDR, calldata);
        expect(result?.args['assetId']).toBe(3n);
    });

    it('round-trips fee', () => {
        const calldata = sp.buildPrivateTransferCalldata({ ...BASE_TRANSFER, fee: 1_000_000n });
        const result = decodePrecompileCalldata(SP_ADDR, calldata);
        expect(result?.args['fee']).toBe(1_000_000n);
    });

    it('decodes fee as 0n when not specified', () => {
        const calldata = sp.buildPrivateTransferCalldata(BASE_TRANSFER);
        const result = decodePrecompileCalldata(SP_ADDR, calldata);
        expect(result?.args['fee']).toBe(0n);
    });
});

/**
 * `method` — la operación, desde el selector.
 *
 * Existe porque la derivación obvia a partir de `fnSig` es buscar substrings, y
 * `shield` ES substring de `unshield`: un clasificador que comprueba en el orden
 * equivocado reporta cada unshield como shield, sin fallar, y un método nuevo
 * del pallet lo vuelve a romper.
 */
describe('decodePrecompileCalldata — method', () => {
    const sp = new ShieldedPoolPrecompile(mockEvm());

    it('SEGURIDAD: un unshield nunca se clasifica como shield', () => {
        // El caso concreto: 'unshield(' contiene 'shield('. Anclado al inicio y
        // comprobado antes, no puede confundirse.
        const calldata = sp.buildUnshieldCalldata({
            proof: PROOF,
            merkleRoot: ROOT,
            nullifier: NULLIFIER,
            assetId: 1,
            amount: 500_000n,
            recipientAddress: RECIPIENT,
            circuitVersion: 1,
        });
        expect(decodePrecompileCalldata(SP_ADDR, calldata)?.method).toBe('unshield');
    });

    it('clasifica un shield', () => {
        const calldata = sp.buildShieldCalldata({
            assetId: 0,
            amount: 1_000n,
            commitment: COMMITMENT,
            encryptedMemo: new Uint8Array(180),
        });
        expect(decodePrecompileCalldata(SP_ADDR, calldata)?.method).toBe('shield');
    });
});

// ─── Truncated calldata is not a source of invented values ───────────────────
//
// This decoder reads calldata taken FROM THE CHAIN, so its input is whatever
// anyone chose to submit — including a call that was never valid. `decodeUint`
// reads a fixed 32-byte window and substitutes `?? 0` for bytes past the end,
// so a half-present field is completed with zeros and returns a number nobody
// encoded. Consumers render `args.amount` to the user as the transaction's
// value, which makes a fabricated amount worse than an absent one.

describe('decodePrecompileCalldata — truncated input', () => {
    /** A well-formed call, cut to `bytes` of payload after the selector. */
    function truncate(fullCalldata: string, bytes: number): string {
        return fullCalldata.slice(0, 10 + bytes * 2);
    }

    const fullUnshield = () =>
        new ShieldedPoolPrecompile(mockEvm()).buildUnshieldCalldata({
            proof: PROOF,
            merkleRoot: ROOT,
            nullifier: NULLIFIER,
            assetId: 0,
            amount: 1000n,
            recipientAddress: RECIPIENT,
            circuitVersion: 1,
        });

    it('does not report an amount when the amount field is cut in half', () => {
        // The amount slot is [128,160). Sixteen present bytes of 0xff plus
        // sixteen substituted zeros decode to ~1.15e77 — a value the sender
        // never wrote, shown to a user as what they are about to pay.
        const cut = truncate(fullUnshield(), 144);
        const decoded = decodePrecompileCalldata(SP_ADDR, cut);

        expect(decoded?.args['amount']).toBeUndefined();
    });

    it('does not report fields that lie entirely past the end', () => {
        const cut = truncate(fullUnshield(), 100);
        const decoded = decodePrecompileCalldata(SP_ADDR, cut);

        expect(decoded?.args['amount']).toBeUndefined();
        expect(decoded?.args['circuitVersion']).toBeUndefined();
    });

    it('still names the method for a truncated call', () => {
        // Losing the args must not lose the classification: the UI can still
        // label the row, it just has no amount to show.
        const decoded = decodePrecompileCalldata(SP_ADDR, truncate(fullUnshield(), 100));

        expect(decoded?.method).toBe('unshield');
    });

    it('decodes every field when the calldata is complete', () => {
        const decoded = decodePrecompileCalldata(SP_ADDR, fullUnshield());

        expect(decoded?.args['amount']).toBe(1000n);
        expect(decoded?.args['circuitVersion']).toBe(1n);
    });
});

// ─── Array offsets are read from the calldata itself ─────────────────────────

describe('decodePrecompileCalldata — hostile array offsets', () => {
    /** A privateTransfer head with `offset` written into the nullifiers slot. */
    function transferWithNullifierOffset(offset: bigint, headSlots = 8): string {
        const data = new Uint8Array(headSlots * 32);
        const slot = new Uint8Array(32);
        let v = offset;
        for (let i = 31; i >= 0; i--) {
            slot[i] = Number(v & 0xffn);
            v >>= 8n;
        }
        data.set(slot, 64); // [64,96) — offset → nullifiers
        const hex = Array.from(data, (b) => b.toString(16).padStart(2, '0')).join('');
        return '0x66ed2cd4' + hex;
    }

    it('does not report a count for an offset past the end of the calldata', () => {
        // The offset is attacker-chosen. Following it past the end reads a
        // length out of substituted zero bytes and reports "0 nullifiers" for a
        // call whose shape is unknown.
        const decoded = decodePrecompileCalldata(SP_ADDR, transferWithNullifierOffset(2n ** 64n));

        expect(decoded?.args['nullifiers']).toBeUndefined();
    });

    it('does not report a count for an offset that lands on a partial word', () => {
        // An offset 16 bytes short of the end leaves half a length word, which
        // decodes to a huge number rather than failing.
        const decoded = decodePrecompileCalldata(
            SP_ADDR,
            transferWithNullifierOffset(BigInt(8 * 32 - 16))
        );

        expect(decoded?.args['nullifiers']).toBeUndefined();
    });

    it('still reports the fixed fields when an offset is unusable', () => {
        // The head is intact, so root/assetId/fee/circuitVersion remain valid —
        // only the array counts are dropped.
        const decoded = decodePrecompileCalldata(SP_ADDR, transferWithNullifierOffset(2n ** 64n));

        expect(decoded?.method).toBe('privateTransfer');
        expect(decoded?.args['circuitVersion']).toBeDefined();
    });
});

/**
 * `claimShieldedFees` fue el hueco: el decodificador la parseaba entera pero
 * `methodOf` no la mapeaba, así que salía con `method: null` y los `args`
 * poblados. Un consumidor que clasifique por `method` trataba una reclamación
 * de comisiones como llamada desconocida teniendo todos los datos delante.
 */
describe('decodePrecompileCalldata — claimShieldedFees', () => {
    it('la nombra en vez de devolver method: null', async () => {
        const sp = new ShieldedPoolPrecompile(mockEvm());
        let data = '';
        await sp.claimShieldedFees(
            {
                commitment: COMMITMENT,
                amount: 5_000n,
                assetId: 0,
                proof: PROOF,
                publicSignals: new Uint8Array(76),
                encryptedMemo: new Uint8Array(180),
                circuitVersion: 1,
            },
            async (tx) => {
                data = tx.data;
                return '0xhash';
            }
        );

        const decoded = decodePrecompileCalldata(SP_ADDR, data);

        expect(decoded?.method).toBe('claimShieldedFees');
    });

    it('y decodifica sus argumentos', async () => {
        // El contraste que da sentido al anterior: si los args no salieran,
        // `method: null` sería la respuesta honesta.
        const sp = new ShieldedPoolPrecompile(mockEvm());
        let data = '';
        await sp.claimShieldedFees(
            {
                commitment: COMMITMENT,
                amount: 5_000n,
                assetId: 0,
                proof: PROOF,
                publicSignals: new Uint8Array(76),
                encryptedMemo: new Uint8Array(180),
                circuitVersion: 1,
            },
            async (tx) => {
                data = tx.data;
                return '0xhash';
            }
        );

        const decoded = decodePrecompileCalldata(SP_ADDR, data);

        expect(decoded?.args['commitment']).toBe(COMMITMENT);
        expect(decoded?.args['amount']).toBe(5_000n);
    });
});
