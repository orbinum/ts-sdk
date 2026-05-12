import { describe, it, expect } from 'vitest';
import { merkleProofToCircuit } from '../../src/proof-generator/merkle';

// A 32-byte LE hex value where byte[0]=0x01, rest=0x00
// leHexToBigint('0x' + '01' + '00'.repeat(31)) === 1n
const HEX_ONE = '0x' + '01' + '00'.repeat(31);
// byte[0]=0x02
const HEX_TWO = '0x' + '02' + '00'.repeat(31);

describe('merkleProofToCircuit', () => {
    it('returns arrays of the same length as siblings', () => {
        const siblings = [HEX_ONE, HEX_TWO];
        const { elements, indices } = merkleProofToCircuit(siblings, 0);
        expect(elements).toHaveLength(2);
        expect(indices).toHaveLength(2);
    });

    it('converts LE hex siblings to decimal strings', () => {
        const { elements } = merkleProofToCircuit([HEX_ONE, HEX_TWO], 0);
        expect(elements[0]).toBe('1');
        expect(elements[1]).toBe('2');
    });

    it('computes correct path indices for leaf 0 (depth 3)', () => {
        // leaf 0 → binary 000 → indices [0, 0, 0]
        const siblings = [HEX_ONE, HEX_ONE, HEX_ONE];
        const { indices } = merkleProofToCircuit(siblings, 0);
        expect(indices).toEqual(['0', '0', '0']);
    });

    it('computes correct path indices for leaf 5 (depth 4)', () => {
        // leaf 5 → binary 0101 → indices [1, 0, 1, 0]
        const siblings = [HEX_ONE, HEX_ONE, HEX_ONE, HEX_ONE];
        const { indices } = merkleProofToCircuit(siblings, 5);
        expect(indices).toEqual(['1', '0', '1', '0']);
    });

    it('handles a single-level tree', () => {
        const { elements, indices } = merkleProofToCircuit([HEX_TWO], 1);
        expect(elements).toEqual(['2']);
        expect(indices).toEqual(['1']);
    });

    it('returns empty arrays for empty siblings', () => {
        const { elements, indices } = merkleProofToCircuit([], 0);
        expect(elements).toEqual([]);
        expect(indices).toEqual([]);
    });

    it('all elements are decimal strings (no 0x prefix)', () => {
        const siblings = [HEX_ONE, HEX_TWO];
        const { elements } = merkleProofToCircuit(siblings, 0);
        for (const el of elements) {
            expect(el).toMatch(/^\d+$/);
        }
    });

    it('all indices are "0" or "1" strings', () => {
        const siblings = new Array(20).fill(HEX_ONE);
        const { indices } = merkleProofToCircuit(siblings, 12345);
        for (const idx of indices) {
            expect(['0', '1']).toContain(idx);
        }
    });
});
