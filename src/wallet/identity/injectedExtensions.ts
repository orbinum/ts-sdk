/**
 * Browser wallet extensions, for hosts that actually have a page to inject into.
 *
 * `polkadot-api/pjs-signer` reads a bare `window.injectedWeb3` — correct for a
 * dApp in a tab, and a `ReferenceError` everywhere else this SDK runs: React
 * Native, Node, a Cloudflare Worker, and the surprising one, an extension's own
 * service worker. A crash instead of "no extension is reachable".
 *
 * These wrappers turn that into an ordinary checkable condition, so a host can
 * branch to its own signing path. Deliberately thin — this file translates an
 * environment assumption and nothing else; signing stays upstream.
 */
import {
    connectInjectedExtension as pjsConnect,
    getInjectedExtensions as pjsGetExtensions,
} from 'polkadot-api/pjs-signer';
import type { InjectedExtension } from 'polkadot-api/pjs-signer';

/**
 * Whether browser wallet extensions can be discovered at all. A host that gets
 * false must sign some other way — there is no fallback to arrange here.
 */
export function hasInjectedExtensions(): boolean {
    // Through `globalThis`, never naming `window`: that name is `lib.dom`, and
    // this module compiles for hosts that have neither the lib nor the object.
    const host = (globalThis as { window?: { injectedWeb3?: unknown } }).window;
    return host !== undefined && host.injectedWeb3 !== undefined;
}

const NO_PAGE =
    'No browser wallet extensions available: this environment has no `window.injectedWeb3`. ' +
    'Check hasInjectedExtensions() first, and use a keypair signer (getSubstrateSigner) off-page.';

/**
 * Installed extension ids, or an empty list where none can exist.
 *
 * Empty rather than a throw: off-page, "which extensions are present" has an
 * honest answer, and it is "none". A caller rendering a picker wants a list.
 */
export function getInjectedExtensions(): string[] {
    if (!hasInjectedExtensions()) return [];
    return pjsGetExtensions();
}

/**
 * Connects to one extension by id. Throws off-page, unlike the enumerator: the
 * caller named an extension, so silence would misreport "not installed" for
 * "this host cannot reach extensions at all".
 */
export function connectInjectedExtension(
    name: string,
    origin?: string
): Promise<InjectedExtension> {
    if (!hasInjectedExtensions()) return Promise.reject(new Error(NO_PAGE));
    return origin === undefined ? pjsConnect(name) : pjsConnect(name, origin);
}
