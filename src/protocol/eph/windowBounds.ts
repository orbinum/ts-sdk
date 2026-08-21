/**
 * The ceiling every ephemeral window shares.
 *
 * A window's `count` decides how many elliptic-curve multiplications run, and
 * it usually arrives from stored config — `windowSizeForCounter` reads the
 * vault's counter to size the self window. A corrupt or hostile value there is
 * not a wrong answer, it is a loop that does not end.
 *
 * The three sequences bound it identically, and from one place: three copies of
 * a limit is how they drift apart, and a window that is generous in one
 * sequence and strict in another is a bug that only shows on the sequence
 * nobody tested.
 *
 * 2^20 is far above any real window — the self sequence tops out in the low
 * thousands — so this never rejects a legitimate scan. It exists to make an
 * absurd value fail immediately instead of hanging the wallet.
 */
export const MAX_EPH_WINDOW = 1 << 20;
