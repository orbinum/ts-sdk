import { describe, it, expect, vi } from 'vitest';
import { EvmExplorer } from '../../src/evm-explorer/EvmExplorer';
import type { EvmClient } from '../../src/evm/EvmClient';

// Minimal raw block the parser accepts. Only fields read by parseBlock matter.
function rawBlock(n: number) {
  return {
    hash: `0x${n.toString(16).padStart(2, '0')}`,
    parentHash: '0x00',
    number: `0x${n.toString(16)}`,
    timestamp: '0x0',
    miner: '0x0000000000000000000000000000000000000000',
    transactions: [],
    gasUsed: '0x0',
    gasLimit: '0x0',
  };
}

// Builds an EvmExplorer over a fake EvmClient that records how it was called.
function makeExplorer(latest: number) {
  const request = vi.fn(async (method: string, params: unknown[] = []) => {
    if (method === 'eth_blockNumber') return `0x${latest.toString(16)}`;
    if (method === 'eth_getBlockByNumber') {
      const n = parseInt(params[0] as string, 16);
      return rawBlock(n);
    }
    return null;
  });
  const batchRequest = vi.fn(async (calls: Array<{ method: string; params?: unknown[] }>) =>
    calls.map((c) =>
      c.method === 'eth_getBlockByNumber'
        ? rawBlock(parseInt((c.params?.[0] as string) ?? '0x0', 16))
        : null,
    ),
  );
  const getBlockNumber = vi.fn(async () => latest);
  const evm = { request, batchRequest, getBlockNumber } as unknown as EvmClient;
  return { explorer: new EvmExplorer(evm), request, batchRequest };
}

describe('EvmExplorer.getLatestBlocks — batches block fetches', () => {
  it('uses ONE batch request, not one request per block', async () => {
    const { explorer, request, batchRequest } = makeExplorer(100);

    const blocks = await explorer.getLatestBlocks(10);

    expect(blocks).toHaveLength(10);
    expect(batchRequest).toHaveBeenCalledTimes(1);
    expect(batchRequest.mock.calls[0]![0]).toHaveLength(10);
    const perBlockSingles = request.mock.calls.filter((c) => c[0] === 'eth_getBlockByNumber');
    expect(perBlockSingles).toHaveLength(0);
  });

  it('returns latest-first', async () => {
    const { explorer } = makeExplorer(100);
    const blocks = await explorer.getLatestBlocks(3);
    expect(blocks.map((b) => b.number)).toEqual([100, 99, 98]);
  });
});

describe('EvmExplorer.getTransactionsByAddress — chunks block fetches', () => {
  it('batches blocks in chunks of 50 instead of one request per block', async () => {
    const { explorer, request, batchRequest } = makeExplorer(120);

    await explorer.getTransactionsByAddress('0xabc', 120);

    // 120 blocks / 50 per chunk = 3 batch calls (50 + 50 + 20).
    const blockBatches = batchRequest.mock.calls.filter((c) =>
      (c[0] as Array<{ method: string }>).some((x) => x.method === 'eth_getBlockByNumber'),
    );
    expect(blockBatches).toHaveLength(3);
    const perBlockSingles = request.mock.calls.filter((c) => c[0] === 'eth_getBlockByNumber');
    expect(perBlockSingles).toHaveLength(0);
  });
});
