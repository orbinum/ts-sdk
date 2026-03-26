import { describe, it, expect, vi } from 'vitest';
import { MerkleModule } from '../../src/shielded-pool/MerkleModule';
import type { SubstrateClient } from '../../src/substrate/SubstrateClient';

// ─── Mock factory ─────────────────────────────────────────────────────────────

function makeSubstrate(responses: Record<string, unknown>): SubstrateClient {
  return {
    request: vi.fn(async (method: string, _params: unknown[]) => {
      if (method in responses) return responses[method];
      throw new Error(`Unexpected RPC method: ${method}`);
    }),
  } as unknown as SubstrateClient;
}

// ─── MerkleModule.getTreeInfo ─────────────────────────────────────────────────

describe('MerkleModule.getTreeInfo', () => {
  it('maps raw snake_case response to camelCase MerkleTreeInfo', async () => {
    const substrate = makeSubstrate({
      shieldedPool_getMerkleTreeInfo: { root: '0xabc123', tree_size: 10, depth: 4 },
    });
    const info = await new MerkleModule(substrate).getTreeInfo();
    expect(info.root).toBe('0xabc123');
    expect(info.treeSize).toBe(10);
    expect(info.depth).toBe(4);
  });

  it('calls the correct RPC method', async () => {
    const substrate = makeSubstrate({
      shieldedPool_getMerkleTreeInfo: { root: '0x0', tree_size: 0, depth: 0 },
    });
    await new MerkleModule(substrate).getTreeInfo();
    expect(substrate.request).toHaveBeenCalledWith('shieldedPool_getMerkleTreeInfo', []);
  });
});

// ─── MerkleModule.getProof ────────────────────────────────────────────────────

describe('MerkleModule.getProof', () => {
  const rawProof = {
    root: '0xroot',
    leaf_index: 3,
    siblings: ['0xsibling0', '0xsibling1', '0xsibling2'],
  };

  it('maps raw response to MerkleProof', async () => {
    const substrate = makeSubstrate({ shieldedPool_getMerkleProof: rawProof });
    const proof = await new MerkleModule(substrate).getProof(3);
    expect(proof.root).toBe('0xroot');
    expect(proof.leafIndex).toBe(3);
    expect(proof.siblings).toEqual(['0xsibling0', '0xsibling1', '0xsibling2']);
  });

  it('passes the leaf index to the RPC call', async () => {
    const substrate = makeSubstrate({ shieldedPool_getMerkleProof: rawProof });
    await new MerkleModule(substrate).getProof(7);
    expect(substrate.request).toHaveBeenCalledWith('shieldedPool_getMerkleProof', [7]);
  });
});

// ─── MerkleModule.getProofByCommitment ───────────────────────────────────────

describe('MerkleModule.getProofByCommitment', () => {
  const rawProof = { root: '0xroot', leaf_index: 1, siblings: ['0xa', '0xb'] };

  it('passes the commitment hex to the RPC call', async () => {
    const substrate = makeSubstrate({ shieldedPool_getMerkleProof: rawProof });
    const commitmentHex = '0xdeadbeef';
    await new MerkleModule(substrate).getProofByCommitment(commitmentHex);
    expect(substrate.request).toHaveBeenCalledWith('shieldedPool_getMerkleProof', [commitmentHex]);
  });

  it('maps response correctly', async () => {
    const substrate = makeSubstrate({ shieldedPool_getMerkleProof: rawProof });
    const proof = await new MerkleModule(substrate).getProofByCommitment('0x01');
    expect(proof.leafIndex).toBe(1);
    expect(proof.siblings).toEqual(['0xa', '0xb']);
  });
});

// ─── MerkleModule.getRoot ─────────────────────────────────────────────────────

describe('MerkleModule.getRoot', () => {
  it('returns the root from tree info', async () => {
    const substrate = makeSubstrate({
      shieldedPool_getMerkleTreeInfo: { root: '0xdeadbeef', tree_size: 5, depth: 3 },
    });
    const root = await new MerkleModule(substrate).getRoot();
    expect(root).toBe('0xdeadbeef');
  });
});

// ─── MerkleModule.getLeaves ───────────────────────────────────────────────────

describe('MerkleModule.getLeaves', () => {
  it('returns the array of leaves from RPC', async () => {
    const substrate = makeSubstrate({
      shieldedPool_getMerkleLeaves: ['0xleaf0', '0xleaf1', '0xleaf2'],
    });
    const leaves = await new MerkleModule(substrate).getLeaves();
    expect(leaves).toEqual(['0xleaf0', '0xleaf1', '0xleaf2']);
  });

  it('passes from/to parameters', async () => {
    const substrate = makeSubstrate({ shieldedPool_getMerkleLeaves: [] });
    await new MerkleModule(substrate).getLeaves(2, 5);
    expect(substrate.request).toHaveBeenCalledWith('shieldedPool_getMerkleLeaves', [2, 5]);
  });

  it('passes null for to when omitted', async () => {
    const substrate = makeSubstrate({ shieldedPool_getMerkleLeaves: [] });
    await new MerkleModule(substrate).getLeaves(0);
    expect(substrate.request).toHaveBeenCalledWith('shieldedPool_getMerkleLeaves', [0, null]);
  });
});
