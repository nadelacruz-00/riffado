import { AppError, ErrorCode } from "@/lib/errors";
import { enforceStorageCap } from "@/lib/hosted/billing/storage-cap";
import type { PlaudClient } from "@/lib/plaud/client";
import { fetchUrlWithLimit, RemoteDownloadError } from "@/lib/plaud/fetch";
import {
    imageStorageKey,
    listImagesToDownload,
    markImageFailed,
    markImagePending,
    markImageReady,
    markImagesChecked,
    resetFailedImages,
    sniffImage,
    upsertListedImages,
} from "@/lib/recordings/images";
import type { StorageProvider } from "@/lib/storage/types";

/** Per-sync limits for the photo pass (Eng review R10, R17). */
export const PHOTO_LIMITS = {
    recordingsPerRun: 25,
    bytesPerRun: 200 * 1024 * 1024,
    msPerRun: 5 * 60 * 1000,
    bytesPerPhoto: 25 * 1024 * 1024,
} as const;

/** A recording whose Plaud Highlight photos need listing or (re)downloading. */
export interface PhotoCandidate {
    recordingId: string;
    plaudFileId: string;
    startTimeMs: number;
    plaudVersion: string;
    imagesCheckedVersion: string | null;
}

/**
 * Whether a synced recording has a photo gap: only for Plaud 4.0 recordings
 * that are not trashed or local, when photos were never listed at this
 * Plaud version or a photo still waits for a (re)download. Independent of
 * the transcript/summary flags, which v4 listings always report as false.
 */
export function needsPhotoImport(input: {
    importPlaudContent: boolean;
    usingPlaudV4: boolean;
    isTrash: boolean;
    deviceSn: string;
    plaudVersion: string;
    imagesCheckedVersion: string | null;
    hasRetryableImages: boolean;
}): boolean {
    if (!input.importPlaudContent || !input.usingPlaudV4) return false;
    if (input.isTrash || input.deviceSn === "local") return false;
    return (
        input.imagesCheckedVersion !== input.plaudVersion ||
        input.hasRetryableImages
    );
}

class CapTracker {
    private base?: { currentBytes: number; limitBytes: number | null };
    private added = 0;

    constructor(private readonly userId: string) {}

    async allows(additionalBytes: number): Promise<boolean> {
        if (this.base) {
            if (this.base.limitBytes === null) return true;
            if (
                this.base.currentBytes + this.added + additionalBytes <=
                this.base.limitBytes
            ) {
                return true;
            }
        }
        const decision = await enforceStorageCap({
            userId: this.userId,
            additionalBytes: this.added + additionalBytes,
        });
        this.base = {
            currentBytes: decision.currentBytes,
            limitBytes: decision.limitBytes,
        };
        this.added = 0;
        return decision.allowed;
    }

    commit(bytes: number): void {
        this.added += bytes;
    }
}

function downloadErrorCode(error: unknown): string {
    if (error instanceof RemoteDownloadError) {
        return error.reason === "too_large"
            ? "too_large"
            : `http_${error.status ?? 0}`;
    }
    return "download_error";
}

/**
 * Import Plaud Highlight photos for the given candidates, sequentially and
 * after all recording rows are committed. Never throws for a single photo;
 * a dead Plaud token stops the pass and is reported in `errors`. Handles at
 * most `PHOTO_LIMITS.recordingsPerRun` recordings and stops downloading once
 * the byte or time budget, or the user's storage cap, is reached; unfinished
 * photos stay `pending` for the next sync.
 */
export async function importRecordingPhotos(
    candidates: PhotoCandidate[],
    deps: {
        userId: string;
        plaudClient: Pick<PlaudClient, "listRecordingImages">;
        storage: Pick<StorageProvider, "uploadFile" | "deleteFile">;
        storageType: string;
        errors: string[];
        now?: () => number;
    },
): Promise<void> {
    const now = deps.now ?? Date.now;
    const startedAt = now();
    const cap = new CapTracker(deps.userId);
    let bytesDownloaded = 0;
    let stopDownloads = false;

    for (const candidate of candidates.slice(
        0,
        PHOTO_LIMITS.recordingsPerRun,
    )) {
        let images: Awaited<ReturnType<PlaudClient["listRecordingImages"]>>;
        try {
            images = await deps.plaudClient.listRecordingImages(
                candidate.plaudFileId,
            );
        } catch (error) {
            if (
                error instanceof AppError &&
                error.code === ErrorCode.PLAUD_INVALID_TOKEN
            ) {
                deps.errors.push(
                    "Plaud photo import stopped: access token expired",
                );
                return;
            }
            deps.errors.push(
                `Plaud photo import failed for ${candidate.plaudFileId}: ${error}`,
            );
            continue;
        }

        if (
            candidate.imagesCheckedVersion !== null &&
            candidate.imagesCheckedVersion !== candidate.plaudVersion
        ) {
            await resetFailedImages(deps.userId, candidate.recordingId);
        }
        await upsertListedImages(
            deps.userId,
            candidate.recordingId,
            deps.storageType,
            images.map((i) => ({
                plaudImageId: i.plaudImageId,
                offsetMs: i.offsetMs,
                capturedAt:
                    i.offsetMs === null
                        ? null
                        : new Date(candidate.startTimeMs + i.offsetMs),
            })),
        );
        await markImagesChecked(
            deps.userId,
            candidate.recordingId,
            candidate.plaudVersion,
        );

        if (stopDownloads) continue;
        const urls = new Map(images.map((i) => [i.plaudImageId, i.url]));
        const rows = await listImagesToDownload(
            deps.userId,
            candidate.recordingId,
        );

        for (const row of rows) {
            if (
                bytesDownloaded >= PHOTO_LIMITS.bytesPerRun ||
                now() - startedAt >= PHOTO_LIMITS.msPerRun
            ) {
                stopDownloads = true;
                break;
            }
            const url = urls.get(row.plaudImageId);
            if (!url) {
                await markImageFailed(row.id, "no_url");
                continue;
            }
            if (!(await cap.allows(0))) {
                await markImagePending(row.id, "storage_cap");
                stopDownloads = true;
                break;
            }

            let buffer: Buffer;
            try {
                ({ buffer } = await fetchUrlWithLimit(
                    url,
                    PHOTO_LIMITS.bytesPerPhoto,
                ));
            } catch (error) {
                await markImageFailed(row.id, downloadErrorCode(error));
                continue;
            }
            bytesDownloaded += buffer.length;

            const kind = sniffImage(buffer);
            if (!kind) {
                await markImageFailed(row.id, "unsupported_type");
                continue;
            }
            if (!(await cap.allows(buffer.length))) {
                await markImagePending(row.id, "storage_cap");
                stopDownloads = true;
                break;
            }

            const key = imageStorageKey(
                deps.userId,
                candidate.recordingId,
                row.plaudImageId,
                kind.ext,
            );
            try {
                await deps.storage.uploadFile(key, buffer, kind.mimeType);
            } catch {
                await markImageFailed(row.id, "upload_error");
                continue;
            }

            const stored = await markImageReady(
                deps.userId,
                candidate.recordingId,
                row.id,
                {
                    storagePath: key,
                    mimeType: kind.mimeType,
                    sizeBytes: buffer.length,
                },
            );
            if (!stored) {
                await deps.storage.deleteFile(key).catch(() => undefined);
                break;
            }
            cap.commit(buffer.length);
        }
    }
}
