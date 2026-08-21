/**
 * A node's merkle proof, in the form the witness calculator takes.
 *
 * Two conversions, both easy to get wrong silently: the siblings arrive as
 * LITTLE-endian hex and the prover wants decimal strings, and the path indices
 * are derived from the leaf position rather than sent by the node.
 *
 * Neither is validated here — a wrong-endian sibling or a mismatched index
 * produces a witness that fails the merkle constraint seconds into proving,
 * which is the circuit doing the checking.
 */
import { leHexToBigint, computePathIndices } from '../../foundation/encoding/bytes';

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
