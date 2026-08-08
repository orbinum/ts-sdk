/**
 * Browser wallet extensions, for hosts that actually have a page to inject into.
 *
 * `polkadot-api/pjs-signer` reads a bare `window.injectedWeb3`. That is correct
 * for a dApp in a tab and wrong everywhere else this SDK runs: a React Native
 * app, a Node process, a Cloudflare Worker, and — the surprising one — an
 * extension's own service worker all lack `window`, so the call dies with
 * `ReferenceError: window is not defined` rather than reporting that no
 * extension is reachable.
 *
 * These wrappers keep the capability on the root entry while making the absence
 * of a page an ordinary, checkable condition. `hasInjectedExtensions()` lets a
 * mobile or extension host branch to its own signing path instead of discovering
 * the limitation through a crash.
 *
 * The wrapping is deliberately thin: this file translates an environment
 * assumption, and nothing else. Signing itself stays in the upstream library.
 */
import {
    connectInjectedExtension as pjsConnect,
    getInjectedExtensions as pjsGetExtensions,
} from 'polkadot-api/pjs-signer';
import type { InjectedExtension } from 'polkadot-api/pjs-signer';

/**
 * Whether browser wallet extensions can be discovered at all.
 *
 * False in React Native, Node, a Cloudflare Worker and an extension service
 * worker. A host that gets false must sign some other way — there is no
 * fallback to arrange here, only a fact to report.
 */
export function hasInjectedExtensions(): boolean {
    // Reached through `globalThis` rather than naming `window`: that name is
    // `lib.dom`, and this module compiles for hosts that have neither the lib
    // nor the object.
    const host = (globalThis as { window?: { injectedWeb3?: unknown } }).window;
    return host !== undefined && host.injectedWeb3 !== undefined;
}

const NO_PAGE =
    'No browser wallet extensions available: this environment has no `window.injectedWeb3`. ' +
    'Check hasInjectedExtensions() first, and use a keypair signer (getSubstrateSigner) off-page.';

/**
 * Installed extension ids, or an empty list where none can exist.
 *
 * Returns empty rather than throwing: "which extensions are present" has an
 * honest answer off-page, and it is "none". A caller enumerating wallets to
 * render a picker wants a list, not an exception.
 */
export function getInjectedExtensions(): string[] {
    if (!hasInjectedExtensions()) return [];
    return pjsGetExtensions();
}

/**
 * Connects to one extension by id.
 *
 * Throws off-page, unlike the enumerator above: the caller asked for a specific
 * extension, so an empty result would misreport "not installed" for what is
 * really "this host cannot reach extensions at all".
 */
export function connectInjectedExtension(
    name: string,
    origin?: string
): Promise<InjectedExtension> {
    if (!hasInjectedExtensions()) return Promise.reject(new Error(NO_PAGE));
    return origin === undefined ? pjsConnect(name) : pjsConnect(name, origin);
}
