/**
 * Reading the circuit version the chain will accept.
 *
 * Everything here is about failing CLOSED. A new note carries no proof, so a
 * wrong version stamped on it costs nothing today and surfaces much later — as
 * a spend the chain refuses after a VK rotation, when the user is trying to
 * move funds. Guessing a default would convert an obvious startup failure into
 * an unspendable note, so every unreadable answer throws instead.
 */
import { describe, it, expect, vi } from 'vitest';
import { chainActiveCircuitVersion } from '../../../../src/wallet/ops/transport/circuitVersion';
import { CircuitId } from '../../../../src/index';

const verifier = (info: unknown) => ({
    getCircuitVersionInfo: vi.fn().mockResolvedValue(info),
});

describe('chainActiveCircuitVersion', () => {
    it('returns the version the chain reports active', async () => {
        expect(await chainActiveCircuitVersion(verifier({ activeVersion: 3 }))).toBe(3);
    });

    it('accepts version 0, which is a real version and not "absent"', async () => {
        // A `!info.activeVersion` check would reject this and fail a chain whose
        // versions start at zero.
        expect(await chainActiveCircuitVersion(verifier({ activeVersion: 0 }))).toBe(0);
    });

    it('asks about the UNSHIELD circuit', async () => {
        // A rotation moves every circuit to the same active version together, so
        // one circuit answers for all — and unshield is the dominant spend path.
        const zkVerifier = verifier({ activeVersion: 1 });

        await chainActiveCircuitVersion(zkVerifier);

        expect(zkVerifier.getCircuitVersionInfo).toHaveBeenCalledWith(CircuitId.Unshield);
    });

    it('fails closed when the chain reports nothing', async () => {
        await expect(chainActiveCircuitVersion(verifier(null))).rejects.toThrow(
            /Cannot determine chain active circuit version/
        );
    });

    it('fails closed on a malformed version', async () => {
        await expect(chainActiveCircuitVersion(verifier({ activeVersion: 'v2' }))).rejects.toThrow(
            /Cannot determine/
        );
    });

    it('fails closed when the field is missing entirely', async () => {
        await expect(chainActiveCircuitVersion(verifier({}))).rejects.toThrow(/Cannot determine/);
    });

    it('propagates an RPC failure rather than substituting a default', async () => {
        // An unreachable node is not evidence about the version. Swallowing this
        // is how a guessed version reaches a note.
        const zkVerifier = {
            getCircuitVersionInfo: vi.fn().mockRejectedValue(new Error('rpc down')),
        };

        await expect(chainActiveCircuitVersion(zkVerifier)).rejects.toThrow('rpc down');
    });
});
