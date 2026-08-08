import { describe, it, expect } from 'vitest';
import {
    normalizeChainFingerprint,
    buildConfig,
    VAULT_SCHEMA_VERSION,
} from '../../../../src/wallet/vault/storage/config';

// ─── normalizeChainFingerprint ────────────────────────────────────────────────

describe('normalizeChainFingerprint', () => {
    it('convierte a lowercase', () => {
        expect(normalizeChainFingerprint('0xABCDEF')).toBe('0xabcdef');
    });

    it('retorna undefined para null', () => {
        expect(normalizeChainFingerprint(null)).toBeUndefined();
    });

    it('retorna undefined para string vacío', () => {
        expect(normalizeChainFingerprint('')).toBeUndefined();
    });

    it('retorna undefined cuando no se pasa argumento', () => {
        expect(normalizeChainFingerprint()).toBeUndefined();
    });

    it('no modifica fingerprints ya en lowercase', () => {
        expect(normalizeChainFingerprint('0xdeadbeef')).toBe('0xdeadbeef');
    });

    it('normaliza fingerprints mixtos', () => {
        expect(normalizeChainFingerprint('0xDeAdBeEf')).toBe('0xdeadbeef');
    });
});

// ─── buildConfig ──────────────────────────────────────────────────────────────

describe('buildConfig', () => {
    it('produce un VaultConfigRecord con id=main y v=4', () => {
        const cfg = buildConfig(null);
        expect(cfg.id).toBe('main');
        expect(cfg.v).toBe(4);
    });

    it('stamps the version hosts pass as expectedSchemaVersion', () => {
        // These two must never drift. A host passes VAULT_SCHEMA_VERSION to
        // unlock(); if buildConfig wrote anything else, every vault would fail
        // the check and reset on the very next unlock.
        expect(buildConfig(null).v).toBe(VAULT_SCHEMA_VERSION);
    });

    it('preserva createdAt del config existente', () => {
        const existing = { createdAt: 1000 };
        const cfg = buildConfig(existing);
        expect(cfg.createdAt).toBe(1000);
    });

    it('usa Date.now() como createdAt cuando no hay config existente', () => {
        const before = Date.now();
        const cfg = buildConfig(null);
        const after = Date.now();
        expect(cfg.createdAt).toBeGreaterThanOrEqual(before);
        expect(cfg.createdAt).toBeLessThanOrEqual(after);
    });

    it('updatedAt es siempre Date.now()', () => {
        const before = Date.now();
        const cfg = buildConfig(null);
        const after = Date.now();
        expect(cfg.updatedAt).toBeGreaterThanOrEqual(before);
        expect(cfg.updatedAt).toBeLessThanOrEqual(after);
    });

    it('incluye chainFingerprint cuando se provee', () => {
        const cfg = buildConfig(null, '0xgenesis');
        expect(cfg.chainFingerprint).toBe('0xgenesis');
    });

    it('no incluye chainFingerprint cuando no se provee', () => {
        const cfg = buildConfig(null);
        expect('chainFingerprint' in cfg).toBe(false);
    });

    it('actualiza updatedAt aunque exista un config previo', () => {
        const existing = { createdAt: 1 };
        const before = Date.now();
        const cfg = buildConfig(existing);
        expect(cfg.updatedAt).toBeGreaterThanOrEqual(before);
        expect(cfg.createdAt).toBe(1);
    });
});
