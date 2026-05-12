import { leHexToBigint, computePathIndices } from '../utils/bytes';

/**
 * Converts a merkle proof (returned by the node RPC) to the decimal strings
 * expected by the snarkjs witness calculator.
 *
 * @param siblings - Array of 0x-prefixed 32-byte LE hex sibling hashes.
 * @param leafIndex - Index of the leaf in the tree.
 */
export function merkleProofToCircuit(
    siblings: string[],
    leafIndex: number
): { elements: string[]; indices: string[] } {
    const elements = siblings.map((h) => leHexToBigint(h).toString());
    const depth = siblings.length;
    const indices = computePathIndices(leafIndex, depth).map(String);
    return { elements, indices };
}
