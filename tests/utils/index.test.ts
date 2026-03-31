import { describe, it, expect } from 'vitest';
import * as publicUtils from '../../src/utils';

describe('utils/index barrel', () => {
  it('re-exports formatting helpers', () => {
    expect(typeof publicUtils.formatBalance).toBe('function');
    expect(typeof publicUtils.formatORB).toBe('function');
  });

  it('re-exports tx helpers', () => {
    expect(typeof publicUtils.toTxResult).toBe('function');
  });

  it('re-exports extended byte helpers', () => {
    expect(typeof publicUtils.bigintTo32LeArr).toBe('function');
    expect(typeof publicUtils.computePathIndices).toBe('function');
    expect(typeof publicUtils.leHexToBigint).toBe('function');
  });

  it('re-exports extended address helpers', () => {
    expect(typeof publicUtils.evmToImplicitSubstrate).toBe('function');
    expect(typeof publicUtils.isImplicitEvmAccount).toBe('function');
    expect(typeof publicUtils.implicitSubstrateToEvm).toBe('function');
    expect(typeof publicUtils.isSubstrateAddress).toBe('function');
    expect(typeof publicUtils.isUnifiedAddress).toBe('function');
    expect(typeof publicUtils.substrateToEvm).toBe('function');
    expect(typeof publicUtils.evmToSubstrate).toBe('function');
    expect(typeof publicUtils.accountIdHexToSs58).toBe('function');
    expect(typeof publicUtils.substrateSs58ToAccountIdHex).toBe('function');
    expect(typeof publicUtils.addressToAccountIdHex).toBe('function');
  });
});