import { describe, it, expect } from 'vitest';
import { VaultLockedError } from '../../src/vault/errors';

describe('VaultLockedError', () => {
    it('es instancia de Error', () => {
        expect(new VaultLockedError()).toBeInstanceOf(Error);
    });

    it('name es VaultLockedError', () => {
        expect(new VaultLockedError().name).toBe('VaultLockedError');
    });

    it('mensaje por defecto presente', () => {
        expect(new VaultLockedError().message.length).toBeGreaterThan(0);
    });

    it('mensaje personalizado funciona', () => {
        expect(new VaultLockedError('custom msg').message).toBe('custom msg');
    });

    it('se puede capturar con instanceof en un catch', () => {
        function throwIt() { throw new VaultLockedError(); }
        try {
            throwIt();
            expect.fail('no debería llegar aquí');
        } catch (err) {
            expect(err).toBeInstanceOf(VaultLockedError);
            expect(err).toBeInstanceOf(Error);
        }
    });
});
