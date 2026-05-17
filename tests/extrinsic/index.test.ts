import { describe, it, expect } from 'vitest';
import { mapExtrinsicArgs, mapZkEventData } from '../../src/extrinsic/index';

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Build args with semantic keys. */
const named = (obj: Record<string, unknown>) => obj;

/** Build args with positional keys (arg0, arg1, …). */
const positional = (...values: unknown[]) =>
    Object.fromEntries(values.map((v, i) => [`arg${i}`, v]));

// ─── mapExtrinsicArgs — passthrough ──────────────────────────────────────────

describe('mapExtrinsicArgs — passthrough', () => {
    it('returns empty object unchanged', () => {
        expect(mapExtrinsicArgs('system', 'remark', {})).toEqual({});
    });

    it('returns original args for unknown section', () => {
        const raw = { arg0: 'foo', arg1: 42 };
        expect(mapExtrinsicArgs('unknownPallet', 'unknownMethod', raw)).toEqual(raw);
    });

    it('returns original args for unknown method within known section', () => {
        const raw = named({ arg0: 'x' });
        expect(mapExtrinsicArgs('balances', 'unknownMethod', raw)).toEqual(raw);
    });
});

// ─── mapExtrinsicArgs — system ────────────────────────────────────────────────

describe('mapExtrinsicArgs — system', () => {
    it('maps remark (semantic key)', () => {
        const result = mapExtrinsicArgs('system', 'remark', named({ remark: '0xdeadbeef' }));
        expect(result).toEqual({ remark: '0xdeadbeef' });
    });

    it('maps remark (positional key)', () => {
        const result = mapExtrinsicArgs('system', 'remark', positional('0xdeadbeef'));
        expect(result).toEqual({ remark: '0xdeadbeef' });
    });

    it('maps remark_with_event normalising underscores', () => {
        const result = mapExtrinsicArgs('system', 'remark_with_event', positional('0xaabb'));
        expect(result).toEqual({ remark: '0xaabb' });
    });

    it('maps killPrefix with two args', () => {
        const result = mapExtrinsicArgs('system', 'kill_prefix', positional('0xpfx', 5));
        expect(result).toEqual({ prefix: '0xpfx', subkeys: 5 });
    });
});

// ─── mapExtrinsicArgs — timestamp ────────────────────────────────────────────

describe('mapExtrinsicArgs — timestamp', () => {
    it('maps set (semantic key)', () => {
        const result = mapExtrinsicArgs('timestamp', 'set', named({ now: 1711234567000 }));
        expect(result).toEqual({ now: 1711234567000 });
    });

    it('maps set (positional key)', () => {
        const result = mapExtrinsicArgs('timestamp', 'set', positional(1711234567000));
        expect(result).toEqual({ now: 1711234567000 });
    });
});

// ─── mapExtrinsicArgs — balances ─────────────────────────────────────────────

describe('mapExtrinsicArgs — balances', () => {
    it('maps transfer_keep_alive with dest/value', () => {
        const result = mapExtrinsicArgs(
            'balances',
            'transfer_keep_alive',
            named({ dest: '0xAlice', value: '1000000000000000000' }),
        );
        expect(result['recipient']).toBe('0xAlice');
        expect(result['amount']).toBe('1000000000000000000');
    });

    it('maps transfer_keep_alive with positional keys', () => {
        const result = mapExtrinsicArgs(
            'balances',
            'transfer_keep_alive',
            positional('0xBob', '500000000000000000'),
        );
        expect(result['recipient']).toBe('0xBob');
        expect(result['amount']).toBe('500000000000000000');
    });

    it('maps force_transfer with three positional args', () => {
        const result = mapExtrinsicArgs(
            'balances',
            'force_transfer',
            positional('0xSource', '0xDest', '100'),
        );
        expect(result).toEqual({ source: '0xSource', dest: '0xDest', value: '100' });
    });

    it('maps burn with keep_alive flag', () => {
        const result = mapExtrinsicArgs('balances', 'burn', positional('999', true));
        expect(result).toEqual({ value: '999', keep_alive: true });
    });
});

// ─── mapExtrinsicArgs — shieldedPool ─────────────────────────────────────────

describe('mapExtrinsicArgs — shieldedPool', () => {
    it('maps shield with semantic keys', () => {
        const result = mapExtrinsicArgs(
            'shieldedPool',
            'shield',
            named({
                asset_id: 0,
                amount: '1000000000000000000',
                commitment: '0x' + 'aa'.repeat(32),
                encrypted_memo: '0xmemo',
            }),
        );
        expect(result['asset_id']).toBe(0);
        expect(result['amount']).toBe('1000000000000000000');
        expect(result['commitment']).toBe('0x' + 'aa'.repeat(32));
    });

    it('maps shield with positional keys', () => {
        const result = mapExtrinsicArgs(
            'shieldedPool',
            'shield',
            positional(1, '5000', '0xcommit', '0xmemo'),
        );
        expect(result['asset_id']).toBe(1);
        expect(result['amount']).toBe('5000');
        expect(result['commitment']).toBe('0xcommit');
        expect(result['encrypted_memo']).toBe('0xmemo');
    });

    it('maps private_transfer with positional keys', () => {
        const result = mapExtrinsicArgs(
            'shieldedPool',
            'private_transfer',
            positional('0xproof', '0xroot', ['0xnull'], ['0xcommit'], ['0xmemo']),
        );
        expect(result['proof']).toBe('0xproof');
        expect(result['merkle_root']).toBe('0xroot');
        expect(result['nullifiers']).toEqual(['0xnull']);
        expect(result['commitments']).toEqual(['0xcommit']);
    });

    it('maps unshield with positional keys', () => {
        const result = mapExtrinsicArgs(
            'shieldedPool',
            'unshield',
            positional('0xproof', '0xroot', '0xnull', 0, '999', '0xrec'),
        );
        expect(result['nullifier']).toBe('0xnull');
        expect(result['amount']).toBe('999');
        expect(result['recipient']).toBe('0xrec');
    });

    it('maps shieldBatch with array operations', () => {
        const ops = [
            [0, '1000', '0xcommit', '0xmemo'],
            [1, '2000', '0xcommit2', '0xmemo2'],
        ];
        const result = mapExtrinsicArgs('shieldedPool', 'shieldBatch', positional(ops));
        const mapped = result['operations'] as Array<Record<string, unknown>>;
        expect(mapped).toHaveLength(2);
        expect(mapped[0]!['asset_id']).toBe(0);
        expect(mapped[1]!['amount']).toBe('2000');
    });
});

// ─── mapExtrinsicArgs — ethereum ──────────────────────────────────────────────

describe('mapExtrinsicArgs — ethereum', () => {
    it('maps ethereum.transact with positional key', () => {
        const result = mapExtrinsicArgs('ethereum', 'transact', positional({ type: 'EIP1559', value: '0' }));
        expect(result['transaction']).toBeDefined();
    });

    it('maps ethereum.transact with semantic key', () => {
        const tx = { type: 'EIP1559', gasLimit: '21000' };
        const result = mapExtrinsicArgs('ethereum', 'transact', named({ transaction: tx }));
        expect(result['transaction']).toEqual(tx);
    });
});

// ─── mapExtrinsicArgs — accountMapping ───────────────────────────────────────

describe('mapExtrinsicArgs — accountMapping', () => {
    it('maps registerAlias (positional)', () => {
        const result = mapExtrinsicArgs('accountMapping', 'registerAlias', positional('alice'));
        expect(result).toEqual({ alias: 'alice' });
    });

    it('maps transferAlias (positional)', () => {
        const result = mapExtrinsicArgs('accountMapping', 'transfer_alias', positional('0xNewOwner'));
        expect(result).toEqual({ new_owner: '0xNewOwner' });
    });

    it('maps addChainLink with three positional args', () => {
        const result = mapExtrinsicArgs(
            'accountMapping',
            'add_chain_link',
            positional(60, '0xaddr', '0xsig'),
        );
        expect(result).toEqual({ chain_id: 60, address: '0xaddr', signature: '0xsig' });
    });

    it('maps setAccountMetadata (positional)', () => {
        const result = mapExtrinsicArgs(
            'accountMapping',
            'setAccountMetadata',
            positional('Alice', 'Bio text', 'https://avatar.url'),
        );
        expect(result).toEqual({
            display_name: 'Alice',
            bio: 'Bio text',
            avatar: 'https://avatar.url',
        });
    });

    it('maps dispatchAsLinkedAccount (positional)', () => {
        const result = mapExtrinsicArgs(
            'accountMapping',
            'dispatchAsLinkedAccount',
            positional('0xOwner', 60, '0xAddr', '0xSig', { section: 'balances', method: 'transfer' }),
        );
        expect(result['owner']).toBe('0xOwner');
        expect(result['chain_id']).toBe(60);
        expect(result['call']).toBeDefined();
    });
});

// ─── mapExtrinsicArgs — zkVerifier ────────────────────────────────────────────

describe('mapExtrinsicArgs — zkVerifier', () => {
    it('maps registerVerificationKey (positional)', () => {
        const result = mapExtrinsicArgs(
            'zkVerifier',
            'register_verification_key',
            positional('circuit-shield', 1, '0xvkdata'),
        );
        expect(result).toEqual({
            circuit_id: 'circuit-shield',
            version: 1,
            verification_key: '0xvkdata',
        });
    });

    it('maps batchRegisterVerificationKeys with array', () => {
        const entries = [
            { circuit_id: 'A', version: 1, verification_key: '0xvk1', set_active: true },
            { circuit_id: 'B', version: 2, verification_key: '0xvk2', set_active: false },
        ];
        const result = mapExtrinsicArgs(
            'zkVerifier',
            'batchRegisterVerificationKeys',
            named({ entries }),
        );
        const mapped = result['entries'] as Array<Record<string, unknown>>;
        expect(mapped).toHaveLength(2);
        expect(mapped[0]!['circuit_id']).toBe('A');
        expect(mapped[1]!['set_active']).toBe(false);
    });

    it('maps verifyProof (positional)', () => {
        const result = mapExtrinsicArgs(
            'zkVerifier',
            'verifyProof',
            positional('shield-v1', '0xproof', ['pub1', 'pub2']),
        );
        expect(result).toEqual({
            circuit_id: 'shield-v1',
            proof: '0xproof',
            public_inputs: ['pub1', 'pub2'],
        });
    });
});

// ─── mapZkEventData — passthrough ─────────────────────────────────────────────

describe('mapZkEventData — passthrough', () => {
    it('returns original data for unknown event', () => {
        const raw = { arg0: 'foo', arg1: 'bar' };
        expect(mapZkEventData('unknownEvent', raw)).toEqual(raw);
    });
});

// ─── mapZkEventData — shielded-pool events ────────────────────────────────────

describe('mapZkEventData — shielded', () => {
    it('maps shielded event (semantic keys)', () => {
        const result = mapZkEventData(
            'shielded',
            named({
                depositor: '0xAlice',
                amount: '1000000000000000000',
                commitment: '0xcommit',
                encrypted_memo: '0xmemo',
                leaf_index: 5,
            }),
        );
        expect(result['sender']).toBe('0xAlice');
        expect(result['index']).toBe(5);
    });

    it('maps deposit as alias for shielded', () => {
        const result = mapZkEventData('deposit', positional('0xSender', '500', '0xcommit'));
        expect(result['sender']).toBe('0xSender');
        expect(result['amount']).toMatch(/\d/); // formatted
        expect(result['commitment']).toBe('0xcommit');
    });

    it('maps privateTransfer event', () => {
        const result = mapZkEventData(
            'privateTransfer',
            named({ nullifiers: ['0xn1'], commitments: ['0xc1'], encrypted_memos: ['0xm1'], leaf_indices: [0] }),
        );
        expect(result['nullifiers']).toEqual(['0xn1']);
        expect(result['memos']).toEqual(['0xm1']);
        expect(result['indices']).toEqual([0]);
    });

    it('maps unshielded event (positional keys)', () => {
        const result = mapZkEventData('unshielded', positional('0xnull', '2000000000000000000', '0xrecip'));
        expect(result['nullifier']).toBe('0xnull');
        expect(result['recipient']).toBe('0xrecip');
    });

    it('maps merkleRootUpdated event (positional keys)', () => {
        const result = mapZkEventData('merkleRootUpdated', positional('0xold', '0xnew', 100));
        expect(result).toEqual({ old_root: '0xold', new_root: '0xnew', size: 100 });
    });
});

// ─── mapZkEventData — account-mapping events ─────────────────────────────────

describe('mapZkEventData — account-mapping', () => {
    it('maps accountMapped (positional)', () => {
        const result = mapZkEventData('accountMapped', positional('0xaccount', '0xaddress'));
        expect(result).toEqual({ account: '0xaccount', address: '0xaddress' });
    });

    it('maps aliasRegistered (semantic keys)', () => {
        const result = mapZkEventData(
            'aliasRegistered',
            named({ account: '0xAcc', alias: 'alice', evm_address: '0xEvm' }),
        );
        expect(result).toEqual({ account: '0xAcc', alias: 'alice', evm_address: '0xEvm' });
    });

    it('maps aliasSold (positional)', () => {
        const result = mapZkEventData('aliasSold', positional('0xSeller', '0xBuyer', 'alice', '10000'));
        expect(result).toEqual({
            seller: '0xSeller',
            buyer: '0xBuyer',
            alias: 'alice',
            price: '10000',
        });
    });

    it('maps metadataUpdated', () => {
        const result = mapZkEventData('metadataUpdated', named({ account: '0xAcc' }));
        expect(result).toEqual({ account: '0xAcc' });
    });
});

// ─── mapZkEventData — system events ──────────────────────────────────────────

describe('mapZkEventData — system', () => {
    it('maps extrinsicSuccess', () => {
        const result = mapZkEventData('extrinsicSuccess', named({ dispatch_info: { weight: 100 } }));
        expect(result).toEqual({ dispatch_info: { weight: 100 } });
    });

    it('maps extrinsicFailed', () => {
        const result = mapZkEventData(
            'extrinsicFailed',
            positional({ module: 'balances', error: 'InsufficientBalance' }, { weight: 200 }),
        );
        expect(result['dispatch_error']).toBeDefined();
        expect(result['dispatch_info']).toBeDefined();
    });

    it('maps newAccount', () => {
        const result = mapZkEventData('newAccount', named({ account: '0xNew' }));
        expect(result).toEqual({ account: '0xNew' });
    });
});

// ─── mapZkEventData — balances events ────────────────────────────────────────

describe('mapZkEventData — balances', () => {
    it('maps transfer event', () => {
        const result = mapZkEventData('transfer', positional('0xFrom', '0xTo', '100'));
        expect(result).toEqual({ from: '0xFrom', to: '0xTo', amount: '100' });
    });

    it('maps reserved event', () => {
        const result = mapZkEventData('reserved', named({ who: '0xWho', amount: '50' }));
        expect(result).toEqual({ who: '0xWho', amount: '50' });
    });

    it('maps endowed event', () => {
        const result = mapZkEventData('endowed', positional('0xAccount', '1000'));
        expect(result).toEqual({ account: '0xAccount', free_balance: '1000' });
    });
});

// ─── mapZkEventData — zk-verifier events ─────────────────────────────────────

describe('mapZkEventData — zk-verifier', () => {
    it('maps verificationKeyRegistered', () => {
        const result = mapZkEventData(
            'verificationKeyRegistered',
            positional('shield-v1', 2),
        );
        expect(result).toEqual({ circuit_id: 'shield-v1', version: 2 });
    });

    it('maps proofVerified', () => {
        const result = mapZkEventData('proofVerified', named({ circuit_id: 'transfer', version: 1 }));
        expect(result).toEqual({ circuit_id: 'transfer', version: 1 });
    });
});
