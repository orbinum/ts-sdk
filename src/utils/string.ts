/** Truncate a string in the middle with an ellipsis. */
export function truncateMiddle(str: string, start: number, end: number): string {
    if (!str) return '';
    if (str.length <= start + end + 1) return str;
    return `${str.slice(0, start)}…${str.slice(-end)}`;
}

/** Shorten a hash for compact inline display. */
export function shortHash(h: string, start = 8, end = 6): string {
    return truncateMiddle(h, start, end);
}
