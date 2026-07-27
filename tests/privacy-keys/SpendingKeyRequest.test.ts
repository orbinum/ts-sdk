import { describe, it, expect } from 'vitest';
import {
    deriveSpendingKeyTypedData,
    deriveSpendingKeyMessageV2,
    deriveSpendingKeyMessage,
    SPENDING_KEY_VERIFYING_CONTRACT,
    SPENDING_KEY_WARNING,
} from '../../src/privacy-keys/SpendingKeyRequest';
import { PRECOMPILE_ADDR } from '../../src/precompiles/addresses';

const CHAIN_ID = 2700;
const ADDR = '0xAbCdEf0123456789AbCdEf0123456789AbCdEf01';
const LOWER = ADDR.toLowerCase();

// ─── Shared constants ────────────────────────────────────────────────────────

describe('SPENDING_KEY_VERIFYING_CONTRACT', () => {
    // The address is part of the EIP-712 digest: if it ever drifts from the
    // precompile registry, every derived spending key changes and every existing
    // note is orphaned. Pinning it here is what makes the single-source-of-truth
    // re-export load-bearing instead of cosmetic.
    it('is the shielded pool precompile, from the single source of truth', () => {
        expect(SPENDING_KEY_VERIFYING_CONTRACT).toBe(PRECOMPILE_ADDR.SHIELDED_POOL);
    });

    it('pins the on-chain precompile address (2049 → 0x…0801)', () => {
        expect(SPENDING_KEY_VERIFYING_CONTRACT).toBe(
            '0x0000000000000000000000000000000000000801'
        );
    });
});

describe('SPENDING_KEY_WARNING', () => {
    it('states that signing grants full control of private funds', () => {
        expect(SPENDING_KEY_WARNING).toMatch(/full control/i);
        expect(SPENDING_KEY_WARNING).toMatch(/private funds/i);
    });

    it('names the official app as the only place to sign', () => {
        expect(SPENDING_KEY_WARNING).toMatch(/official Orbinum app/i);
    });
});

// ─── EVM route (EIP-712) ─────────────────────────────────────────────────────

describe('deriveSpendingKeyTypedData', () => {
    it('binds the domain to the shielded pool precompile', () => {
        const td = deriveSpendingKeyTypedData(CHAIN_ID, ADDR);
        expect(td.domain.verifyingContract).toBe(SPENDING_KEY_VERIFYING_CONTRACT);
        expect(td.domain.chainId).toBe(CHAIN_ID);
        expect(td.domain.name).toBe('Orbinum Shielded Pool');
        expect(td.domain.version).toBe('2');
    });

    it('declares the primary type it signs', () => {
        const td = deriveSpendingKeyTypedData(CHAIN_ID, ADDR);
        expect(td.primaryType).toBe('SpendingKeyDerivation');
        expect(td.types.SpendingKeyDerivation).toBeDefined();
    });

    // The wallet renders message fields verbatim, so the warning reaches the user
    // through the one channel a hostile origin cannot rewrite. Dropping the field
    // from `types` would silently stop it from being displayed.
    it('carries the warning as a declared, rendered message field', () => {
        const td = deriveSpendingKeyTypedData(CHAIN_ID, ADDR);
        expect(td.message.warning).toBe(SPENDING_KEY_WARNING);
        expect(td.types.SpendingKeyDerivation.map((f) => f.name)).toContain('warning');
    });

    it('binds the signing account into the message', () => {
        const td = deriveSpendingKeyTypedData(CHAIN_ID, ADDR);
        expect(td.message.account).toBe(LOWER);
        expect(td.types.SpendingKeyDerivation.map((f) => f.name)).toContain('account');
    });

    // A digest that varies per session would derive a different spending key each
    // time and make already-shielded notes unspendable. This is why the payload
    // carries no nonce or timestamp.
    it('is deterministic across calls', () => {
        expect(deriveSpendingKeyTypedData(CHAIN_ID, ADDR)).toEqual(
            deriveSpendingKeyTypedData(CHAIN_ID, ADDR)
        );
    });

    it('contains no nonce, timestamp or challenge field', () => {
        const fields = deriveSpendingKeyTypedData(CHAIN_ID, ADDR).types.SpendingKeyDerivation.map(
            (f) => f.name
        );
        expect(fields).not.toContain('nonce');
        expect(fields).not.toContain('timestamp');
        expect(fields).not.toContain('deadline');
        expect(fields).not.toContain('challenge');
    });

    it('lowercases the account so checksum casing cannot fork the identity', () => {
        expect(deriveSpendingKeyTypedData(CHAIN_ID, ADDR).message.account).toBe(
            deriveSpendingKeyTypedData(CHAIN_ID, LOWER).message.account
        );
    });

    it('separates identities per chain', () => {
        expect(deriveSpendingKeyTypedData(1, ADDR).domain.chainId).not.toBe(
            deriveSpendingKeyTypedData(2, ADDR).domain.chainId
        );
    });
});

// ─── Substrate route (raw message) ───────────────────────────────────────────

describe('deriveSpendingKeyMessageV2', () => {
    // Substrate has no EIP-712, so the warning must lead the raw text — it is the
    // only part the extension is guaranteed to show before any truncation.
    it('leads with the warning, since the wallet renders raw text', () => {
        const msg = deriveSpendingKeyMessageV2(CHAIN_ID, ADDR);
        expect(msg.startsWith('⚠ ')).toBe(true);
        expect(msg).toContain(SPENDING_KEY_WARNING);
    });

    it('tags the message with the v2 domain', () => {
        expect(deriveSpendingKeyMessageV2(CHAIN_ID, ADDR)).toContain('orbinum-spending-key-v2');
    });

    it('binds chainId and lowercased address', () => {
        const msg = deriveSpendingKeyMessageV2(CHAIN_ID, ADDR);
        expect(msg).toContain(`${CHAIN_ID}`);
        expect(msg).toContain(LOWER);
        expect(msg).not.toContain(ADDR);
    });

    it('is deterministic across calls', () => {
        expect(deriveSpendingKeyMessageV2(CHAIN_ID, ADDR)).toBe(
            deriveSpendingKeyMessageV2(CHAIN_ID, ADDR)
        );
    });

    it('lowercases the address so checksum casing cannot fork the identity', () => {
        expect(deriveSpendingKeyMessageV2(CHAIN_ID, ADDR)).toBe(
            deriveSpendingKeyMessageV2(CHAIN_ID, LOWER)
        );
    });

    it('separates identities per chain and per address', () => {
        expect(deriveSpendingKeyMessageV2(1, ADDR)).not.toBe(deriveSpendingKeyMessageV2(2, ADDR));
        expect(deriveSpendingKeyMessageV2(CHAIN_ID, ADDR)).not.toBe(
            deriveSpendingKeyMessageV2(CHAIN_ID, '0x1111111111111111111111111111111111111111')
        );
    });
});

// ─── Legacy route (v1, sweep-only) ───────────────────────────────────────────

describe('deriveSpendingKeyMessage (v1, deprecated)', () => {
    it('still reproduces the historical string so v1 notes stay sweepable', () => {
        expect(deriveSpendingKeyMessage(CHAIN_ID, ADDR)).toBe(
            `orbinum-spending-key-v1\n${CHAIN_ID}\n${LOWER}`
        );
    });

    // v1's defining flaw: a fixed public string with no warning and no domain, so
    // a hostile origin can request it and reuse the deterministic signature. These
    // assertions document that flaw rather than guard against it — v1 must NOT be
    // "fixed" in place, because changing it would break sweeping.
    it('carries no warning and no v2 domain tag', () => {
        const msg = deriveSpendingKeyMessage(CHAIN_ID, ADDR);
        expect(msg).not.toContain(SPENDING_KEY_WARNING);
        expect(msg).not.toContain('⚠');
        expect(msg).not.toContain('orbinum-spending-key-v2');
    });

    it('is distinct from the v2 message for the same inputs', () => {
        expect(deriveSpendingKeyMessage(CHAIN_ID, ADDR)).not.toBe(
            deriveSpendingKeyMessageV2(CHAIN_ID, ADDR)
        );
    });
});
