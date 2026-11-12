const SEEK_EVENT = "riffado:recording-seek";

interface SeekDetail {
    recordingId: string;
    offsetMs: number;
}

/** Ask the player of `recordingId` on this page to jump to `offsetMs` and play. */
export function requestRecordingSeek(
    recordingId: string,
    offsetMs: number,
): void {
    window.dispatchEvent(
        new CustomEvent<SeekDetail>(SEEK_EVENT, {
            detail: { recordingId, offsetMs },
        }),
    );
}

/** Listen for seek requests for one recording; returns the unsubscribe function. */
export function onRecordingSeek(
    recordingId: string,
    handler: (offsetMs: number) => void,
): () => void {
    const listener = (event: Event) => {
        const detail = (event as CustomEvent<SeekDetail>).detail;
        if (detail?.recordingId === recordingId) handler(detail.offsetMs);
    };
    window.addEventListener(SEEK_EVENT, listener);
    return () => window.removeEventListener(SEEK_EVENT, listener);
}
