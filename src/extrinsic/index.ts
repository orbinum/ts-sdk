/**
 * Utilities for decoding on-chain extrinsic arguments and event data.
 *
 * Substrate/PAPI nodes return positional arg keys (`arg0`, `arg1`, …) when
 * metadata-based decoding is unavailable. These helpers map those positions
 * to human-readable semantic names for all Orbinum pallets.
 */

import { formatBalance } from '../utils/format';

// ─────────────────────────────────────────────────────────────────────────────
// PARSERS & MAPPERS
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Maps raw extrinsic args (which may use positional keys like `arg0`, `arg1`)
 * to semantic field names for a given pallet section/method.
 *
 * @param section - Pallet name (e.g. `'shieldedPool'`).
 * @param method  - Call name (e.g. `'shield'`).
 * @param args    - Raw args object from the node.
 * @returns Remapped args with semantic keys, or the original object if unknown.
 */
export function mapExtrinsicArgs(
    section: string,
    method: string,
    args: Record<string, unknown>
): Record<string, unknown> {
    if (!args || Object.keys(args).length === 0) return args;

    const s = section.toLowerCase();
    const m = method.toLowerCase();

    const get = (idx: number, name: string) => {
        if (name in args) return args[name];
        const argKey = `arg${idx}`;
        if (argKey in args) return args[argKey];
        if (idx in args) return args[idx];
        const strIdx = idx.toString();
        if (strIdx in args) return args[strIdx];
        return undefined;
    };

    if (s === 'system') {
        const m_norm = m.replace(/_/g, '');
        if (m_norm === 'remark' || m_norm === 'remarkwithevent') {
            return { remark: get(0, 'remark') };
        }
        if (m_norm === 'setheappages') {
            return { pages: get(0, 'pages') };
        }
        if (m_norm === 'setcode' || m_norm === 'setcodewithoutchecks') {
            return { code: get(0, 'code') };
        }
        if (m_norm === 'setstorage') {
            return { items: get(0, 'items') };
        }
        if (m_norm === 'killstorage') {
            return { keys: get(0, 'keys') };
        }
        if (m_norm === 'killprefix') {
            return {
                prefix: get(0, 'prefix'),
                subkeys: get(1, 'subkeys'),
            };
        }
        if (m_norm === 'authorizeupgrade' || m_norm === 'authorizeupgradewithoutchecks') {
            return { code_hash: get(0, 'code_hash') };
        }
        if (m_norm === 'applyauthorizedupgrade') {
            return { code: get(0, 'code') };
        }
    }

    if (s === 'timestamp') {
        if (m === 'set') {
            return { now: get(0, 'now') };
        }
    }

    if (s === 'balances') {
        const m_norm = m.replace(/_/g, '');
        if (m_norm.startsWith('transfer')) {
            return {
                recipient: get(0, 'dest') || get(0, 'destination') || get(0, 'recipient'),
                amount: get(1, 'value') || get(1, 'amount'),
            };
        }
        if (m_norm === 'forcetransfer') {
            return {
                source: get(0, 'source'),
                dest: get(1, 'dest'),
                value: get(2, 'value'),
            };
        }
        if (m_norm === 'forceunreserve') {
            return {
                who: get(0, 'who'),
                amount: get(1, 'amount'),
            };
        }
        if (m_norm === 'upgradeaccounts') {
            return { who: get(0, 'who') };
        }
        if (m_norm === 'forcesetbalance') {
            return {
                who: get(0, 'who'),
                new_free: get(1, 'new_free'),
            };
        }
        if (m_norm === 'forceadjusttotalissuance') {
            return {
                direction: get(0, 'direction'),
                delta: get(1, 'delta'),
            };
        }
        if (m_norm === 'burn') {
            return {
                value: get(0, 'value'),
                keep_alive: get(1, 'keep_alive'),
            };
        }
    }

    if (s === 'sudo') {
        const m_norm = m.replace(/_/g, '');
        if (m_norm === 'sudo') {
            return { call: get(0, 'call') };
        }
        if (m_norm === 'sudouncheckedweight') {
            return {
                call: get(0, 'call'),
                weight: get(1, 'weight'),
            };
        }
        if (m_norm === 'setkey') {
            return { new: get(0, 'new') };
        }
        if (m_norm === 'sudoas') {
            return {
                who: get(0, 'who'),
                call: get(1, 'call'),
            };
        }
    }

    if (s === 'grandpa') {
        const m_norm = m.replace(/_/g, '');
        if (m_norm === 'reportequivocation' || m_norm === 'reportequivocationunsigned') {
            return {
                equivocation_proof: get(0, 'equivocation_proof'),
                key_owner_proof: get(1, 'key_owner_proof'),
            };
        }
        if (m_norm === 'notestalled') {
            return {
                delay: get(0, 'delay'),
                best_finalized_block_number: get(1, 'best_finalized_block_number'),
            };
        }
    }

    if (s === 'shieldedpool') {
        const m_norm = m.replace(/_/g, '');
        if (m_norm === 'shield') {
            return {
                asset_id: get(0, 'asset_id'),
                amount: get(1, 'amount'),
                commitment: get(2, 'commitment'),
                encrypted_memo: get(3, 'encrypted_memo'),
            };
        }
        if (m_norm === 'shieldbatch') {
            const ops = get(0, 'operations') || get(0, 'arg0');
            if (Array.isArray(ops)) {
                return {
                    operations: ops.map((op) => {
                        if (Array.isArray(op)) {
                            return {
                                asset_id: op[0],
                                amount: op[1],
                                commitment: op[2],
                                encrypted_memo: op[3],
                            };
                        }
                        return op;
                    }),
                };
            }
            return { operations: ops };
        }
        if (m_norm === 'privatetransfer' || m_norm === 'transfer') {
            return {
                proof: get(0, 'proof'),
                merkle_root: get(1, 'merkle_root'),
                nullifiers: get(2, 'nullifiers'),
                commitments: get(3, 'commitments'),
                encrypted_memos: get(4, 'encrypted_memos'),
            };
        }
        if (m_norm === 'unshield') {
            return {
                proof: get(0, 'proof'),
                merkle_root: get(1, 'merkle_root'),
                nullifier: get(2, 'nullifier'),
                asset_id: get(3, 'asset_id'),
                amount: get(4, 'amount'),
                recipient: get(5, 'recipient'),
            };
        }
        if (m_norm === 'setauditpolicy') {
            return {
                auditors: get(0, 'auditors'),
                conditions: get(1, 'conditions'),
                max_frequency: get(2, 'max_frequency'),
                valid_until: get(3, 'valid_until'),
            };
        }
        if (m_norm === 'requestdisclosure') {
            return {
                target: get(0, 'target'),
                reason: get(1, 'reason'),
            };
        }
        if (m_norm === 'disclose') {
            return {
                commitment: get(0, 'commitment'),
                proof_bytes: get(1, 'proof_bytes'),
                public_signals: get(2, 'public_signals'),
                auditor: get(3, 'auditor'),
            };
        }
        if (m_norm === 'rejectdisclosure') {
            return {
                auditor: get(0, 'auditor'),
                reason: get(1, 'reason'),
            };
        }
        if (m_norm === 'registerasset') {
            return {
                name: get(0, 'name'),
                symbol: get(1, 'symbol'),
                decimals: get(2, 'decimals'),
                contract_address: get(3, 'contract_address'),
            };
        }
        if (m_norm === 'verifyasset') {
            return { asset_id: get(0, 'asset_id') };
        }
        if (m_norm === 'unverifyasset') {
            return { asset_id: get(0, 'asset_id') };
        }
        if (m_norm === 'batchsubmitdisclosureproofs') {
            return { submissions: get(0, 'submissions') };
        }
        if (m_norm === 'pruneexpiredrequest') {
            return {
                target: get(0, 'target'),
                auditor: get(1, 'auditor'),
            };
        }
        if (m_norm === 'revokedisclosurerecord') {
            return { commitment: get(0, 'commitment') };
        }
    }

    if (s === 'ethereum' && m === 'transact') {
        return { transaction: get(0, 'transaction') };
    }

    if (s === 'evm') {
        if (m === 'withdraw') {
            return {
                address: get(0, 'address'),
                value: get(1, 'value'),
            };
        }
        if (m === 'call') {
            return {
                source: get(0, 'source'),
                target: get(1, 'target'),
                input: get(2, 'input'),
                value: get(3, 'value'),
                gas_limit: get(4, 'gas_limit'),
                max_fee_per_gas: get(5, 'max_fee_per_gas'),
                max_priority_fee_per_gas: get(6, 'max_priority_fee_per_gas'),
                nonce: get(7, 'nonce'),
                access_list: get(8, 'access_list'),
                authorization_list: get(9, 'authorization_list'),
            };
        }
        if (m === 'create') {
            return {
                source: get(0, 'source'),
                init: get(1, 'init'),
                value: get(2, 'value'),
                gas_limit: get(3, 'gas_limit'),
                max_fee_per_gas: get(4, 'max_fee_per_gas'),
                max_priority_fee_per_gas: get(5, 'max_priority_fee_per_gas'),
                nonce: get(6, 'nonce'),
                access_list: get(7, 'access_list'),
                authorization_list: get(8, 'authorization_list'),
            };
        }
        if (m === 'create2') {
            return {
                source: get(0, 'source'),
                init: get(1, 'init'),
                salt: get(2, 'salt'),
                value: get(3, 'value'),
                gas_limit: get(4, 'gas_limit'),
                max_fee_per_gas: get(5, 'max_fee_per_gas'),
                max_priority_fee_per_gas: get(6, 'max_priority_fee_per_gas'),
                nonce: get(7, 'nonce'),
                access_list: get(8, 'access_list'),
                authorization_list: get(9, 'authorization_list'),
            };
        }
    }

    if (s === 'accountmapping') {
        const m_norm = m.replace(/_/g, '');
        if (m_norm === 'registeralias') {
            return { alias: get(0, 'alias') };
        }
        if (m_norm === 'transferalias') {
            return { new_owner: get(0, 'new_owner') };
        }
        if (m_norm === 'putaliasonsale') {
            return {
                price: get(0, 'price'),
                allowed_buyers: get(1, 'allowed_buyers'),
            };
        }
        if (m_norm === 'buyalias') {
            return { alias: get(0, 'alias') };
        }
        if (m_norm === 'addchainlink') {
            return {
                chain_id: get(0, 'chain_id'),
                address: get(1, 'address'),
                signature: get(2, 'signature'),
            };
        }
        if (m_norm === 'removechainlink') {
            return { chain_id: get(0, 'chain_id') };
        }
        if (m_norm === 'setaccountmetadata') {
            return {
                display_name: get(0, 'display_name'),
                bio: get(1, 'bio'),
                avatar: get(2, 'avatar'),
            };
        }
        if (m_norm === 'addsupportedchain') {
            return {
                chain_id: get(0, 'chain_id'),
                scheme: get(1, 'scheme'),
            };
        }
        if (m_norm === 'removesupportedchain') {
            return { chain_id: get(0, 'chain_id') };
        }
        if (m_norm === 'dispatchaslinkedaccount') {
            return {
                owner: get(0, 'owner'),
                chain_id: get(1, 'chain_id'),
                address: get(2, 'address'),
                signature: get(3, 'signature'),
                call: get(4, 'call'),
            };
        }
        if (m_norm === 'registerprivatelink') {
            return {
                chain_id: get(0, 'chain_id'),
                commitment: get(1, 'commitment'),
            };
        }
        if (m_norm === 'removeprivatelink') {
            return { commitment: get(0, 'commitment') };
        }
        if (m_norm === 'revealprivatelink') {
            return {
                commitment: get(0, 'commitment'),
                address: get(1, 'address'),
                blinding: get(2, 'blinding'),
                signature: get(3, 'signature'),
            };
        }
        if (m_norm === 'dispatchasprivatelink') {
            return {
                owner: get(0, 'owner'),
                commitment: get(1, 'commitment'),
                zk_proof: get(2, 'zk_proof'),
                call: get(3, 'call'),
            };
        }
    }

    if (s === 'zkverifier') {
        const m_norm = m.replace(/_/g, '');
        if (m_norm === 'batchregisterverificationkeys') {
            const entries = get(0, 'entries');
            if (Array.isArray(entries)) {
                return {
                    entries: entries.map((e: Record<string, unknown>) => ({
                        circuit_id: e['circuit_id'],
                        version: e['version'],
                        verification_key: e['verification_key'],
                        set_active: e['set_active'],
                    })),
                };
            }
            return { entries };
        }
        if (m_norm === 'registerverificationkey') {
            return {
                circuit_id: get(0, 'circuit_id'),
                version: get(1, 'version'),
                verification_key: get(2, 'verification_key'),
            };
        }
        if (m_norm === 'setactiveversion') {
            return {
                circuit_id: get(0, 'circuit_id'),
                version: get(1, 'version'),
            };
        }
        if (m_norm === 'removeverificationkey') {
            return {
                circuit_id: get(0, 'circuit_id'),
                version: get(1, 'version'),
            };
        }
        if (m_norm === 'verifyproof') {
            return {
                circuit_id: get(0, 'circuit_id'),
                proof: get(1, 'proof'),
                public_inputs: get(2, 'public_inputs'),
            };
        }
    }

    return args;
}

/**
 * Maps raw event data fields (which may use positional keys) to semantic names
 * for shielded-pool, account-mapping, zk-verifier, evm, ethereum and system events.
 *
 * @param method - Event name (e.g. `'shielded'`, `'aliasRegistered'`).
 * @param data   - Raw event data fields.
 * @returns Remapped data with semantic keys, or the original object if unknown.
 */
export function mapZkEventData(
    method: string,
    data: Record<string, unknown>
): Record<string, unknown> {
    const m = method.toLowerCase();

    const get = (idx: number, name: string) => {
        if (name in data) return data[name];
        const argKey = `arg${idx}`;
        if (argKey in data) return data[argKey];
        if (idx in data) return data[idx];
        const strIdx = idx.toString();
        if (strIdx in data) return data[strIdx];
        return undefined;
    };

    const formatAmount = (val: unknown): string | null => {
        if (val === undefined || val === null) return null;
        return formatBalance(String(val));
    };

    if (m === 'shielded' || m === 'deposit') {
        return {
            sender: get(0, 'depositor') || get(0, 'sender'),
            amount: formatAmount(get(1, 'amount')),
            commitment: get(2, 'commitment'),
            memo: get(3, 'encrypted_memo') || get(3, 'memo'),
            index: get(4, 'leaf_index') || get(4, 'index'),
        };
    }

    if (m === 'privatetransfer') {
        return {
            nullifiers: get(0, 'nullifiers'),
            commitments: get(1, 'commitments'),
            memos: get(2, 'encrypted_memos') || get(2, 'memos'),
            indices: get(3, 'leaf_indices') || get(3, 'indices'),
        };
    }

    if (m === 'unshielded' || m === 'withdraw') {
        return {
            nullifier: get(0, 'nullifier'),
            amount: formatAmount(get(1, 'amount')),
            recipient: get(2, 'recipient'),
        };
    }

    if (m === 'merklerootupdated' || m === 'merkleroot') {
        return {
            old_root: get(0, 'old_root'),
            new_root: get(1, 'new_root'),
            size: get(2, 'tree_size') || get(2, 'size'),
        };
    }

    // ── shielded-pool — remaining events ────────────────────────────────────

    const m_norm = m.replace(/_/g, '');

    if (m_norm === 'auditpolicyset') {
        return {
            account: get(0, 'account'),
            version: get(1, 'version'),
        };
    }

    if (m_norm === 'disclosed') {
        return {
            who: get(0, 'who'),
            commitment: get(1, 'commitment'),
            auditor: get(2, 'auditor'),
        };
    }

    if (m_norm === 'disclosurerequested') {
        return {
            target: get(0, 'target'),
            auditor: get(1, 'auditor'),
            reason: get(2, 'reason'),
        };
    }

    if (m_norm === 'disclosurerejected') {
        return {
            target: get(0, 'target'),
            auditor: get(1, 'auditor'),
            reason: get(2, 'reason'),
        };
    }

    if (m_norm === 'disclosurerequestexpired') {
        return {
            target: get(0, 'target'),
            auditor: get(1, 'auditor'),
        };
    }

    if (m_norm === 'disclosurerecordrevoked') {
        return {
            who: get(0, 'who'),
            commitment: get(1, 'commitment'),
        };
    }

    if (m_norm === 'assetregistered') {
        return { asset_id: get(0, 'asset_id') };
    }

    if (m_norm === 'assetverified') {
        return { asset_id: get(0, 'asset_id') };
    }

    if (m_norm === 'assetunverified') {
        return { asset_id: get(0, 'asset_id') };
    }

    // ── account-mapping events ───────────────────────────────────────────────

    if (m_norm === 'accountmapped' || m_norm === 'accountunmapped') {
        return {
            account: get(0, 'account'),
            address: get(1, 'address'),
        };
    }

    if (m_norm === 'aliasregistered') {
        return {
            account: get(0, 'account'),
            alias: get(1, 'alias'),
            evm_address: get(2, 'evm_address'),
        };
    }

    if (m_norm === 'aliasreleased') {
        return {
            account: get(0, 'account'),
            alias: get(1, 'alias'),
        };
    }

    if (m_norm === 'aliastransferred') {
        return {
            from: get(0, 'from'),
            to: get(1, 'to'),
            alias: get(2, 'alias'),
        };
    }

    if (m_norm === 'aliaslistedforsale') {
        return {
            seller: get(0, 'seller'),
            alias: get(1, 'alias'),
            price: get(2, 'price'),
            private: get(3, 'private'),
        };
    }

    if (m_norm === 'aliassalecancelled') {
        return {
            seller: get(0, 'seller'),
            alias: get(1, 'alias'),
        };
    }

    if (m_norm === 'aliassold') {
        return {
            seller: get(0, 'seller'),
            buyer: get(1, 'buyer'),
            alias: get(2, 'alias'),
            price: get(3, 'price'),
        };
    }

    if (m_norm === 'chainlinkadded') {
        return {
            account: get(0, 'account'),
            chain_id: get(1, 'chain_id'),
            address: get(2, 'address'),
        };
    }

    if (m_norm === 'chainlinkremoved') {
        return {
            account: get(0, 'account'),
            chain_id: get(1, 'chain_id'),
        };
    }

    if (m_norm === 'metadataupdated') {
        return { account: get(0, 'account') };
    }

    if (m_norm === 'supportedchainadded') {
        return {
            chain_id: get(0, 'chain_id'),
            scheme: get(1, 'scheme'),
        };
    }

    if (m_norm === 'supportedchainremoved') {
        return { chain_id: get(0, 'chain_id') };
    }

    if (m_norm === 'proxycallexecuted') {
        return {
            owner: get(0, 'owner'),
            chain_id: get(1, 'chain_id'),
            address: get(2, 'address'),
        };
    }

    if (m_norm === 'privatechainlinkadded' || m_norm === 'privatechainlinkremoved') {
        return {
            account: get(0, 'account'),
            chain_id: get(1, 'chain_id'),
            commitment: get(2, 'commitment'),
        };
    }

    if (m_norm === 'privatechainlinkrevealed') {
        return {
            account: get(0, 'account'),
            chain_id: get(1, 'chain_id'),
            address: get(2, 'address'),
        };
    }

    if (m_norm === 'privatelinkdispatchexecuted') {
        return {
            owner: get(0, 'owner'),
            commitment: get(1, 'commitment'),
        };
    }

    // ── zk-verifier events ───────────────────────────────────────────────────

    if (
        m_norm === 'verificationkeyregistered' ||
        m_norm === 'activeversionset' ||
        m_norm === 'verificationkeyremoved' ||
        m_norm === 'proofverified' ||
        m_norm === 'proofverificationfailed'
    ) {
        return {
            circuit_id: get(0, 'circuit_id'),
            version: get(1, 'version'),
        };
    }

    // ── evm events ───────────────────────────────────────────────────────────

    if (m_norm === 'log') {
        return { log: get(0, 'log') };
    }

    if (
        m_norm === 'created' ||
        m_norm === 'createdfailed' ||
        m_norm === 'executed' ||
        m_norm === 'executedfailed'
    ) {
        return { address: get(0, 'address') };
    }

    // ── ethereum events ───────────────────────────────────────────────────────

    if (m_norm === 'executed') {
        return {
            from: get(0, 'from'),
            to: get(1, 'to'),
            transaction_hash: get(2, 'transaction_hash'),
            exit_reason: get(3, 'exit_reason'),
        };
    }

    // ── system events ────────────────────────────────────────────────────────

    if (m_norm === 'extrinsicsuccess') {
        return { dispatch_info: get(0, 'dispatch_info') };
    }

    if (m_norm === 'extrinsicfailed') {
        return {
            dispatch_error: get(0, 'dispatch_error'),
            dispatch_info: get(1, 'dispatch_info'),
        };
    }

    if (m_norm === 'newaccount' || m_norm === 'killedaccount') {
        return { account: get(0, 'account') };
    }

    if (m_norm === 'remarked') {
        return {
            sender: get(0, 'sender'),
            hash: get(1, 'hash'),
        };
    }

    if (m_norm === 'upgradeauthorized') {
        return {
            code_hash: get(0, 'code_hash'),
            check_version: get(1, 'check_version'),
        };
    }

    if (m_norm === 'rejectedinvalidauthorizedupgrade') {
        return {
            code_hash: get(0, 'code_hash'),
            error: get(1, 'error'),
        };
    }

    // ── balances events ───────────────────────────────────────────────────────

    if (m_norm === 'endowed') {
        return {
            account: get(0, 'account'),
            free_balance: get(1, 'free_balance'),
        };
    }

    if (m_norm === 'dustlost') {
        return {
            account: get(0, 'account'),
            amount: get(1, 'amount'),
        };
    }

    if (m_norm === 'transfer') {
        return {
            from: get(0, 'from'),
            to: get(1, 'to'),
            amount: get(2, 'amount'),
        };
    }

    if (m_norm === 'balanceset') {
        return {
            who: get(0, 'who'),
            free: get(1, 'free'),
        };
    }

    if (
        m_norm === 'reserved' ||
        m_norm === 'unreserved' ||
        m_norm === 'deposit' ||
        m_norm === 'slashed' ||
        m_norm === 'minted' ||
        m_norm === 'burned' ||
        m_norm === 'suspended' ||
        m_norm === 'restored' ||
        m_norm === 'locked' ||
        m_norm === 'unlocked' ||
        m_norm === 'frozen' ||
        m_norm === 'thawed'
    ) {
        return {
            who: get(0, 'who'),
            amount: get(1, 'amount'),
        };
    }

    if (m_norm === 'reserverepatriated') {
        return {
            from: get(0, 'from'),
            to: get(1, 'to'),
            amount: get(2, 'amount'),
            destination_status: get(3, 'destination_status'),
        };
    }

    if (m_norm === 'upgraded') {
        return { who: get(0, 'who') };
    }

    if (m_norm === 'issued' || m_norm === 'rescinded') {
        return { amount: get(0, 'amount') };
    }

    if (m_norm === 'totalissuanceforced') {
        return {
            old: get(0, 'old'),
            new: get(1, 'new'),
        };
    }

    // ── sudo events ───────────────────────────────────────────────────────────

    if (m_norm === 'sudid' || m_norm === 'sudoasdone') {
        return { sudo_result: get(0, 'sudo_result') };
    }

    if (m_norm === 'keychanged') {
        return {
            old: get(0, 'old'),
            new: get(1, 'new'),
        };
    }

    // ── grandpa events ────────────────────────────────────────────────────────

    if (m_norm === 'newauthorities') {
        return { authority_set: get(0, 'authority_set') };
    }

    // ── transaction-payment events ────────────────────────────────────────────

    if (m_norm === 'transactionfeepaid') {
        return {
            who: get(0, 'who'),
            actual_fee: get(1, 'actual_fee'),
            tip: get(2, 'tip'),
        };
    }

    return data;
}
