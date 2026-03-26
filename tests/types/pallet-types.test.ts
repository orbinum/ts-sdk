import { describe, it, expect } from 'vitest';
import type {
    ShieldArgs,
    UnshieldArgs,
    PrivateTransferInput,
    PrivateTransferOutput,
    PrivateTransferArgs,
} from '../../src/types/pallet-args';
import type {
    ShieldedEvent,
    PrivateTransferEvent,
    UnshieldedEvent,
    MerkleRootUpdatedEvent,
    ShieldedPoolEvent,
} from '../../src/types/pallet-events';

// ─── pallet-args structural tests ────────────────────────────────────────────

describe('pallet-args types', () => {
    it('ShieldArgs holds expected shape', () => {
        const args: ShieldArgs = {
            assetId: 0,
            amount: 1_000_000n,
            commitment: [1, 2, 3],
            encryptedMemo: new Array(104).fill(0),
        };
        expect(args.assetId).toBe(0);
        expect(args.amount).toBe(1_000_000n);
        expect(args.commitment).toHaveLength(3);
        expect(args.encryptedMemo).toHaveLength(104);
    });

    it('UnshieldArgs holds expected shape', () => {
        const args: UnshieldArgs = {
            proof: new Array(192).fill(0),
            merkleRoot: new Array(32).fill(0),
            nullifier: new Array(32).fill(0),
            assetId: 0,
            amount: 500n,
            recipient: new Array(32).fill(1),
        };
        expect(args.proof).toHaveLength(192);
        expect(args.recipient).toHaveLength(32);
    });

    it('PrivateTransferArgs holds nested inputs and outputs', () => {
        const input: PrivateTransferInput = {
            nullifier: new Array(32).fill(0),
            commitment: new Array(32).fill(1),
        };
        const output: PrivateTransferOutput = {
            commitment: new Array(32).fill(2),
            memo: new Array(104).fill(0),
        };
        const args: PrivateTransferArgs = {
            inputs: [input],
            outputs: [output],
            proof: new Array(192).fill(0),
            merkleRoot: new Array(32).fill(0),
        };
        expect(args.inputs).toHaveLength(1);
        expect(args.outputs).toHaveLength(1);
    });
});

// ─── pallet-events structural tests ──────────────────────────────────────────

describe('pallet-events types', () => {
    it('ShieldedEvent holds expected fields', () => {
        const ev: ShieldedEvent = {
            depositor: '5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY',
            amount: 1_000_000n,
            commitment: '0xabc',
            encryptedMemo: '0xdef',
            leafIndex: 7,
        };
        expect(ev.leafIndex).toBe(7);
    });

    it('PrivateTransferEvent holds arrays', () => {
        const ev: PrivateTransferEvent = {
            nullifiers: ['0x01', '0x02'],
            commitments: ['0x03', '0x04'],
            encryptedMemos: ['0x05', '0x06'],
            leafIndices: [8, 9],
        };
        expect(ev.nullifiers).toHaveLength(2);
        expect(ev.leafIndices).toEqual([8, 9]);
    });

    it('UnshieldedEvent holds expected fields', () => {
        const ev: UnshieldedEvent = {
            nullifier: '0x01',
            amount: 250n,
            recipient: '5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY',
        };
        expect(ev.amount).toBe(250n);
    });

    it('MerkleRootUpdatedEvent holds expected fields', () => {
        const ev: MerkleRootUpdatedEvent = {
            oldRoot: '0xaaa',
            newRoot: '0xbbb',
            treeSize: 16,
        };
        expect(ev.treeSize).toBe(16);
    });

    it('ShieldedPoolEvent discriminated union narrows correctly', () => {
        const event: ShieldedPoolEvent = {
            type: 'Shielded',
            data: {
                depositor: '0xabc',
                amount: 1n,
                commitment: '0xdef',
                encryptedMemo: '0x000',
                leafIndex: 0,
            },
        };
        expect(event.type).toBe('Shielded');
        if (event.type === 'Shielded') {
            expect(event.data.leafIndex).toBe(0);
        }
    });

    it('ShieldedPoolEvent covers PrivateTransfer variant', () => {
        const event: ShieldedPoolEvent = {
            type: 'PrivateTransfer',
            data: {
                nullifiers: ['0x01'],
                commitments: ['0x02'],
                encryptedMemos: ['0x03'],
                leafIndices: [1],
            },
        };
        expect(event.type).toBe('PrivateTransfer');
        if (event.type === 'PrivateTransfer') {
            expect(event.data.nullifiers).toHaveLength(1);
        }
    });

    it('ShieldedPoolEvent covers Unshielded variant', () => {
        const event: ShieldedPoolEvent = {
            type: 'Unshielded',
            data: { nullifier: '0x01', amount: 10n, recipient: '0x02' },
        };
        expect(event.type).toBe('Unshielded');
    });

    it('ShieldedPoolEvent covers MerkleRootUpdated variant', () => {
        const event: ShieldedPoolEvent = {
            type: 'MerkleRootUpdated',
            data: { oldRoot: '0xa', newRoot: '0xb', treeSize: 4 },
        };
        expect(event.type).toBe('MerkleRootUpdated');
    });
});
