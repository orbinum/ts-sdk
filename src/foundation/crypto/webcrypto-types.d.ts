/**
 * Ambient WebCrypto declarations, used only when the consumer's own lib does not
 * provide them. Structural typing means a `CryptoKey` from `lib.dom` or from
 * `@types/node` satisfies this one and vice versa.
 */
export interface CryptoKey {
    readonly algorithm: { name: string; [key: string]: unknown };
    readonly extractable: boolean;
    readonly type: string;
    readonly usages: string[];
}
