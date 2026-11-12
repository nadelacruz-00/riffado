import { NextResponse } from "next/server";
import { createUserStorageProvider } from "@/lib/storage/factory";

/**
 * HTTP response for a stored photo: a short-lived signed redirect for S3,
 * otherwise the bytes with the stored content type. Never sniffed by the
 * browser and cached privately only.
 */
export async function imageFileResponse(
    userId: string,
    image: { storageType: string; storagePath: string; mimeType: string },
): Promise<Response> {
    const storage = await createUserStorageProvider(userId);
    if (image.storageType === "s3") {
        return NextResponse.redirect(
            await storage.getSignedUrl(image.storagePath, 300),
            302,
        );
    }
    const buffer = await storage.downloadFile(image.storagePath);
    return new NextResponse(new Uint8Array(buffer), {
        headers: {
            "Content-Type": image.mimeType,
            "Content-Length": buffer.length.toString(),
            "Cache-Control": "private, max-age=3600",
            "X-Content-Type-Options": "nosniff",
        },
    });
}
