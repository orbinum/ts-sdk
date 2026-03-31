import type { SignatureScheme } from './types';

export function mapRawScheme(raw: unknown): SignatureScheme {
    if (raw === 'Eip191' || raw === 'eip191') return 'Eip191';
    if (raw === 'Ed25519' || raw === 'ed25519') return 'Ed25519';
    return raw as SignatureScheme;
}
