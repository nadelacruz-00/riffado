import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
    authenticateRequest: vi.fn(),
    ipLimit: vi.fn(),
    authLimit: vi.fn(),
    getReadyImage: vi.fn(),
    storage: {
        downloadFile: vi.fn(),
        getSignedUrl: vi.fn(),
    },
}));

vi.mock("@/db", () => ({ db: {} }));
vi.mock("@/lib/env", () => ({ env: {} }));
vi.mock("@/lib/auth-request", () => ({
    authenticateRequest: m.authenticateRequest,
}));
vi.mock("@/lib/v1/rate-limit", () => ({
    enforceV1IpRateLimit: m.ipLimit,
    enforceV1AuthenticatedRateLimit: m.authLimit,
}));
vi.mock("@/lib/recordings/images", async (orig) => ({
    ...(await orig<typeof import("@/lib/recordings/images")>()),
    getReadyImage: m.getReadyImage,
}));
vi.mock("@/lib/storage/factory", () => ({
    createUserStorageProvider: vi.fn(async () => m.storage),
}));
vi.mock("@/lib/encryption/fields", () => ({
    decryptText: (v: string) => v,
    decryptJsonField: (v: unknown) => v,
}));

import { GET } from "@/app/api/v1/recordings/[id]/images/[imageId]/route";
import { serializeRecordingDetail } from "@/lib/v1/serialize";

const params = Promise.resolve({ id: "rec1", imageId: "img1" });
const call = () =>
    GET(new Request("http://localhost/api/v1/recordings/rec1/images/img1"), {
        params,
    });

beforeEach(() => {
    vi.clearAllMocks();
    m.ipLimit.mockResolvedValue(null);
    m.authLimit.mockResolvedValue(null);
    m.authenticateRequest.mockResolvedValue({ user: { id: "u1" } });
});

describe("GET /api/v1/recordings/[id]/images/[imageId]", () => {
    it("returns 401 without a valid API key", async () => {
        m.authenticateRequest.mockResolvedValue(null);
        expect((await call()).status).toBe(401);
        expect(m.getReadyImage).not.toHaveBeenCalled();
    });

    it("returns 404 for a photo the key's user does not own (or a deleted recording)", async () => {
        m.getReadyImage.mockResolvedValue(null);
        const res = await call();
        expect(res.status).toBe(404);
        expect(m.getReadyImage).toHaveBeenCalledWith("u1", "rec1", "img1");
    });

    it("streams a local photo with its stored type, not sniffable", async () => {
        m.getReadyImage.mockResolvedValue({
            storageType: "local",
            storagePath: "u1/images/rec1/c_a.jpg",
            mimeType: "image/jpeg",
        });
        m.storage.downloadFile.mockResolvedValue(
            Buffer.from([0xff, 0xd8, 0xff]),
        );
        const res = await call();
        expect(res.status).toBe(200);
        expect(res.headers.get("content-type")).toBe("image/jpeg");
        expect(res.headers.get("x-content-type-options")).toBe("nosniff");
        expect(res.headers.get("cache-control")).toBe("private, max-age=3600");
        expect(Buffer.from(await res.arrayBuffer())).toEqual(
            Buffer.from([0xff, 0xd8, 0xff]),
        );
    });

    it("redirects to a short-lived signed URL for S3 storage", async () => {
        m.getReadyImage.mockResolvedValue({
            storageType: "s3",
            storagePath: "u1/images/rec1/c_a.jpg",
            mimeType: "image/jpeg",
        });
        m.storage.getSignedUrl.mockResolvedValue(
            "https://bucket.example/signed",
        );
        const res = await call();
        expect(res.status).toBe(302);
        expect(res.headers.get("location")).toBe(
            "https://bucket.example/signed",
        );
        expect(m.storage.getSignedUrl).toHaveBeenCalledWith(
            "u1/images/rec1/c_a.jpg",
            300,
        );
    });

    it("returns the rate-limit response before doing any work", async () => {
        m.authLimit.mockResolvedValue(
            new Response("slow down", { status: 429 }),
        );
        expect((await call()).status).toBe(429);
        expect(m.getReadyImage).not.toHaveBeenCalled();
    });
});

describe("v1 recording detail images", () => {
    const now = new Date("2026-05-06T12:00:00.000Z");
    const recording = {
        id: "rec1",
        userId: "u1",
        deviceSn: "SN",
        plaudFileId: "p1",
        filename: "Lecture",
        duration: 1000,
        startTime: now,
        endTime: now,
        filesize: 1,
        fileMd5: "x",
        storageType: "local",
        storagePath: "u1/f.mp3",
        downloadedAt: now,
        plaudVersion: "1",
        timezone: null,
        zonemins: null,
        scene: null,
        isTrash: false,
        waveformPeaks: null,
        deletedAt: null,
        imagesCheckedVersion: "1",
        createdAt: now,
        updatedAt: now,
    };

    it("lists ready photos with API URLs and keeps the other fields", () => {
        const detail = serializeRecordingDetail(
            recording,
            null,
            [],
            null,
            "plaud",
            [
                {
                    id: "img1",
                    plaudImageId: "c_a",
                    storageType: "local",
                    storagePath: "u1/images/rec1/c_a.jpg",
                    mimeType: "image/jpeg",
                    sizeBytes: 42,
                    capturedAt: new Date("2026-05-06T12:01:45.000Z"),
                    offsetMs: 105_000,
                },
            ],
        );
        expect(detail.images).toEqual([
            {
                id: "img1",
                mime_type: "image/jpeg",
                size_bytes: 42,
                captured_at: "2026-05-06T12:01:45.000Z",
                offset_ms: 105_000,
                url: "/api/v1/recordings/rec1/images/img1",
            },
        ]);
        expect(detail.links.audio).toBe("/api/v1/recordings/rec1/audio");
        expect(detail).not.toHaveProperty("images.0.storage_path");
    });

    it("defaults to an empty list", () => {
        expect(
            serializeRecordingDetail(recording, null, [], null).images,
        ).toEqual([]);
    });
});
