/**
 * Naming a vault.
 *
 * One vault per (chain, account), and both halves matter:
 *
 *   - **chain**, because a note's commitment only exists on the chain that
 *     minted it. A vault carried across networks holds notes whose commitments
 *     are absent, and the scan reads that absence as "spent or gone".
 *   - **account**, canonicalised the same way the key derivation canonicalises
 *     it. Keying by the raw address instead means a wallet that re-lists an
 *     account under a different SS58 prefix derives the SAME key but opens a
 *     DIFFERENT vault — the user sees an empty balance with nothing to explain
 *     it, while the real notes sit orphaned under the old name.
 *
 * A host that names its own vault will eventually get one of these wrong, so the
 * naming lives here rather than in a comment.
 */
import { canonicalAccountId } from '../../protocol/keys/accountIdentity';

const PREFIX = 'orbinum-vault';

/**
 * Storage name for one account's vault on one chain.
 *
 * `chainFingerprint` is the chain's genesis hash. It is optional because a host
 * may not know it yet during connect; the name then scopes by account alone and
 * is promoted once the fingerprint arrives. Opening a vault under the short name
 * and later under the long one is safe — `VaultStore.unlock` detects the
 * fingerprint change and resets rather than mixing two chains' notes.
 */
export function vaultStorageName(address: string, chainFingerprint?: string): string {
    const account = canonicalAccountId(address);
    return chainFingerprint
        ? `${PREFIX}-${chainFingerprint.toLowerCase()}-${account}`
        : `${PREFIX}-${account}`;
}
