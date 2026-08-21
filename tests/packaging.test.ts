/**
 * The package's shipped shape.
 *
 * These assertions guard things that are invisible during development and only
 * break for consumers: a subpath declared in `exports` with no entry behind it,
 * an entry the build never emits, or a dependency the SDK expects the host to
 * provide but never declares. A `link:`-ed consumer resolves `src/` directly and
 * sails past all three.
 *
 * The subpaths are asserted while still empty on purpose. Declaring them up
 * front is what keeps later phases additive — adding a subpath after browser
 * code has shipped from the root entry is a breaking change.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(__dirname, '..');
const pkg = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')) as {
    exports: Record<string, unknown>;
    scripts: Record<string, string>;
    dependencies: Record<string, string>;
    devDependencies: Record<string, string>;
    peerDependencies: Record<string, string>;
    files: string[];
    sideEffects: boolean;
};

/**
 * Subpath → the source entry `tsup` must be pointed at to satisfy it.
 *
 * The PUBLIC names on the left are frozen — `@orbinum/sdk/worker` is what
 * consumers import — while the paths on the right follow the source layout and
 * moved when it did. Keeping the two columns apart is the point of this test:
 * a reorganisation may change where a subpath is BUILT from, never what it is
 * called.
 */
const ENTRIES: Record<string, string> = {
    '.': 'src/index.ts',
    './storage/indexeddb': 'src/adapters/indexeddb/index.ts',
    './worker': 'src/wallet/worker/index.ts',
};

describe('exports map', () => {
    it('declares every subpath the wallet layers will land on', () => {
        for (const subpath of Object.keys(ENTRIES)) {
            expect(pkg.exports[subpath], `missing export "${subpath}"`).toBeDefined();
        }
        // `./package.json` lets tooling read the manifest without deep-importing.
        expect(pkg.exports['./package.json']).toBe('./package.json');
    });

    it('has a source entry behind each declared subpath', () => {
        for (const [subpath, entry] of Object.entries(ENTRIES)) {
            expect(existsSync(resolve(root, entry)), `${subpath} → ${entry} missing`).toBe(true);
        }
    });

    it('builds every declared entry', () => {
        // A subpath the build never emits resolves to nothing at install time —
        // and nothing in a dev checkout would notice.
        for (const entry of Object.values(ENTRIES)) {
            expect(pkg.scripts['build']).toContain(entry);
        }
    });

    it('offers types, import and require for each subpath', () => {
        for (const subpath of Object.keys(ENTRIES)) {
            const cond = pkg.exports[subpath] as Record<string, string>;
            expect(cond['types'], `${subpath}.types`).toMatch(/\.d\.ts$/);
            expect(cond['import'], `${subpath}.import`).toMatch(/\.mjs$/);
            expect(cond['require'], `${subpath}.require`).toMatch(/\.js$/);
        }
    });

    it('ships dist and marks itself side-effect free', () => {
        expect(pkg.files).toContain('dist');
        // Without this, a Node consumer cannot tree-shake the browser adapter.
        expect(pkg.sideEffects).toBe(false);
    });
});

describe('peer dependencies', () => {
    // These are singletons in practice: a second copy of polkadot-api means a
    // second connection and a second view of chain state.
    const PEERS = ['polkadot-api', '@polkadot/util-crypto'];

    it('declares the host-provided packages as peers, not dependencies', () => {
        for (const name of PEERS) {
            expect(pkg.peerDependencies[name], `${name} should be a peer`).toBeDefined();
            expect(pkg.dependencies[name], `${name} must not be a hard dependency`).toBeUndefined();
        }
    });

    it('keeps them in devDependencies so the SDK can test itself', () => {
        for (const name of PEERS) {
            expect(pkg.devDependencies[name], `${name} missing from devDependencies`).toBeDefined();
        }
    });
});

/**
 * 1.0.0 ships no deprecated surface.
 *
 * The rename to Substrate-prefixed names briefly kept the old ones as
 * `@deprecated` aliases so consumers could migrate gradually. That is a policy
 * for a MINOR release; 1.0.0 is the line where the API is declared, so a
 * consumer upgrading to it must fail to compile rather than silently keep using
 * a name that will disappear later.
 *
 * Reads the built entry point, because an alias re-added anywhere in the graph
 * lands there regardless of which file introduced it.
 */
describe('no deprecated or legacy surface', () => {
    const entry = readFileSync(resolve(__dirname, '../src/index.ts'), 'utf8');

    it('carries no @deprecated export', () => {
        expect(entry).not.toMatch(/@deprecated/);
    });

    it.each(['PolkadotSigner', 'getPolkadotSigner', 'getPolkadotSignerFromPjs'])(
        'does not re-export the pre-rename name %s',
        (name) => {
            // Aliasing at the import (`X as SubstrateX`) is fine and expected —
            // it keeps the PAPI dependency visible on one line. What must not
            // exist is an export that hands the OLD name back to a consumer.
            const exported = new RegExp(`export[^;]*\\b${name}\\b(?!\\s+as\\b)[^;]*;`, 's');
            expect(entry).not.toMatch(exported);
        }
    );
});

/**
 * Lo que la entrada raíz expone, y lo que NO.
 *
 * `src/index.ts` afirma que el barrel de EVM se re-exporta POR NOMBRE en vez de
 * con `export *`, precisamente para no arrastrar el codificador ABI que usa por
 * dentro. Nada lo fijaba: cambiar esas líneas por un splat compila, pasa todos
 * los tests, y convierte `decodeUint` en API pública que después hay que
 * mantener.
 */
describe('la superficie de la entrada raíz', () => {
    it('no filtra los internals del codificador ABI', async () => {
        const sdk = await import('../src/index');

        const leaked = ['decodeUint', 'decodeBytes32', 'encodeAbi', 'uint32'].filter(
            (name) => name in sdk
        );

        expect(leaked).toEqual([]);
    });

    it('sí exporta lo que su cabecera promete', async () => {
        // El contraste: sin esto, un `export {}` vacío pasaría el test anterior.
        const sdk = await import('../src/index');

        for (const name of [
            'EvmClient',
            'EvmExplorer',
            'SPENDING_KEY_WARNING',
            'PRECOMPILE_ADDR',
            'decodePrecompileCalldata',
        ]) {
            expect(name in sdk, name).toBe(true);
        }
    });
});
