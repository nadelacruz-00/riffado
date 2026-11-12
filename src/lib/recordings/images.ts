import { and, asc, eq, isNull, sql } from "drizzle-orm";
import { db } from "@/db";
import { recordingImages, recordings } from "@/db/schema";

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
type Executor = typeof db | Tx;

export type RecordingImageStatus = "pending" | "ready" | "failed";

/** A `failed` photo is retried while its attempts stay below this. */
export const IMAGE_MAX_ATTEMPTS = 5;

/** File extensions a stored photo may have (from sniffed magic bytes). */
export const IMAGE_EXTENSIONS = ["jpg", "png", "webp", "heic"] as const;
export type ImageExtension = (typeof IMAGE_EXTENSIONS)[number];

const SAFE_ID = /^[A-Za-z0-9_-]{1,128}$/;

/**
 * Storage key for a photo: `${userId}/images/${recordingId}/${plaudImageId}.${ext}`.
 * Keyed by the recording id because audio keys can be shared between rows.
 * Throws when any part could escape its path segment.
 */
export function imageStorageKey(
    userId: string,
    recordingId: string,
    plaudImageId: string,
    ext: ImageExtension,
): string {
    for (const part of [userId, recordingId, plaudImageId]) {
        if (!SAFE_ID.test(part)) {
            throw new Error("Unsafe photo storage key segment");
        }
    }
    if (!IMAGE_EXTENSIONS.includes(ext)) {
        throw new Error("Unsupported photo extension");
    }
    return `${userId}/images/${recordingId}/${plaudImageId}.${ext}`;
}

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

/** Query for one recording's ready photos, oldest offset first, owner and live recording only. */
export function readyImagesQuery(
    exec: Executor,
    userId: string,
    recordingId: string,
) {
    return exec
        .select({
            id: recordingImages.id,
            plaudImageId: recordingImages.plaudImageId,
            storageType: recordingImages.storageType,
            storagePath: recordingImages.storagePath,
            mimeType: recordingImages.mimeType,
            sizeBytes: recordingImages.sizeBytes,
            capturedAt: recordingImages.capturedAt,
            offsetMs: recordingImages.offsetMs,
        })
        .from(recordingImages)
        .innerJoin(recordings, eq(recordings.id, recordingImages.recordingId))
        .where(
            and(
                eq(recordingImages.userId, userId),
                eq(recordingImages.recordingId, recordingId),
                eq(recordingImages.status, "ready"),
                eq(recordings.userId, userId),
                isNull(recordings.deletedAt),
            ),
        )
        .orderBy(
            sql`${recordingImages.offsetMs} asc nulls last`,
            asc(recordingImages.plaudImageId),
        );
}

export type ReadyImage = Awaited<ReturnType<typeof readyImagesQuery>>[number];

/** A recording's ready photos in display and export order. */
export async function listReadyImages(
    userId: string,
    recordingId: string,
    exec: Executor = db,
): Promise<ReadyImage[]> {
    return readyImagesQuery(exec, userId, recordingId);
}

/**
 * Delete a recording's photo rows inside the caller's transaction and
 * return the storage paths they held, so the caller can remove files.
 */
export async function deleteImagesForRecording(
    tx: Tx,
    userId: string,
    recordingId: string,
): Promise<string[]> {
    const rows = await tx
        .delete(recordingImages)
        .where(
            and(
                eq(recordingImages.userId, userId),
                eq(recordingImages.recordingId, recordingId),
            ),
        )
        .returning({ storagePath: recordingImages.storagePath });
    return rows.flatMap((r) => (r.storagePath ? [r.storagePath] : []));
}

/** Every stored photo path of a user, for account deletion. */
export async function listImageStoragePaths(
    userId: string,
    exec: Executor = db,
): Promise<string[]> {
    const rows = await exec
        .select({ storagePath: recordingImages.storagePath })
        .from(recordingImages)
        .where(eq(recordingImages.userId, userId));
    return rows.flatMap((r) => (r.storagePath ? [r.storagePath] : []));
}
