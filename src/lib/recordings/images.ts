import { and, asc, eq, isNull, lt, ne, or, type SQL, sql } from "drizzle-orm";
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

/** Image type from magic bytes: JPEG, PNG, WebP or HEIC/HEIF; null for anything else. */
export function sniffImage(
    buffer: Buffer,
): { ext: ImageExtension; mimeType: string } | null {
    if (
        buffer.length >= 3 &&
        buffer[0] === 0xff &&
        buffer[1] === 0xd8 &&
        buffer[2] === 0xff
    ) {
        return { ext: "jpg", mimeType: "image/jpeg" };
    }
    if (
        buffer.length >= 8 &&
        buffer
            .subarray(0, 8)
            .equals(
                Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
            )
    ) {
        return { ext: "png", mimeType: "image/png" };
    }
    if (
        buffer.length >= 12 &&
        buffer.toString("ascii", 0, 4) === "RIFF" &&
        buffer.toString("ascii", 8, 12) === "WEBP"
    ) {
        return { ext: "webp", mimeType: "image/webp" };
    }
    if (buffer.length >= 12 && buffer.toString("ascii", 4, 8) === "ftyp") {
        const brand = buffer.toString("ascii", 8, 12);
        if (
            [
                "heic",
                "heix",
                "heim",
                "heis",
                "hevc",
                "hevx",
                "mif1",
                "msf1",
            ].includes(brand)
        ) {
            return { ext: "heic", mimeType: "image/heic" };
        }
    }
    return null;
}

/**
 * Rows the photo import should (re)download: `pending`, or `failed` with
 * attempts left and an error other than `unsupported_type`.
 */
export function retryableImageCondition(): SQL {
    return or(
        eq(recordingImages.status, "pending"),
        and(
            eq(recordingImages.status, "failed"),
            lt(recordingImages.attempts, IMAGE_MAX_ATTEMPTS),
            or(
                isNull(recordingImages.lastError),
                ne(recordingImages.lastError, "unsupported_type"),
            ),
        ),
    ) as SQL;
}

/** Ids of the user's recordings that still hold a photo to (re)download. */
export async function listRecordingIdsWithRetryableImages(
    userId: string,
    exec: Executor = db,
): Promise<Set<string>> {
    const rows = await exec
        .selectDistinct({ recordingId: recordingImages.recordingId })
        .from(recordingImages)
        .where(
            and(eq(recordingImages.userId, userId), retryableImageCondition()),
        );
    return new Set(rows.map((r) => r.recordingId));
}

/** One recording's photos to (re)download. */
export async function listImagesToDownload(
    userId: string,
    recordingId: string,
    exec: Executor = db,
): Promise<{ id: string; plaudImageId: string }[]> {
    return exec
        .select({
            id: recordingImages.id,
            plaudImageId: recordingImages.plaudImageId,
        })
        .from(recordingImages)
        .where(
            and(
                eq(recordingImages.userId, userId),
                eq(recordingImages.recordingId, recordingId),
                retryableImageCondition(),
            ),
        )
        .orderBy(
            sql`${recordingImages.offsetMs} asc nulls last`,
            asc(recordingImages.plaudImageId),
        );
}

/** After a Plaud-side edit, give every failed photo of the recording a fresh start. */
export async function resetFailedImages(
    userId: string,
    recordingId: string,
    exec: Executor = db,
): Promise<void> {
    await exec
        .update(recordingImages)
        .set({
            status: "pending",
            attempts: 0,
            lastError: null,
            updatedAt: new Date(),
        })
        .where(
            and(
                eq(recordingImages.userId, userId),
                eq(recordingImages.recordingId, recordingId),
                eq(recordingImages.status, "failed"),
            ),
        );
}

/** Insert listed photos as `pending`; existing rows only get their offset refreshed. */
export async function upsertListedImages(
    userId: string,
    recordingId: string,
    storageType: string,
    images: {
        plaudImageId: string;
        offsetMs: number | null;
        capturedAt: Date | null;
    }[],
    exec: Executor = db,
): Promise<void> {
    if (images.length === 0) return;
    await exec
        .insert(recordingImages)
        .values(
            images.map((i) => ({
                userId,
                recordingId,
                storageType,
                plaudImageId: i.plaudImageId,
                offsetMs: i.offsetMs,
                capturedAt: i.capturedAt,
            })),
        )
        .onConflictDoUpdate({
            target: [recordingImages.recordingId, recordingImages.plaudImageId],
            set: {
                offsetMs: sql`excluded.offset_ms`,
                capturedAt: sql`excluded.captured_at`,
                updatedAt: new Date(),
            },
        });
}

/** Record the plaudVersion at which the recording's photos were listed. */
export async function markImagesChecked(
    userId: string,
    recordingId: string,
    plaudVersion: string,
    exec: Executor = db,
): Promise<void> {
    await exec
        .update(recordings)
        .set({ imagesCheckedVersion: plaudVersion })
        .where(
            and(eq(recordings.id, recordingId), eq(recordings.userId, userId)),
        );
}

/** A failed download/upload: count an attempt and keep a short error code. */
export async function markImageFailed(
    imageId: string,
    code: string,
    exec: Executor = db,
): Promise<void> {
    await exec
        .update(recordingImages)
        .set({
            status: "failed",
            attempts: sql`${recordingImages.attempts} + 1`,
            lastError: code,
            updatedAt: new Date(),
        })
        .where(eq(recordingImages.id, imageId));
}

/** Leave a photo for a later sync without counting an attempt (e.g. `storage_cap`). */
export async function markImagePending(
    imageId: string,
    code: string,
    exec: Executor = db,
): Promise<void> {
    await exec
        .update(recordingImages)
        .set({ status: "pending", lastError: code, updatedAt: new Date() })
        .where(eq(recordingImages.id, imageId));
}

/**
 * Mark a stored photo `ready` after re-checking its recording under
 * `FOR UPDATE`. Returns false, writing nothing, when the recording is gone
 * or tombstoned; the caller then deletes the uploaded file.
 */
export async function markImageReady(
    userId: string,
    recordingId: string,
    imageId: string,
    stored: { storagePath: string; mimeType: string; sizeBytes: number },
): Promise<boolean> {
    return db.transaction(async (tx) => {
        const [locked] = await tx
            .select({ deletedAt: recordings.deletedAt })
            .from(recordings)
            .where(
                and(
                    eq(recordings.id, recordingId),
                    eq(recordings.userId, userId),
                ),
            )
            .for("update")
            .limit(1);
        if (!locked || locked.deletedAt) return false;
        await tx
            .update(recordingImages)
            .set({
                status: "ready",
                storagePath: stored.storagePath,
                mimeType: stored.mimeType,
                sizeBytes: stored.sizeBytes,
                lastError: null,
                updatedAt: new Date(),
            })
            .where(
                and(
                    eq(recordingImages.id, imageId),
                    eq(recordingImages.userId, userId),
                ),
            );
        return true;
    });
}
