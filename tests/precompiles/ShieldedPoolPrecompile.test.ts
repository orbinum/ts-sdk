import { describe, it, expect, vi } from 'vitest';
import { ShieldedPoolPrecompile } from '../../src/precompiles/ShieldedPoolPrecompile';
import { SP_SEL, PRECOMPILE_ADDR } from '../../src/precompiles/addresses';
import { toHex } from '../../src/utils/hex';
import type { EvmClient } from '../../src/evm/EvmClient';
import type { EvmSigner } from '../../src/precompiles/types';
import type {
  ShieldParams,
  UnshieldParams,
  PrivateTransferParams,
} from '../../src/shielded-pool/types';

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
  outputs: [{ commitment: COMMITMENT }],
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

  it('handles encryptedMemo when provided', () => {
    const precompile = new ShieldedPoolPrecompile(mockEvm());
    const memo = new Uint8Array(104).fill(0xff);
    const withMemo = precompile.buildShieldCalldata({ ...SHIELD_PARAMS, encryptedMemo: memo });
    const withoutMemo = precompile.buildShieldCalldata(SHIELD_PARAMS);
    // Different memos → different calldatas
    expect(withMemo).not.toBe(withoutMemo);
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
      outputs: [{ commitment: COMMITMENT }, { commitment: COMMITMENT }],
    });
    expect(two.length).toBeGreaterThan(one.length);
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
