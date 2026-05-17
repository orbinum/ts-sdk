import { describe, it, expect, vi } from 'vitest';
import { ShieldedPoolPrecompile } from '../../src/precompiles/ShieldedPoolPrecompile';
import { SP_SEL, PRECOMPILE_ADDR } from '../../src/precompiles/addresses';
import { toHex } from '../../src/utils/hex';
import { fromHex } from '../../src/utils/hex';
import type { EvmClient } from '../../src/evm/EvmClient';
import type { EvmSigner } from '../../src/precompiles/types';
import type {
  ShieldParams,
  UnshieldParams,
  PrivateTransferParams,
  ClaimShieldedFeesParams,
} from '../../src/shielded-pool/protocol/types';

// ─── Mock helpers ─────────────────────────────────────────────────────────────

function mockEvm(): EvmClient {
  return {
    call: vi.fn(),
    estimateGas: vi.fn().mockResolvedValue(100_000n),
  } as unknown as EvmClient;
}

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const COMMITMENT = '0x' + 'aa'.repeat(32);
const NULLIFIER  = '0x' + 'bb'.repeat(32);
const ROOT       = '0x' + 'cc'.repeat(32);
const PROOF      = new Uint8Array([0x01, 0x02, 0x03, 0x04]);
const RECIPIENT  = '0x' + 'dd'.repeat(32); // 64 hex chars → 32 bytes

const SHIELD_PARAMS: ShieldParams = {
  assetId: 1,
  amount: 1_000_000n,
  commitment: COMMITMENT,
  encryptedMemo: new Uint8Array(176),
};

const UNSHIELD_PARAMS: UnshieldParams = {
  proof: PROOF,
  merkleRoot: ROOT,
  nullifier: NULLIFIER,
  assetId: 1,
  amount: 500_000n,
  recipientAddress: RECIPIENT,
};

const TRANSFER_PARAMS: PrivateTransferParams = {
  proof: PROOF,
  merkleRoot: ROOT,
  inputs:  [{ nullifier: NULLIFIER, commitment: COMMITMENT }],
  outputs: [{ commitment: COMMITMENT, encryptedMemo: new Uint8Array(176) }],
  assetId: 0,
};

// ─── buildShieldCalldata ──────────────────────────────────────────────────────

describe('ShieldedPoolPrecompile.buildShieldCalldata', () => {
  it('starts with SHIELD selector', () => {
    const precompile = new ShieldedPoolPrecompile(mockEvm());
    const calldata = precompile.buildShieldCalldata(SHIELD_PARAMS);
    expect(calldata.startsWith(toHex(SP_SEL.SHIELD))).toBe(true);
  });

  it('returns 0x-prefixed hex string', () => {
    const precompile = new ShieldedPoolPrecompile(mockEvm());
    expect(precompile.buildShieldCalldata(SHIELD_PARAMS).startsWith('0x')).toBe(true);
  });

  it('is deterministic — same params produce same calldata', () => {
    const precompile = new ShieldedPoolPrecompile(mockEvm());
    const a = precompile.buildShieldCalldata(SHIELD_PARAMS);
    const b = precompile.buildShieldCalldata(SHIELD_PARAMS);
    expect(a).toBe(b);
  });

  it('throws when encryptedMemo has wrong size', () => {
    const precompile = new ShieldedPoolPrecompile(mockEvm());
    expect(() =>
      precompile.buildShieldCalldata({ ...SHIELD_PARAMS, encryptedMemo: new Uint8Array(104) })
    ).toThrow(/EncryptedMemo: invalid size.*expected 176 bytes, got 104/);
  });
});

// ─── buildPrivateTransferCalldata ─────────────────────────────────────────────

describe('ShieldedPoolPrecompile.buildPrivateTransferCalldata', () => {
  it('starts with PRIVATE_TRANSFER selector', () => {
    const precompile = new ShieldedPoolPrecompile(mockEvm());
    const calldata = precompile.buildPrivateTransferCalldata(TRANSFER_PARAMS);
    expect(calldata.startsWith(toHex(SP_SEL.PRIVATE_TRANSFER))).toBe(true);
  });

  it('is deterministic', () => {
    const precompile = new ShieldedPoolPrecompile(mockEvm());
    const a = precompile.buildPrivateTransferCalldata(TRANSFER_PARAMS);
    const b = precompile.buildPrivateTransferCalldata(TRANSFER_PARAMS);
    expect(a).toBe(b);
  });

  it('is longer with 2 inputs+outputs than with 1', () => {
    const precompile = new ShieldedPoolPrecompile(mockEvm());
    const one = precompile.buildPrivateTransferCalldata(TRANSFER_PARAMS);
    const two = precompile.buildPrivateTransferCalldata({
      ...TRANSFER_PARAMS,
      inputs:  [{ nullifier: NULLIFIER, commitment: COMMITMENT }, { nullifier: NULLIFIER, commitment: COMMITMENT }],
      outputs: [{ commitment: COMMITMENT, encryptedMemo: new Uint8Array(176) }, { commitment: COMMITMENT, encryptedMemo: new Uint8Array(176) }],
    });
    expect(two.length).toBeGreaterThan(one.length);
  });

  it('encodes default fee 0n when not specified', () => {
    const precompile = new ShieldedPoolPrecompile(mockEvm());
    const without = precompile.buildPrivateTransferCalldata(TRANSFER_PARAMS);
    const withZero = precompile.buildPrivateTransferCalldata({ ...TRANSFER_PARAMS, fee: 0n });
    expect(without).toBe(withZero);
  });

  it('produces different calldata for different fee values', () => {
    const precompile = new ShieldedPoolPrecompile(mockEvm());
    const noFee  = precompile.buildPrivateTransferCalldata(TRANSFER_PARAMS);
    const hasFee = precompile.buildPrivateTransferCalldata({ ...TRANSFER_PARAMS, fee: 1_000_000n });
    expect(noFee).not.toBe(hasFee);
  });

  it('produces different calldata for different assetId values', () => {
    const precompile = new ShieldedPoolPrecompile(mockEvm());
    const asset0 = precompile.buildPrivateTransferCalldata(TRANSFER_PARAMS);
    const asset1 = precompile.buildPrivateTransferCalldata({ ...TRANSFER_PARAMS, assetId: 1 });
    expect(asset0).not.toBe(asset1);
  });

  it('throws when an output encryptedMemo has wrong size', () => {
    const precompile = new ShieldedPoolPrecompile(mockEvm());
    const params = {
      ...TRANSFER_PARAMS,
      outputs: [{ commitment: COMMITMENT, encryptedMemo: new Uint8Array(10) }],
    };
    expect(() => precompile.buildPrivateTransferCalldata(params)).toThrow(
      /EncryptedMemo: invalid size.*expected 176 bytes, got 10/
    );
  });
});

// ─── buildUnshieldCalldata ────────────────────────────────────────────────────

describe('ShieldedPoolPrecompile.buildUnshieldCalldata', () => {
  it('starts with UNSHIELD selector', () => {
    const precompile = new ShieldedPoolPrecompile(mockEvm());
    const calldata = precompile.buildUnshieldCalldata(UNSHIELD_PARAMS);
    expect(calldata.startsWith(toHex(SP_SEL.UNSHIELD))).toBe(true);
  });

  it('is deterministic', () => {
    const precompile = new ShieldedPoolPrecompile(mockEvm());
    const a = precompile.buildUnshieldCalldata(UNSHIELD_PARAMS);
    const b = precompile.buildUnshieldCalldata(UNSHIELD_PARAMS);
    expect(a).toBe(b);
  });

  it('pads recipient to 64 hex chars when shorter', () => {
    const precompile = new ShieldedPoolPrecompile(mockEvm());
    // 20-byte EVM address (40 hex chars) — should be padded
    const evmRecipient = '0x' + 'ab'.repeat(20);
    const withEvmRecipient = precompile.buildUnshieldCalldata({
      ...UNSHIELD_PARAMS,
      recipientAddress: evmRecipient,
    });
    const withFullRecipient = precompile.buildUnshieldCalldata(UNSHIELD_PARAMS);
    // Both should be valid hex (same length calldata)
    expect(withEvmRecipient.length).toBe(withFullRecipient.length);
  });

  it('encodes default fee 0n when not specified', () => {
    const precompile = new ShieldedPoolPrecompile(mockEvm());
    const without = precompile.buildUnshieldCalldata(UNSHIELD_PARAMS);
    const withZero = precompile.buildUnshieldCalldata({ ...UNSHIELD_PARAMS, fee: 0n });
    expect(without).toBe(withZero);
  });

  it('produces different calldata for different fee values', () => {
    const precompile = new ShieldedPoolPrecompile(mockEvm());
    const noFee  = precompile.buildUnshieldCalldata(UNSHIELD_PARAMS);
    const hasFee = precompile.buildUnshieldCalldata({ ...UNSHIELD_PARAMS, fee: 1_000_000_000_000_000n });
    expect(noFee).not.toBe(hasFee);
  });
});

// ─── shield (signer call) ─────────────────────────────────────────────────────

describe('ShieldedPoolPrecompile.shield', () => {
  it('calls signer with SHIELDED_POOL address', async () => {
    const signer: EvmSigner = vi.fn().mockResolvedValue('0xtxhash');
    await new ShieldedPoolPrecompile(mockEvm()).shield(SHIELD_PARAMS, signer);
    expect(vi.mocked(signer).mock.calls[0]?.[0]?.to).toBe(PRECOMPILE_ADDR.SHIELDED_POOL);
  });

  it('calldata starts with SHIELD selector', async () => {
    const signer: EvmSigner = vi.fn().mockResolvedValue('0xtxhash');
    await new ShieldedPoolPrecompile(mockEvm()).shield(SHIELD_PARAMS, signer);
    const data = vi.mocked(signer).mock.calls[0]?.[0]?.data as string;
    expect(data.startsWith(toHex(SP_SEL.SHIELD))).toBe(true);
  });

  it('returns the tx hash from signer', async () => {
    const signer: EvmSigner = vi.fn().mockResolvedValue('0xdeadbeef');
    expect(await new ShieldedPoolPrecompile(mockEvm()).shield(SHIELD_PARAMS, signer)).toBe('0xdeadbeef');
  });
});

// ─── privateTransfer (signer call) ───────────────────────────────────────────

describe('ShieldedPoolPrecompile.privateTransfer', () => {
  it('calls signer with SHIELDED_POOL address', async () => {
    const signer: EvmSigner = vi.fn().mockResolvedValue('0xtx');
    await new ShieldedPoolPrecompile(mockEvm()).privateTransfer(TRANSFER_PARAMS, signer);
    expect(vi.mocked(signer).mock.calls[0]?.[0]?.to).toBe(PRECOMPILE_ADDR.SHIELDED_POOL);
  });

  it('calldata starts with PRIVATE_TRANSFER selector', async () => {
    const signer: EvmSigner = vi.fn().mockResolvedValue('0xtx');
    await new ShieldedPoolPrecompile(mockEvm()).privateTransfer(TRANSFER_PARAMS, signer);
    const data = vi.mocked(signer).mock.calls[0]?.[0]?.data as string;
    expect(data.startsWith(toHex(SP_SEL.PRIVATE_TRANSFER))).toBe(true);
  });
});

// ─── unshield (signer call) ───────────────────────────────────────────────────

describe('ShieldedPoolPrecompile.unshield', () => {
  it('calls signer with SHIELDED_POOL address', async () => {
    const signer: EvmSigner = vi.fn().mockResolvedValue('0xtx');
    await new ShieldedPoolPrecompile(mockEvm()).unshield(UNSHIELD_PARAMS, signer);
    expect(vi.mocked(signer).mock.calls[0]?.[0]?.to).toBe(PRECOMPILE_ADDR.SHIELDED_POOL);
  });

  it('calldata starts with UNSHIELD selector', async () => {
    const signer: EvmSigner = vi.fn().mockResolvedValue('0xtx');
    await new ShieldedPoolPrecompile(mockEvm()).unshield(UNSHIELD_PARAMS, signer);
    const data = vi.mocked(signer).mock.calls[0]?.[0]?.data as string;
    expect(data.startsWith(toHex(SP_SEL.UNSHIELD))).toBe(true);
  });
});

// ─── Gas estimation ───────────────────────────────────────────────────────────

describe('ShieldedPoolPrecompile.estimateShieldGas', () => {
  it('calls evm.estimateGas and returns bigint', async () => {
    const evm = mockEvm();
    const result = await new ShieldedPoolPrecompile(evm).estimateShieldGas(SHIELD_PARAMS, '0xfrom');
    expect(typeof result).toBe('bigint');
    expect(vi.mocked(evm.estimateGas)).toHaveBeenCalledOnce();
  });

  it('passes from and to=SHIELDED_POOL to estimateGas', async () => {
    const evm = mockEvm();
    await new ShieldedPoolPrecompile(evm).estimateShieldGas(SHIELD_PARAMS, '0xfrom');
    const args = vi.mocked(evm.estimateGas).mock.calls[0]?.[0];
    expect(args?.from).toBe('0xfrom');
    expect(args?.to).toBe(PRECOMPILE_ADDR.SHIELDED_POOL);
  });
});

describe('ShieldedPoolPrecompile.estimatePrivateTransferGas', () => {
  it('calls evm.estimateGas with SHIELDED_POOL address', async () => {
    const evm = mockEvm();
    await new ShieldedPoolPrecompile(evm).estimatePrivateTransferGas(TRANSFER_PARAMS, '0xfrom');
    const args = vi.mocked(evm.estimateGas).mock.calls[0]?.[0];
    expect(args?.to).toBe(PRECOMPILE_ADDR.SHIELDED_POOL);
  });
});

describe('ShieldedPoolPrecompile.estimateUnshieldGas', () => {
  it('calls evm.estimateGas with SHIELDED_POOL address', async () => {
    const evm = mockEvm();
    await new ShieldedPoolPrecompile(evm).estimateUnshieldGas(UNSHIELD_PARAMS, '0xfrom');
    const args = vi.mocked(evm.estimateGas).mock.calls[0]?.[0];
    expect(args?.to).toBe(PRECOMPILE_ADDR.SHIELDED_POOL);
  });
});

// ─── claimShieldedFees fixtures ───────────────────────────────────────────────

/** Builds a valid 76-byte public_signals buffer for the given (commitment, amount, assetId). */
function makePublicSignals(commitment: string, amount: bigint, assetId: number): Uint8Array {
  const ps = new Uint8Array(76);
  const commitmentBytes = fromHex(commitment);
  ps.set(commitmentBytes, 0); // [0..32] commitment
  // [32..40] amount as u64 LE
  const view = new DataView(ps.buffer);
  view.setBigUint64(32, BigInt.asUintN(64, amount), true /* little-endian */);
  // [40..44] assetId as u32 LE
  view.setUint32(40, assetId, true /* little-endian */);
  // [44..76] owner_hash — leave as zeros
  return ps;
}

const CSF_COMMITMENT   = '0x' + '11'.repeat(32);
const CSF_AMOUNT       = 500_000n;
const CSF_ASSET_ID     = 0;
const CSF_PROOF        = new Uint8Array(128).fill(0x01); // 128-byte Groth16 proof
const CSF_MEMO         = new Uint8Array(176);
const CSF_SIGNALS      = makePublicSignals(CSF_COMMITMENT, CSF_AMOUNT, CSF_ASSET_ID);

const CLAIM_PARAMS: ClaimShieldedFeesParams = {
  commitment:    CSF_COMMITMENT,
  amount:        CSF_AMOUNT,
  assetId:       CSF_ASSET_ID,
  proof:         CSF_PROOF,
  publicSignals: CSF_SIGNALS,
  encryptedMemo: CSF_MEMO,
};

// ─── buildClaimShieldedFeesCalldata ───────────────────────────────────────────

describe('ShieldedPoolPrecompile.buildClaimShieldedFeesCalldata', () => {
  it('starts with CLAIM_SHIELDED_FEES selector', () => {
    const precompile = new ShieldedPoolPrecompile(mockEvm());
    const calldata = precompile.buildClaimShieldedFeesCalldata(CLAIM_PARAMS);
    expect(calldata.startsWith(toHex(SP_SEL.CLAIM_SHIELDED_FEES))).toBe(true);
  });

  it('selector bytes are 0x42e1e74c', () => {
    const precompile = new ShieldedPoolPrecompile(mockEvm());
    const calldata = precompile.buildClaimShieldedFeesCalldata(CLAIM_PARAMS);
    expect(calldata.slice(0, 10)).toBe('0x42e1e74c');
  });

  it('returns a 0x-prefixed hex string', () => {
    const precompile = new ShieldedPoolPrecompile(mockEvm());
    expect(precompile.buildClaimShieldedFeesCalldata(CLAIM_PARAMS).startsWith('0x')).toBe(true);
  });

  it('is deterministic — same params produce same calldata', () => {
    const precompile = new ShieldedPoolPrecompile(mockEvm());
    expect(precompile.buildClaimShieldedFeesCalldata(CLAIM_PARAMS))
      .toBe(precompile.buildClaimShieldedFeesCalldata(CLAIM_PARAMS));
  });

  it('encodes commitment as the first 32-byte slot after the selector', () => {
    const precompile = new ShieldedPoolPrecompile(mockEvm());
    const calldata = precompile.buildClaimShieldedFeesCalldata(CLAIM_PARAMS);
    // bytes [4..36] = commitment (32 bytes → 64 hex chars after the 4-byte selector)
    const commitmentInCalldata = '0x' + calldata.slice(10, 74);
    expect(commitmentInCalldata).toBe(CSF_COMMITMENT);
  });

  it('encodes different commitments into different calldata', () => {
    const precompile = new ShieldedPoolPrecompile(mockEvm());
    const other = '0x' + '22'.repeat(32);
    const a = precompile.buildClaimShieldedFeesCalldata(CLAIM_PARAMS);
    const b = precompile.buildClaimShieldedFeesCalldata({
      ...CLAIM_PARAMS,
      commitment: other,
      publicSignals: makePublicSignals(other, CSF_AMOUNT, CSF_ASSET_ID),
    });
    expect(a).not.toBe(b);
  });

  it('encodes different amounts into different calldata', () => {
    const precompile = new ShieldedPoolPrecompile(mockEvm());
    const a = precompile.buildClaimShieldedFeesCalldata(CLAIM_PARAMS);
    const b = precompile.buildClaimShieldedFeesCalldata({
      ...CLAIM_PARAMS,
      amount: CSF_AMOUNT + 1n,
      publicSignals: makePublicSignals(CSF_COMMITMENT, CSF_AMOUNT + 1n, CSF_ASSET_ID),
    });
    expect(a).not.toBe(b);
  });

  it('encodes different assetIds into different calldata', () => {
    const precompile = new ShieldedPoolPrecompile(mockEvm());
    const a = precompile.buildClaimShieldedFeesCalldata(CLAIM_PARAMS);
    const b = precompile.buildClaimShieldedFeesCalldata({
      ...CLAIM_PARAMS,
      assetId: 1,
      publicSignals: makePublicSignals(CSF_COMMITMENT, CSF_AMOUNT, 1),
    });
    expect(a).not.toBe(b);
  });

  it('contains the publicSignals bytes verbatim inside the calldata', () => {
    const precompile = new ShieldedPoolPrecompile(mockEvm());
    const calldata = precompile.buildClaimShieldedFeesCalldata(CLAIM_PARAMS);
    // publicSignals (76 bytes) must appear somewhere in the raw calldata bytes
    const calldataBytes = fromHex(calldata);
    const psHex = toHex(CSF_SIGNALS).slice(2); // without 0x
    expect(calldata.includes(psHex)).toBe(true);
    void calldataBytes; // suppress unused warning
  });

  it('minimum calldata length: selector(4) + head(6×32) + 3 dynamic tails', () => {
    const precompile = new ShieldedPoolPrecompile(mockEvm());
    const calldata = precompile.buildClaimShieldedFeesCalldata(CLAIM_PARAMS);
    // 4 + 192 (head) + ≥3×32 (length word per tail) = at least 4 + 192 + 96 = 292 bytes = 584 hex chars + '0x'
    expect(calldata.length).toBeGreaterThanOrEqual(2 + (4 + 192 + 96) * 2);
  });

  it('throws when proof is empty', () => {
    const precompile = new ShieldedPoolPrecompile(mockEvm());
    expect(() =>
      precompile.buildClaimShieldedFeesCalldata({ ...CLAIM_PARAMS, proof: new Uint8Array(0) })
    ).toThrow(/proof must not be empty/);
  });

  it('throws when publicSignals is not 76 bytes (too short)', () => {
    const precompile = new ShieldedPoolPrecompile(mockEvm());
    expect(() =>
      precompile.buildClaimShieldedFeesCalldata({
        ...CLAIM_PARAMS,
        publicSignals: new Uint8Array(75),
      })
    ).toThrow(/publicSignals must be 76 bytes/);
  });

  it('throws when publicSignals is not 76 bytes (too long)', () => {
    const precompile = new ShieldedPoolPrecompile(mockEvm());
    expect(() =>
      precompile.buildClaimShieldedFeesCalldata({
        ...CLAIM_PARAMS,
        publicSignals: new Uint8Array(77),
      })
    ).toThrow(/publicSignals must be 76 bytes/);
  });

  it('throws when encryptedMemo has wrong size', () => {
    const precompile = new ShieldedPoolPrecompile(mockEvm());
    expect(() =>
      precompile.buildClaimShieldedFeesCalldata({
        ...CLAIM_PARAMS,
        encryptedMemo: new Uint8Array(100),
      })
    ).toThrow(/EncryptedMemo: invalid size.*expected 176 bytes, got 100/);
  });
});

// ─── claimShieldedFees (signer call) ─────────────────────────────────────────

describe('ShieldedPoolPrecompile.claimShieldedFees', () => {
  it('calls signer with SHIELDED_POOL address', async () => {
    const signer: EvmSigner = vi.fn().mockResolvedValue('0xtxhash');
    await new ShieldedPoolPrecompile(mockEvm()).claimShieldedFees(CLAIM_PARAMS, signer);
    expect(vi.mocked(signer).mock.calls[0]?.[0]?.to).toBe(PRECOMPILE_ADDR.SHIELDED_POOL);
  });

  it('calldata starts with CLAIM_SHIELDED_FEES selector', async () => {
    const signer: EvmSigner = vi.fn().mockResolvedValue('0xtxhash');
    await new ShieldedPoolPrecompile(mockEvm()).claimShieldedFees(CLAIM_PARAMS, signer);
    const data = vi.mocked(signer).mock.calls[0]?.[0]?.data as string;
    expect(data.startsWith(toHex(SP_SEL.CLAIM_SHIELDED_FEES))).toBe(true);
  });

  it('does not pass a value field (not payable)', async () => {
    const signer: EvmSigner = vi.fn().mockResolvedValue('0xtxhash');
    await new ShieldedPoolPrecompile(mockEvm()).claimShieldedFees(CLAIM_PARAMS, signer);
    const tx = vi.mocked(signer).mock.calls[0]?.[0];
    expect(tx?.value).toBeUndefined();
  });

  it('returns the tx hash from signer', async () => {
    const signer: EvmSigner = vi.fn().mockResolvedValue('0xdeadbeef');
    const result = await new ShieldedPoolPrecompile(mockEvm()).claimShieldedFees(
      CLAIM_PARAMS,
      signer
    );
    expect(result).toBe('0xdeadbeef');
  });

  it('calldata is identical to buildClaimShieldedFeesCalldata output', async () => {
    const precompile = new ShieldedPoolPrecompile(mockEvm());
    const signer: EvmSigner = vi.fn().mockResolvedValue('0xtx');
    await precompile.claimShieldedFees(CLAIM_PARAMS, signer);
    const sentData = vi.mocked(signer).mock.calls[0]?.[0]?.data as string;
    expect(sentData).toBe(precompile.buildClaimShieldedFeesCalldata(CLAIM_PARAMS));
  });
});

// ─── estimateClaimShieldedFeesGas ─────────────────────────────────────────────

describe('ShieldedPoolPrecompile.estimateClaimShieldedFeesGas', () => {
  it('calls evm.estimateGas and returns bigint', async () => {
    const evm = mockEvm();
    const result = await new ShieldedPoolPrecompile(evm).estimateClaimShieldedFeesGas(
      CLAIM_PARAMS,
      '0xfrom'
    );
    expect(typeof result).toBe('bigint');
    expect(vi.mocked(evm.estimateGas)).toHaveBeenCalledOnce();
  });

  it('passes from and to=SHIELDED_POOL to estimateGas', async () => {
    const evm = mockEvm();
    await new ShieldedPoolPrecompile(evm).estimateClaimShieldedFeesGas(CLAIM_PARAMS, '0xfrom');
    const args = vi.mocked(evm.estimateGas).mock.calls[0]?.[0];
    expect(args?.from).toBe('0xfrom');
    expect(args?.to).toBe(PRECOMPILE_ADDR.SHIELDED_POOL);
  });

  it('passes calldata matching buildClaimShieldedFeesCalldata to estimateGas', async () => {
    const evm = mockEvm();
    const precompile = new ShieldedPoolPrecompile(evm);
    await precompile.estimateClaimShieldedFeesGas(CLAIM_PARAMS, '0xfrom');
    const args = vi.mocked(evm.estimateGas).mock.calls[0]?.[0];
    expect(args?.data).toBe(precompile.buildClaimShieldedFeesCalldata(CLAIM_PARAMS));
  });
});
