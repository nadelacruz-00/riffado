import { and, asc, eq, isNull, lt, ne, or, type SQL, sql } from "drizzle-orm";
import { db } from "@/db";
import { recordingImages, recordings } from "@/db/schema";
import { IMAGE_EXTENSIONS, type ImageExtension } from "./images-shared";

export { formatImageOffset, imageExportName } from "./image-format";
export { IMAGE_EXTENSIONS, type ImageExtension };

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
type Executor = typeof db | Tx;

export type RecordingImageStatus = "pending" | "ready" | "failed";

/** A `failed` photo is retried while its attempts stay below this. */
export const IMAGE_MAX_ATTEMPTS = 5;

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

/** Stored photo paths of one recording, for deleting its files. */
export async function listImageStoragePathsForRecording(
    userId: string,
    recordingId: string,
    exec: Executor = db,
): Promise<string[]> {
    const rows = await exec
        .select({ storagePath: recordingImages.storagePath })
        .from(recordingImages)
        .where(
            and(
                eq(recordingImages.userId, userId),
                eq(recordingImages.recordingId, recordingId),
            ),
        );
    return rows.flatMap((r) => (r.storagePath ? [r.storagePath] : []));
}

/**
 * SQL subquery `(user_id, bytes)`: bytes of ready photos on live
 * (non-tombstoned) recordings, per user. Every storage total that counts
 * audio bytes adds this, so enforcement and admin totals stay equal.
 */
export function liveImageBytesByUser(): SQL {
    return sql`(
    select ri.user_id, sum(ri.size_bytes)::bigint as bytes
    from ${recordingImages} ri
    join ${recordings} rr on rr.id = ri.recording_id
    where ri.status = 'ready' and rr.deleted_at is null
    group by ri.user_id
)`;
}

/** Query for one user's ready photo bytes on live recordings. */
export function userImageBytesQuery(exec: Executor, userId: string) {
    return exec
        .select({
            total: sql<string | null>`sum(${recordingImages.sizeBytes})`,
        })
        .from(recordingImages)
        .innerJoin(recordings, eq(recordings.id, recordingImages.recordingId))
        .where(
            and(
                eq(recordingImages.userId, userId),
                eq(recordingImages.status, "ready"),
                isNull(recordings.deletedAt),
            ),
        );
}

/** One user's ready photo bytes on live recordings; 0 when none. */
export async function getUserImageBytes(
    userId: string,
    exec: Executor = db,
): Promise<number> {
    const [row] = await userImageBytesQuery(exec, userId);
    const parsed = Number(row?.total ?? 0);
    return Number.isFinite(parsed) ? parsed : 0;
}

/** Query for all of a user's ready photos on live recordings, grouped by recording in display order. */
export function readyImagesByUserQuery(exec: Executor, userId: string) {
    return exec
        .select({
            recordingId: recordingImages.recordingId,
            plaudImageId: recordingImages.plaudImageId,
            storagePath: recordingImages.storagePath,
            mimeType: recordingImages.mimeType,
            capturedAt: recordingImages.capturedAt,
            offsetMs: recordingImages.offsetMs,
        })
        .from(recordingImages)
        .innerJoin(recordings, eq(recordings.id, recordingImages.recordingId))
        .where(
            and(
                eq(recordingImages.userId, userId),
                eq(recordingImages.status, "ready"),
                eq(recordings.userId, userId),
                isNull(recordings.deletedAt),
            ),
        )
        .orderBy(
            asc(recordingImages.recordingId),
            sql`${recordingImages.offsetMs} asc nulls last`,
            asc(recordingImages.plaudImageId),
        );
}

/** A user's ready photos keyed by recording id, each list in display order. */
export async function listReadyImagesByRecording(
    userId: string,
    exec: Executor = db,
): Promise<Map<string, Awaited<ReturnType<typeof readyImagesByUserQuery>>>> {
    const rows = await readyImagesByUserQuery(exec, userId);
    const byRecording = new Map<string, typeof rows>();
    for (const row of rows) {
        const list = byRecording.get(row.recordingId) ?? [];
        list.push(row);
        byRecording.set(row.recordingId, list);
    }
    return byRecording;
}

/** Extension of a stored photo path, if it is one of IMAGE_EXTENSIONS. */
export function imageExtensionOf(
    storagePath: string | null,
): ImageExtension | null {
    const ext = storagePath?.match(/\.([a-z0-9]+)$/i)?.[1]?.toLowerCase();
    return ext && (IMAGE_EXTENSIONS as readonly string[]).includes(ext)
        ? (ext as ImageExtension)
        : null;
}

/** One ready photo of a live recording owned by the user, or null. */
export async function getReadyImage(
    userId: string,
    recordingId: string,
    imageId: string,
    exec: Executor = db,
): Promise<{
    storageType: string;
    storagePath: string;
    mimeType: string;
} | null> {
    const [row] = await exec
        .select({
            storageType: recordingImages.storageType,
            storagePath: recordingImages.storagePath,
            mimeType: recordingImages.mimeType,
        })
        .from(recordingImages)
        .innerJoin(recordings, eq(recordings.id, recordingImages.recordingId))
        .where(
            and(
                eq(recordingImages.id, imageId),
                eq(recordingImages.recordingId, recordingId),
                eq(recordingImages.userId, userId),
                eq(recordingImages.status, "ready"),
                eq(recordings.userId, userId),
                isNull(recordings.deletedAt),
            ),
        )
        .limit(1);
    if (!row?.storagePath || !row.mimeType) return null;
    return {
        storageType: row.storageType,
        storagePath: row.storagePath,
        mimeType: row.mimeType,
    };
}

/** Number of photo rows (any status) per recording of the user. */
export async function countImagesByRecording(
    userId: string,
    exec: Executor = db,
): Promise<Map<string, number>> {
    const rows = await exec
        .select({
            recordingId: recordingImages.recordingId,
            n: sql<number>`count(*)::int`,
        })
        .from(recordingImages)
        .where(eq(recordingImages.userId, userId))
        .groupBy(recordingImages.recordingId);
    return new Map(rows.map((r) => [r.recordingId, Number(r.n)]));
}

/**
 * Non-ready photos of one recording, by what the page tells the user:
 * still syncing (pending or retryable failed), waiting for storage space,
 * or failed for good (5 attempts or unsupported type).
 */
export async function imageStatusCounts(
    userId: string,
    recordingId: string,
    exec: Executor = db,
): Promise<{ syncing: number; storageCap: number; failed: number }> {
    const rows = await exec
        .select({
            status: recordingImages.status,
            lastError: recordingImages.lastError,
            attempts: recordingImages.attempts,
        })
        .from(recordingImages)
        .where(
            and(
                eq(recordingImages.userId, userId),
                eq(recordingImages.recordingId, recordingId),
                ne(recordingImages.status, "ready"),
            ),
        );
    const counts = { syncing: 0, storageCap: 0, failed: 0 };
    for (const r of rows) {
        if (r.status === "pending" && r.lastError === "storage_cap") {
            counts.storageCap++;
        } else if (
            r.status === "failed" &&
            (r.attempts >= IMAGE_MAX_ATTEMPTS ||
                r.lastError === "unsupported_type")
        ) {
            counts.failed++;
        } else {
            counts.syncing++;
        }
    }
    return counts;
}
