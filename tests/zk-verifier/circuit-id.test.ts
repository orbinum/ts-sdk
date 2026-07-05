import { describe, it, expect } from 'vitest';
import { CircuitId } from '../../src/zk-verifier/types/pallet-extrinsics';

/**
 * Anti-drift guard: the SDK's CircuitId constants MUST match the node's
 * `CircuitId` (node/frame/zk-verifier/src/types.rs): TRANSFER=1, UNSHIELD=2,
 * PRIVATE_LINK=5, VALUE_PROOF=6. A prior version had ValueProof=4, which would
 * make getCircuitVersionInfo(4) query a non-existent circuit. This locks it.
 */
describe('CircuitId (SDK ↔ node)', () => {
  it('matches the node circuit ids exactly', () => {
    expect(CircuitId.Transfer).toBe(1);
    expect(CircuitId.Unshield).toBe(2);
    expect(CircuitId.PrivateLink).toBe(5);
    expect(CircuitId.ValueProof).toBe(6);
  });
});
