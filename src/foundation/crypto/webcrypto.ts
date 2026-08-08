/**
 * The WebCrypto types this package uses in its public API.
 *
 * Re-exported because they are not in TypeScript's `esnext` lib: a consumer
 * reaches them through `lib: ["dom"]` or `@types/node`, and one on neither — a
 * React Native app, a lean Node project — cannot name the type of a key this
 * package hands back or takes in. Importing it from here always works.
 */
export type { CryptoKey } from './webcrypto-types';
