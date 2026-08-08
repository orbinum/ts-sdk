/**
 * extrinsicFacts — reading the relay fee and on-chain outcome back off an
 * outgoing transfer. Covered here in isolation from reconstruction, since the
 * decode rules (which fee shapes are accepted) are the part that must not drift.
 */
import { vi, describe, it, expect } from 'vitest';
import type { TxFactsSource } from '../../../../src/wallet/scanner/feed/sources';
import { fetchExtrinsicFacts } from '../../../../src/wallet/scanner/history/extrinsicFacts';

const HASH = '0xhash';

/** A TxFactsSource resolving every lookup to `row`. */
function sourceReturning(row: unknown): TxFactsSource {
    return { byHash: vi.fn().mockResolvedValue(row) };
}

/** An extrinsic row as `/extrinsics/:hash` serves it. */
function row(over: { fee?: unknown; success?: boolean } = {}) {
    const { fee = '5000', success = true } = over;
    return { hash: HASH, success, argsJson: JSON.stringify({ fee, asset_id: 0 }) };
}

describe('fetchExtrinsicFacts', () => {
    it('lee el fee y el éxito de los args decodificados', async () => {
        const facts = await fetchExtrinsicFacts(sourceReturning(row()), HASH);
        expect(facts).toEqual({ fee: 5000n, success: true });
    });

    it('sin hash no consulta al indexer', async () => {
        const source = sourceReturning(row());

        expect(await fetchExtrinsicFacts(source, null)).toEqual({ fee: null, success: true });
        expect(source.byHash).not.toHaveBeenCalled();
    });

    it('propaga success:false', async () => {
        const facts = await fetchExtrinsicFacts(sourceReturning(row({ success: false })), HASH);
        expect(facts.success).toBe(false);
    });

    // ─── Formas del fee ─────────────────────────────────────────────────────────

    it('acepta el fee como string decimal (u128 serializado)', async () => {
        const big = 10n ** 30n; // fuera del rango de Number
        const facts = await fetchExtrinsicFacts(
            sourceReturning(row({ fee: big.toString() })),
            HASH
        );
        expect(facts.fee).toBe(big);
    });

    it('acepta el fee como número (u128 chico que sobrevivió la decodificación)', async () => {
        const facts = await fetchExtrinsicFacts(sourceReturning(row({ fee: 12345 })), HASH);
        expect(facts.fee).toBe(12345n);
    });

    it.each([
        ['string no numérico', '12abc'],
        ['string vacío', ''],
        ['hex', '0x1f'],
        ['negativo', -5],
        ['fraccionario', 1.5],
        ['null', null],
        ['objeto', { value: 5 }],
    ])('rechaza un fee %s → null, nunca un valor a medias', async (_label, fee) => {
        const facts = await fetchExtrinsicFacts(sourceReturning(row({ fee })), HASH);
        expect(facts.fee).toBeNull();
    });

    // ─── Degradación ────────────────────────────────────────────────────────────

    it.each([
        ['extrinsic ausente (404)', sourceReturning(null)],
        ['argsJson corrupto', sourceReturning({ success: true, argsJson: '{no json' })],
        ['argsJson ausente', sourceReturning({ success: true })],
        ['sin campo fee', sourceReturning({ success: true, argsJson: '{"asset_id":0}' })],
    ])('%s → fee null sin lanzar', async (_label, indexer) => {
        const facts = await fetchExtrinsicFacts(indexer, HASH);
        expect(facts.fee).toBeNull();
    });

    it('indexer inalcanzable → hechos desconocidos, no propaga el error', async () => {
        const source: TxFactsSource = { byHash: vi.fn().mockRejectedValue(new Error('offline')) };

        // Un rescan degrada a un registro aproximado en vez de abortar.
        await expect(fetchExtrinsicFacts(source, HASH)).resolves.toEqual({
            fee: null,
            success: true,
        });
    });
});
