import { describe, it, expect } from 'vitest';
import { base58 } from '@scure/base';
import { blake2b } from '@noble/hashes/blake2.js';
import { canonicalAccountId } from '../../src/privacy-keys/accountIdentity';
import {
    deriveMasterKeyBytes,
    deriveSpendingKeyFromSignature,
} from '../../src/privacy-keys/PrivacyKeys';
import { deriveSpendingKeyMessageV2 } from '../../src/privacy-keys/SpendingKeyRequest';

/** Re-encodes a public key under an arbitrary SS58 network prefix. */
function ss58Encode(publicKey: Uint8Array, prefix: number): string {
    const prefixBytes =
        prefix < 64
            ? [prefix]
            : [((prefix & 0xfc) >> 2) | 0x40, (prefix >> 8) | ((prefix & 3) << 6)];
    const body = new Uint8Array([...prefixBytes, ...publicKey]);
    const checksum = blake2b(
        new Uint8Array([...new TextEncoder().encode('SS58PRE'), ...body]),
        { dkLen: 64 }
    );
    return base58.encode(new Uint8Array([...body, ...checksum.slice(0, 2)]));
}

// Alice, generic Substrate prefix 42.
const ALICE_42 = '5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY';
const ALICE_PK = Uint8Array.from(
    Buffer.from('d43593c715fdd31c61141abd04a99fd6822c8558854ccde39a5684e7a56da27d', 'hex')
);
const ALICE_2700 = ss58Encode(ALICE_PK, 2700);
const ALICE_0 = ss58Encode(ALICE_PK, 0);

const BOB_42 = '5FHneW46xGXgs5mUiveU4sbTyGBzmstUspZC92UhjJM694ty';
const SIG = '0x' + 'ab'.repeat(65);
const CHAIN_ID = 2700;

describe('canonicalAccountId', () => {
    it('reduces an SS58 address to its public key', () => {
        expect(canonicalAccountId(ALICE_42)).toBe('0x' + Buffer.from(ALICE_PK).toString('hex'));
    });

    // The core invariant: SS58 encodes the SAME account differently per network
    // prefix. Deriving from the raw string would rotate the spending key the
    // moment a wallet re-listed the account under another prefix.
    it('SECURITY: maps every prefix of one account to the same id', () => {
        expect(ALICE_42).not.toBe(ALICE_2700);
        expect(ALICE_42).not.toBe(ALICE_0);
        expect(canonicalAccountId(ALICE_2700)).toBe(canonicalAccountId(ALICE_42));
        expect(canonicalAccountId(ALICE_0)).toBe(canonicalAccountId(ALICE_42));
    });

    it('SECURITY: keeps distinct accounts distinct', () => {
        expect(canonicalAccountId(BOB_42)).not.toBe(canonicalAccountId(ALICE_42));
    });

    it('passes EVM addresses through, lowercased', () => {
        const evm = '0xAbCdEf0123456789AbCdEf0123456789AbCdEf01';
        expect(canonicalAccountId(evm)).toBe(evm.toLowerCase());
    });

    it('leaves an unrecognised string alone — validation is not its job', () => {
        expect(canonicalAccountId('not-an-address')).toBe('not-an-address');
    });
});

describe('derivation is stable across SS58 prefixes', () => {
    // Failure mode this guards: the user opens the app to an empty vault, with
    // no error, because the wallet handed us the same account under a different
    // prefix and we derived a fresh identity from it.
    it('SECURITY: master bytes are identical across prefixes', async () => {
        const a = await deriveMasterKeyBytes(SIG, CHAIN_ID, ALICE_42);
        const b = await deriveMasterKeyBytes(SIG, CHAIN_ID, ALICE_2700);
        expect(a).toEqual(b);
    });

    it('SECURITY: the spending key is identical across prefixes', async () => {
        const a = await deriveSpendingKeyFromSignature(SIG, CHAIN_ID, ALICE_42);
        const b = await deriveSpendingKeyFromSignature(SIG, CHAIN_ID, ALICE_0);
        expect(a).toBe(b);
    });

    // The signed message feeds the VRF/signRaw output, which becomes the IKM —
    // so a prefix-dependent message would rotate the key just as surely as a
    // prefix-dependent HKDF info.
    it('SECURITY: the signed Substrate message is identical across prefixes', () => {
        expect(deriveSpendingKeyMessageV2(CHAIN_ID, ALICE_2700)).toBe(
            deriveSpendingKeyMessageV2(CHAIN_ID, ALICE_42)
        );
    });

    it('still separates distinct accounts', async () => {
        const alice = await deriveSpendingKeyFromSignature(SIG, CHAIN_ID, ALICE_42);
        const bob = await deriveSpendingKeyFromSignature(SIG, CHAIN_ID, BOB_42);
        expect(alice).not.toBe(bob);
    });
});
