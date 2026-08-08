/**
 * The `orbinum://notes/v1/` wire format — notes moved between Orbinum clients
 * (desktop → mobile) as scannable pages.
 *
 * This is a CROSS-CLIENT CONTRACT: whatever encodes and whatever decodes must
 * agree byte for byte, and they ship separately. Both halves live here so a
 * field rename or a version bump breaks the build instead of breaking someone's
 * import silently.
 *
 * ## What travels
 *
 * The full spendable note, INCLUDING its spending key. Anyone who scans these
 * codes can spend the notes — the format assumes an offline, in-person transfer
 * between two devices the same person controls, and a host must say so before
 * showing one.
 *
 * ## Why pages
 *
 * A QR code has a hard capacity, so the note list is split until each page fits
 * `QR_PAGE_MAX_CHARS`. Pages carry their own index and total, so a scanner can
 * tell the user what is still missing and reject a mixed-batch scan.
 */
import { base64UrlEncode, base64UrlDecode } from '../../../foundation/encoding/base64url';
import { scalarToHex } from '../../../foundation/encoding/hex';
import type { ZkNote } from '../../../protocol/types';

/** URI namespace. The version is in the path, so a v2 scanner can refuse a v1. */
export const NOTE_TRANSFER_URI_SCHEME = 'orbinum://notes/v1/';

/**
 * Max characters per page. Chosen for QR error-correction level M, which stays
 * scannable from a phone at arm's length.
 */
export const QR_PAGE_MAX_CHARS = 1800;

/**
 * One note on the wire. Field names are abbreviated because every byte costs
 * QR density — and they are FROZEN: renaming one breaks every deployed scanner.
 */
export interface NoteTransferEntry {
    /** commitmentHex */
    c: string;
    /** nullifierHex */
    n: string;
    /** value, decimal string */
    val: string;
    /** assetId, decimal string */
    aid: string;
    /** ownerPk, 0x-prefixed 64-char hex */
    opk: string;
    /** blinding, 0x-prefixed 64-char hex */
    bld: string;
    /** spendingKey, 0x-prefixed 64-char hex */
    sk: string;
}

export interface NoteTransferPayload {
    v: 1;
    /** Encode time (ms). Informational — a scanner may warn on a stale batch. */
    ts: number;
    /** Page index, 0-based. */
    p: number;
    /** Total pages in this batch. */
    pt: number;
    notes: NoteTransferEntry[];
}

export function noteToTransferEntry(note: ZkNote): NoteTransferEntry {
    return {
        c: note.commitmentHex,
        n: note.nullifierHex,
        val: note.value.toString(),
        aid: note.assetId.toString(),
        opk: scalarToHex(note.ownerPk),
        bld: scalarToHex(note.blinding),
        sk: scalarToHex(note.spendingKey),
    };
}

/**
 * Encodes notes into scannable page URIs.
 *
 * `now` is injectable so a caller can produce a deterministic batch (tests, or
 * a reproducible export).
 */
export function encodeNoteTransferPages(
    notes: ZkNote[],
    options: { now?: () => number; maxChars?: number } = {}
): string[] {
    const now = options.now ?? Date.now;
    const maxChars = options.maxChars ?? QR_PAGE_MAX_CHARS;
    const entries = notes.map(noteToTransferEntry);

    // Group first, then stamp: the page total has to be known before any page
    // is written, and it is part of what each page carries.
    const batches: NoteTransferEntry[][] = [];
    let batch: NoteTransferEntry[] = [];
    for (const entry of entries) {
        batch.push(entry);
        // Probe with fixed counters — their digit count is negligible against
        // an entry, and a probe that grew with the real values would make page
        // size depend on page index.
        const probe: NoteTransferPayload = { v: 1, ts: 0, p: 0, pt: 1, notes: batch };
        const size =
            NOTE_TRANSFER_URI_SCHEME.length + base64UrlEncode(JSON.stringify(probe)).length;
        if (size > maxChars && batch.length > 1) {
            batch.pop();
            batches.push(batch);
            batch = [entry];
        }
    }
    if (batch.length > 0) batches.push(batch);

    const ts = now();
    return batches.map((notesInPage, i) => {
        const payload: NoteTransferPayload = {
            v: 1,
            ts,
            p: i,
            pt: batches.length,
            notes: notesInPage,
        };
        return NOTE_TRANSFER_URI_SCHEME + base64UrlEncode(JSON.stringify(payload));
    });
}

/**
 * Decodes one scanned page, or throws with a reason a scanner can show.
 *
 * Strict on purpose: a partially-understood payload would import notes with
 * missing fields, and an unspendable note in a vault is worse than a failed
 * scan the user can retry.
 */
export function decodeNoteTransferPage(uri: string): NoteTransferPayload {
    if (!uri.startsWith(NOTE_TRANSFER_URI_SCHEME)) {
        throw new Error('Not an Orbinum note-transfer code.');
    }
    let payload: unknown;
    try {
        payload = JSON.parse(base64UrlDecode(uri.slice(NOTE_TRANSFER_URI_SCHEME.length)));
    } catch {
        throw new Error('Note-transfer code is corrupt.');
    }

    const p = payload as Partial<NoteTransferPayload>;
    if (p.v !== 1) {
        throw new Error(`Unsupported note-transfer version: ${String(p.v)}.`);
    }
    if (
        typeof p.p !== 'number' ||
        typeof p.pt !== 'number' ||
        !Array.isArray(p.notes) ||
        p.notes.some((n) => !isEntry(n))
    ) {
        throw new Error('Note-transfer code is missing required fields.');
    }
    return p as NoteTransferPayload;
}

function isEntry(value: unknown): value is NoteTransferEntry {
    if (typeof value !== 'object' || value === null) return false;
    const e = value as Record<string, unknown>;
    return (['c', 'n', 'val', 'aid', 'opk', 'bld', 'sk'] as const).every(
        (k) => typeof e[k] === 'string' && (e[k] as string).length > 0
    );
}

/**
 * Reassembles a scanned batch into notes.
 *
 * Rejects an incomplete or mixed batch rather than importing what it has: a
 * partial import looks like a successful one, and the user would never learn
 * which notes never made it.
 */
export function assembleNoteTransfer(pages: NoteTransferPayload[]): NoteTransferEntry[] {
    if (pages.length === 0) throw new Error('No pages scanned.');
    const total = pages[0]!.pt;
    if (pages.some((p) => p.pt !== total)) {
        throw new Error('Pages come from different batches.');
    }
    const seen = new Set(pages.map((p) => p.p));
    if (seen.size !== total) {
        const missing = [...Array(total).keys()].filter((i) => !seen.has(i));
        throw new Error(`Missing page(s): ${missing.map((i) => i + 1).join(', ')} of ${total}.`);
    }
    return [...pages].sort((a, b) => a.p - b.p).flatMap((p) => p.notes);
}
