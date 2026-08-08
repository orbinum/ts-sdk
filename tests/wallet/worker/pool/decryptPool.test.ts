/**
 * createDecryptPool — worker-pool logic with an injected fake factory
 * (jsdom has no Worker) plus the yielded main-thread fallback.
 * Covers: slice split/reassembly, worker reuse, abort, crash teardown,
 * fallback yield/abort granularity.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ZkNote } from '../../../../src/protocol/types';

const mocks = vi.hoisted(() => ({ tryDecryptNoteVerbose: vi.fn() }));
vi.mock('../../../../src/protocol/note/NoteDecryptor', () => ({
    tryDecryptNoteVerbose: mocks.tryDecryptNoteVerbose,
}));

import { createDecryptPool, DECRYPT_YIELD_EVERY } from '../../../../src/index';
import type { WorkerLike, WorkerMessage } from '../../../../src/index';
import type { ScanKeys } from '../../../../src/index';

const KEYS: ScanKeys = { viewingKey: new Uint8Array([1]), spendingKey: 2n, ownerPk: 3n };

const hint = (n: number) => ({ commitmentHex: `0xc${n}`, leafIndex: n, encryptedMemo: `0xm${n}` });
const hints = (n: number) => Array.from({ length: n }, (_, i) => hint(i));

/** Fake worker: replies async con una nota-eco por hint (o nunca, si se pide). */
class FakeWorker implements WorkerLike {
    onmessage: ((event: WorkerMessage) => void) | null = null;
    onerror: ((event: unknown) => void) | null = null;
    received: Array<{ hints: Array<{ commitmentHex: string }> }> = [];
    terminated = false;

    constructor(private readonly mode: 'echo' | 'silent' | 'error' | 'crash' = 'echo') {}

    postMessage(message: unknown): void {
        const req = message as { hints: Array<{ commitmentHex: string }> };
        this.received.push(req);
        if (this.mode === 'silent') return;
        queueMicrotask(() => {
            if (this.mode === 'crash') {
                this.onerror?.({});
            } else if (this.mode === 'error') {
                this.onmessage?.({ data: { error: 'boom' } });
            } else {
                const notes = req.hints.map((h) => ({ commitmentHex: h.commitmentHex }) as ZkNote);
                this.onmessage?.({ data: { notes } });
            }
        });
    }

    terminate(): void {
        this.terminated = true;
    }
}

describe('createDecryptPool — worker pool', () => {
    beforeEach(() => vi.clearAllMocks());

    it('reparte en slices por worker y reensambla en orden de entrada', async () => {
        const workers: FakeWorker[] = [];
        const pool = createDecryptPool({
            factory: () => {
                const w = new FakeWorker();
                workers.push(w);
                return w;
            },
            size: 3,
        });

        const { notes } = await pool.decryptBatch(hints(10), KEYS);

        // ceil(10/3)=4 → slices [4,4,2] en 3 workers.
        expect(workers).toHaveLength(3);
        expect(workers.map((w) => w.received[0]?.hints.length)).toEqual([4, 4, 2]);
        // Orden de entrada restaurado.
        expect(notes.map((n) => n?.commitmentHex)).toEqual(hints(10).map((h) => h.commitmentHex));
    });

    it('reusa los workers entre batches (páginas)', async () => {
        const factory = vi.fn(() => new FakeWorker());
        const pool = createDecryptPool({ factory, size: 2 });

        await pool.decryptBatch(hints(4), KEYS);
        await pool.decryptBatch(hints(4), KEYS);

        expect(factory).toHaveBeenCalledTimes(2); // 2 workers, no 4
    });

    it('batch vacío no spawnea workers', async () => {
        const factory = vi.fn(() => new FakeWorker());
        const pool = createDecryptPool({ factory, size: 2 });

        expect(await pool.decryptBatch([], KEYS)).toEqual({
            notes: [],
            tagFiltered: 0,
            selfMatched: 0,
            pairwiseMatched: 0,
            maxSelfEphIndex: null,
        });
        expect(factory).not.toHaveBeenCalled();
    });

    it('abort en vuelo rechaza con AbortError y termina los workers', async () => {
        const workers: FakeWorker[] = [];
        const pool = createDecryptPool({
            factory: () => {
                const w = new FakeWorker('silent');
                workers.push(w);
                return w;
            },
            size: 2,
        });
        const controller = new AbortController();

        const promise = pool.decryptBatch(hints(4), KEYS, controller.signal);
        controller.abort();

        await expect(promise).rejects.toMatchObject({ name: 'AbortError' });
        expect(workers.every((w) => w.terminated)).toBe(true);
    });

    it('señal ya abortada rechaza sin enviar nada', async () => {
        const factory = vi.fn(() => new FakeWorker());
        const pool = createDecryptPool({ factory, size: 2 });
        const controller = new AbortController();
        controller.abort();

        await expect(pool.decryptBatch(hints(4), KEYS, controller.signal)).rejects.toMatchObject({
            name: 'AbortError',
        });
        expect(factory).not.toHaveBeenCalled();
    });

    it('error reportado por un worker rechaza y desmonta el pool', async () => {
        const workers: FakeWorker[] = [];
        const pool = createDecryptPool({
            factory: () => {
                const w = new FakeWorker('error');
                workers.push(w);
                return w;
            },
            size: 2,
        });

        await expect(pool.decryptBatch(hints(4), KEYS)).rejects.toThrow('boom');
        expect(workers.every((w) => w.terminated)).toBe(true);
    });

    // Deploy nuevo → el asset del worker ya no existe y el spawn crashea vía
    // onerror: el batch debe completarse en main thread, no romper el rescan.
    it('crash del worker (onerror) cae al fallback main-thread y completa el batch', async () => {
        mocks.tryDecryptNoteVerbose.mockImplementation((h: { commitmentHex: string }) => ({
            note: { commitmentHex: h.commitmentHex },
        }));
        const workers: FakeWorker[] = [];
        const pool = createDecryptPool({
            factory: () => {
                const w = new FakeWorker('crash');
                workers.push(w);
                return w;
            },
            size: 2,
        });

        const { notes } = await pool.decryptBatch(hints(4), KEYS);

        expect(notes.map((n) => n?.commitmentHex)).toEqual(hints(4).map((h) => h.commitmentHex));
        expect(workers.every((w) => w.terminated)).toBe(true);

        // Batches siguientes van directo al fallback: no se spawnean workers nuevos.
        const before = workers.length;
        await pool.decryptBatch(hints(2), KEYS);
        expect(workers.length).toBe(before);
    });

    it('terminate() destruye todos los workers', async () => {
        const workers: FakeWorker[] = [];
        const pool = createDecryptPool({
            factory: () => {
                const w = new FakeWorker();
                workers.push(w);
                return w;
            },
            size: 2,
        });
        await pool.decryptBatch(hints(4), KEYS);

        pool.terminate();

        expect(workers.every((w) => w.terminated)).toBe(true);
    });
});

describe('createDecryptPool — fallback main-thread (factory: null)', () => {
    beforeEach(() => vi.clearAllMocks());

    it('desencripta todo en orden con el kernel puro', async () => {
        mocks.tryDecryptNoteVerbose.mockImplementation((h: { commitmentHex: string }) => ({
            note: { commitmentHex: h.commitmentHex },
        }));
        const pool = createDecryptPool({ factory: null });

        const { notes } = await pool.decryptBatch(hints(30), KEYS);

        expect(notes.map((n) => n?.commitmentHex)).toEqual(hints(30).map((h) => h.commitmentHex));
    });

    it(`cede y re-chequea abort cada ${DECRYPT_YIELD_EVERY} decrypts`, async () => {
        const controller = new AbortController();
        let count = 0;
        mocks.tryDecryptNoteVerbose.mockImplementation(() => {
            count++;
            if (count === DECRYPT_YIELD_EVERY + 5) controller.abort();
            return { note: null };
        });
        const pool = createDecryptPool({ factory: null });

        await expect(pool.decryptBatch(hints(200), KEYS, controller.signal)).rejects.toMatchObject({
            name: 'AbortError',
        });
        // Cortó en el siguiente punto de yield tras el abort, no al final.
        expect(count).toBeLessThanOrEqual(DECRYPT_YIELD_EVERY * 2);
    });
});
