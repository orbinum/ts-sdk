/**
 * The worker entry must not reach a chain library.
 *
 * `@orbinum/sdk/worker` exists so a scan can decrypt inside a worker carrying
 * the decryption path and nothing else. `polkadot-api` and `@polkadot/*` are
 * PEER dependencies, so a bundle that imports them fails to load when the host
 * did not install them — and a worker has no reason to.
 *
 * This regressed once already: the kernel imports `deriveViewingPublicKey`
 * (pure curve math) from `PrivacyKeys`, which also held `deriveMasterKeyBytes`,
 * which resolves an address through an SS58 decoder. One unrelated function in
 * a shared module made the whole worker subpath require a chain library. The
 * address-shaped derivations now live in `spendingKeyDerivation.ts`.
 *
 * Walks the real import graph from source rather than checking the built
 * bundle, so the failure names the file that introduced the edge.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

const ROOT = resolve(__dirname, '../../../..');
const ENTRY = resolve(ROOT, 'src/wallet/worker/index.ts');

/** Bare specifiers a worker bundle must never pull in. */
const FORBIDDEN = [/^polkadot-api($|\/)/, /^@polkadot\//];

/** Resolves a relative specifier to a file on disk, trying the usual endings. */
function resolveLocal(fromFile: string, spec: string): string | null {
    const base = resolve(dirname(fromFile), spec);
    for (const candidate of [base, `${base}.ts`, `${base}/index.ts`]) {
        if (existsSync(candidate) && candidate.endsWith('.ts')) return candidate;
    }
    return null;
}

/** Every specifier imported or re-exported by a module. */
function specifiersOf(source: string): string[] {
    return [...source.matchAll(/(?:from|import)\s*['"]([^'"]+)['"]/g)].map((m) => m[1]!);
}

/** Walks the graph from `entry`, returning every forbidden edge it finds. */
function forbiddenEdges(entry: string): string[] {
    const seen = new Set<string>();
    const found: string[] = [];
    const walk = (file: string) => {
        if (seen.has(file)) return;
        seen.add(file);
        const source = readFileSync(file, 'utf8');
        for (const spec of specifiersOf(source)) {
            if (FORBIDDEN.some((re) => re.test(spec))) {
                found.push(`${file.slice(ROOT.length + 1)} → ${spec}`);
                continue;
            }
            if (!spec.startsWith('.')) continue; // another bare dep, not ours to police
            const next = resolveLocal(file, spec);
            if (next) walk(next);
        }
    };
    walk(entry);
    return found;
}

describe('worker entry import graph', () => {
    it('never reaches polkadot-api or @polkadot/*', () => {
        expect(forbiddenEdges(ENTRY)).toEqual([]);
    });

    it('the check itself works — the root entry DOES reach a chain library', () => {
        // Guards against the walker silently resolving nothing and passing
        // vacuously: the root entry legitimately imports PAPI, so it must fail.
        expect(forbiddenEdges(resolve(ROOT, 'src/index.ts')).length).toBeGreaterThan(0);
    });
});
