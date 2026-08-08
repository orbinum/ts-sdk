/**
 * The circuit version a freshly built note should carry.
 *
 * A new note has no proof, so its version only matters when it is later SPENT.
 * The dominant spend path is unshield, and a verifying-key rotation moves every
 * circuit to the same active version together — so the unshield circuit's active
 * version governs a new note of any kind.
 *
 * Fail-closed on purpose: stamping a guessed version produces a note the chain
 * refuses to spend after a rotation, and the failure surfaces much later, when
 * the user tries to move funds.
 */
import { CircuitId } from '../../../chain/pallet/zk-verifier/index';
import type { ZkVerifierModule } from '../../../chain/pallet/zk-verifier/ZkVerifierModule';

export async function chainActiveCircuitVersion(
    zkVerifier: Pick<ZkVerifierModule, 'getCircuitVersionInfo'>
): Promise<number> {
    const info = await zkVerifier.getCircuitVersionInfo(CircuitId.Unshield);
    if (!info || typeof info.activeVersion !== 'number') {
        throw new Error(
            'Cannot determine chain active circuit version — refusing to build a note.'
        );
    }
    return info.activeVersion;
}
