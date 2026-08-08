/**
 * The vault: a wallet's notes, encrypted at rest and kept in step with the chain.
 *
 * Layered bottom-up, each layer depending only on those below it:
 *
 * ```
 * store/     VaultStore — composes the three below into what a wallet calls
 * notes/     the record round trip, provenance, merge rules, in-memory cache
 * storage/   the backend contract, the records crossing it, config, eph indexes
 * session/   the keys held while unlocked
 * crypto/    key derivation and the AES-GCM envelope
 * ```
 *
 * Nothing here knows about a UI framework, a database or a network. A host
 * supplies a `NoteStorage` backend, a `WalletSession` and a `NotesCache`; those
 * three seams are what let the same vault run in a browser, an extension
 * service worker, a mobile runtime or a Node process.
 */
export * from './crypto/index';
export * from './session/index';
export * from './storage/index';
export * from './notes/index';
export * from './store/index';
