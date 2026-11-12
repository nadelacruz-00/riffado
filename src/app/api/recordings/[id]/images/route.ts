import { and, eq, isNull } from "drizzle-orm";
import { NextResponse } from "next/server";
import { db } from "@/db";
import { recordings, userSettings } from "@/db/schema";
import { requireApiSession } from "@/lib/auth-server";
import { AppError, apiHandler, ErrorCode } from "@/lib/errors";
import { imageStatusCounts, listReadyImages } from "@/lib/recordings/images";

type IdContext = { params: Promise<{ id: string }> };

/** Ready Plaud photos of a recording plus counts of the ones not ready yet (#331). */
export const GET = apiHandler<IdContext>(async (request, context) => {
    const session = await requireApiSession(request);
    const userId = session.user.id;
    const { id } = await (context as IdContext).params;

    const [recording] = await db
        .select({ id: recordings.id })
        .from(recordings)
        .where(
            and(
                eq(recordings.id, id),
                eq(recordings.userId, userId),
                isNull(recordings.deletedAt),
            ),
        )
        .limit(1);
    if (!recording) {
        throw new AppError(
            ErrorCode.RECORDING_NOT_FOUND,
            "Recording not found",
            404,
        );
    }

    const [images, counts, [settings]] = await Promise.all([
        listReadyImages(userId, id),
        imageStatusCounts(userId, id),
        db
            .select({ importPlaudContent: userSettings.importPlaudContent })
            .from(userSettings)
            .where(eq(userSettings.userId, userId))
            .limit(1),
    ]);

    return NextResponse.json({
        images: images.map((image) => ({
            id: image.id,
            url: `/api/recordings/${id}/images/${image.id}`,
            mimeType: image.mimeType,
            offsetMs: image.offsetMs,
            capturedAt: image.capturedAt?.toISOString() ?? null,
        })),
        notReady: counts,
        importPlaudContent: settings?.importPlaudContent ?? false,
    });
});
