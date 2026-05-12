import { describe, it, expect } from 'vitest';
import type {
    PrivateTransferInput as PublicPrivateTransferInput,
    PrivateTransferOutput as PublicPrivateTransferOutput,
} from '../../src/index';
import type {
    ShieldArgs,
    UnshieldArgs,
    RawTransferInput,
    RawTransferOutput,
    PrivateTransferArgs,
} from '../../src/shielded-pool/pallet/extrinsics';
import type {
    ShieldedEvent,
    NullifiersSpentEvent,
    CommitmentsInsertedEvent,
    UnshieldedEvent,
    MerkleRootUpdatedEvent,
    ShieldedPoolEvent,
} from '../../src/shielded-pool/pallet/events';

// ─── pallet-args structural tests ────────────────────────────────────────────

describe('pallet-args types', () => {
    it('public private-transfer types use the hex-based module shape', () => {
        const input: PublicPrivateTransferInput = {
            nullifier: '0x' + 'aa'.repeat(32),
            commitment: '0x' + 'bb'.repeat(32),
        };
        const output: PublicPrivateTransferOutput = {
            commitment: '0x' + 'cc'.repeat(32),
            encryptedMemo: new Uint8Array(104),
        };
        expect(input.nullifier.startsWith('0x')).toBe(true);
        expect(output.commitment.startsWith('0x')).toBe(true);
        expect(output.encryptedMemo).toBeInstanceOf(Uint8Array);
    });

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
            recipient: '5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY',
            fee: 0n,
            changeCommitment: new Array(32).fill(0),
        };
        expect(args.proof).toHaveLength(192);
        expect(typeof args.recipient).toBe('string');
    });

    it('PrivateTransferArgs holds nested inputs and outputs', () => {
        const input: RawTransferInput = {
            nullifier: new Array(32).fill(0),
            commitment: new Array(32).fill(1),
        };
        const output: RawTransferOutput = {
            commitment: new Array(32).fill(2),
            memo: new Array(104).fill(0),
        };
        const args: PrivateTransferArgs = {
            proof: new Array(192).fill(0),
            merkleRoot: new Array(32).fill(0),
            nullifiers: [input],
            outputs: [output],
            encryptedMemos: [new Array(104).fill(0)],
            assetId: 0,
            fee: 0n,
        };
        expect(args.nullifiers).toHaveLength(1);
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

    it('NullifiersSpentEvent holds nullifiers array', () => {
        const ev: NullifiersSpentEvent = {
            nullifiers: ['0x01', '0x02'],
        };
        expect(ev.nullifiers).toHaveLength(2);
    });

    it('CommitmentsInsertedEvent holds commitments, memos and indices', () => {
        const ev: CommitmentsInsertedEvent = {
            commitments: ['0x03', '0x04'],
            encryptedMemos: ['0x05', '0x06'],
            leafIndices: [8, 9],
        };
        expect(ev.commitments).toHaveLength(2);
        expect(ev.leafIndices).toEqual([8, 9]);
    });

    it('UnshieldedEvent holds expected fields for total unshield', () => {
        const ev: UnshieldedEvent = {
            nullifier: '0x01',
            amount: 250n,
            recipient: '5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY',
            changeCommitment: null,
        };
        expect(ev.amount).toBe(250n);
        expect(ev.changeCommitment).toBeNull();
    });

    it('UnshieldedEvent holds changeCommitment as hex string for partial unshield', () => {
        const ev: UnshieldedEvent = {
            nullifier: '0x01',
            amount: 250n,
            recipient: '5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY',
            changeCommitment: '0x' + 'ab'.repeat(32),
        };
        expect(typeof ev.changeCommitment).toBe('string');
        expect(ev.changeCommitment).toMatch(/^0x[a-f0-9]{64}$/);
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

    it('ShieldedPoolEvent covers NullifiersSpent variant', () => {
        const event: ShieldedPoolEvent = {
            type: 'NullifiersSpent',
            data: {
                nullifiers: ['0x01'],
            },
        };
        expect(event.type).toBe('NullifiersSpent');
        if (event.type === 'NullifiersSpent') {
            expect(event.data.nullifiers).toHaveLength(1);
        }
    });

    it('ShieldedPoolEvent covers CommitmentsInserted variant', () => {
        const event: ShieldedPoolEvent = {
            type: 'CommitmentsInserted',
            data: {
                commitments: ['0x02'],
                encryptedMemos: ['0x03'],
                leafIndices: [1],
            },
        };
        expect(event.type).toBe('CommitmentsInserted');
        if (event.type === 'CommitmentsInserted') {
            expect(event.data.commitments).toHaveLength(1);
        }
    });

    it('ShieldedPoolEvent covers Unshielded variant', () => {
        const event: ShieldedPoolEvent = {
            type: 'Unshielded',
            data: { nullifier: '0x01', amount: 10n, recipient: '0x02', changeCommitment: null },
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
