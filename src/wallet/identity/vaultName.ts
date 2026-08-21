/**
 * Naming a vault: one per (version, chain, account). Each part earns its place
 * by a failure that is silent without it.
 *
 *   - **chain** — a commitment only exists on the chain that minted it. Carried
 *     across networks, the scan reads every absent commitment as "spent".
 *   - **account** — canonicalised exactly as the key derivation canonicalises
 *     it. Keyed by the raw address, an account re-listed under a different SS58
 *     prefix derives the SAME key but opens a DIFFERENT vault: an empty balance
 *     with nothing to explain it, and the real notes orphaned under the old name.
 *   - **version** — two schemes over one account produce different keys, and
 *     `VaultStore.unlock` cannot tell a foreign vault from a corrupt one. It
 *     resets, taking the other version's notes with it.
 *
 * The naming lives here, not in a comment, because a host that spells its own
 * will eventually get one of the three wrong.
 */
import { canonicalAccountId } from '../../protocol/keys/accountIdentity';
import type { IdentityVersion } from '../../protocol/keys/PrivacyKeys';

const PREFIX = 'orbinum-vault';

/** Re-exported so callers of the vault naming keep one import. */
export type { IdentityVersion } from '../../protocol/keys/PrivacyKeys';

/**
 * The version marker, placed BEFORE the account rather than after.
 *
 * A suffix is forgeable: `canonicalAccountId` lets a non-SS58 address through
 * lowercased, so an account named `0xabc-v3` puts its own `-v3` exactly where a
 * suffix marker would sit. Moving it to the front narrows that without closing
 * it — whatever lands in the marker's place is read as the version, so `v3-0xabc`
 * reproduces the collision from the other side. `assertNoVersionMarker` closes it.
 */
const versionMarker = (version: IdentityVersion): string => `${version}-`;

/** Every marker a name could be misread as carrying. */
const VERSION_MARKERS: readonly string[] = ['v3-'];

/**
 * Refuses a component that could occupy the version position.
 *
 * Worth failing loudly over — a shared name costs the other version's notes —
 * and costs nothing: the inputs are an address and a genesis hash, neither of
 * which has any legitimate reason to begin with a version token.
 */
function assertNoVersionMarker(component: string, label: string): void {
    for (const marker of VERSION_MARKERS) {
        if (component.startsWith(marker)) {
            throw new Error(
                `vaultStorageName: ${label} must not start with "${marker}" — ` +
                    'it would collide with another identity version'
            );
        }
    }
}

/**
 * Storage name for one account's vault on one chain.
 *
 * `chainFingerprint` is the genesis hash, optional because a host may not know
 * it during connect: the name then scopes by account alone and is promoted once
 * it arrives. Opening under the short name and later the long one is safe —
 * `unlock` detects the change and resets rather than mixing two chains' notes.
 */
export function vaultStorageName(
    address: string,
    chainFingerprint?: string,
    version: IdentityVersion = 'v3'
): string {
    const account = canonicalAccountId(address);
    assertNoVersionMarker(account, 'account');
    const marker = versionMarker(version);
    // Checked lowercased, since that is the form that reaches the name.
    if (chainFingerprint) assertNoVersionMarker(chainFingerprint.toLowerCase(), 'chainFingerprint');
    return chainFingerprint
        ? `${PREFIX}-${marker}${chainFingerprint.toLowerCase()}-${account}`
        : `${PREFIX}-${marker}${account}`;
}
