import type { ImageExtension } from "./images-shared";

/** Offset from the recording start as `m:ss`, or `h:mm:ss` from one hour. */
export function formatImageOffset(offsetMs: number): string {
    const totalSeconds = Math.max(0, Math.floor(offsetMs / 1000));
    const hours = Math.floor(totalSeconds / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const seconds = String(totalSeconds % 60).padStart(2, "0");
    return hours > 0
        ? `${hours}:${String(minutes).padStart(2, "0")}:${seconds}`
        : `${minutes}:${seconds}`;
}

/**
 * Export file name `<nn>-<mm>m<ss>s.<ext>`: `nn` is the 1-based position,
 * zero-padded to 2 digits (3 when the recording has 100+ photos); minutes
 * are total minutes. Without an offset the name is `<nn>.<ext>`.
 */
export function imageExportName(
    index: number,
    total: number,
    offsetMs: number | null,
    ext: ImageExtension,
): string {
    const nn = String(index + 1).padStart(total >= 100 ? 3 : 2, "0");
    if (offsetMs === null) return `${nn}.${ext}`;
    const totalSeconds = Math.max(0, Math.floor(offsetMs / 1000));
    const mm = String(Math.floor(totalSeconds / 60)).padStart(2, "0");
    const ss = String(totalSeconds % 60).padStart(2, "0");
    return `${nn}-${mm}m${ss}s.${ext}`;
}
