/**
 * Marshalling a note into shield extrinsic arguments.
 *
 * The endianness assertion is the point of this file. A big-endian commitment
 * is accepted by the chain and produces a note NOBODY can find afterwards — not
 * a scan, not a rescan, not the recipient. There is no error to notice.
 */
import { describe, it, expect } from 'vitest';
import {
    buildShieldParams,
    buildShieldBatchOperations,
} from '../../../../src/wallet/ops/transport/shieldParams';
import { bigintTo32LeArr } from '../../../../src/foundation/encoding/bytes';
import { toHex } from '../../../../src/foundation/encoding/hex';
import type { ZkNote } from '../../../../src/protocol/types';

const note = (over: Partial<ZkNote> = {}): ZkNote =>
    ({
        value: 500n,
        assetId: 0n,
        commitment: 0x1234n,
        memo: [1, 2, 3],
        ...over,
    }) as ZkNote;

describe('buildShieldParams', () => {
    it('encodes the commitment LITTLE-endian', () => {
        const params = buildShieldParams(note({ commitment: 0x1234n }));

        expect(params.commitment).toBe(toHex(new Uint8Array(bigintTo32LeArr(0x1234n))));
        // Explicitly: the low byte leads. Big-endian would put it last.
        expect(params.commitment.slice(2, 6)).toBe('3412');
    });

    it('narrows assetId to a number for the extrinsic codec', () => {
        expect(buildShieldParams(note({ assetId: 7n })).assetId).toBe(7);
    });

    it('passes the memo through as bytes', () => {
        const params = buildShieldParams(note({ memo: [9, 8, 7] }));

        expect(params.encryptedMemo).toBeInstanceOf(Uint8Array);
        expect([...params.encryptedMemo]).toEqual([9, 8, 7]);
    });

    it('accepts a memo that is already a Uint8Array', () => {
        const memo = new Uint8Array([4, 5]);

        expect(buildShieldParams(note({ memo: memo as unknown as number[] })).encryptedMemo).toBe(
            memo
        );
    });
});

describe('buildShieldBatchOperations', () => {
    it('emits the positional tuple the codec expects', () => {
        // Positional, not named: the batch call's codec silently mis-encodes an
        // object.
        const ops = buildShieldBatchOperations([note({ value: 10n }), note({ value: 20n })]);

        expect(ops).toHaveLength(2);
        expect(ops[0]).toHaveLength(4);
        const [assetId, amount, commitment, memo] = ops[0]!;
        expect(assetId).toBe(0);
        expect(amount).toBe(10n);
        expect(commitment).toBe(buildShieldParams(note({ value: 10n })).commitment);
        expect(memo).toBeInstanceOf(Uint8Array);
    });

    it('is empty for no notes', () => {
        expect(buildShieldBatchOperations([])).toEqual([]);
    });
});
