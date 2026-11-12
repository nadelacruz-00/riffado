import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
    select: vi.fn(),
    listReadyImages: vi.fn(),
    imageStatusCounts: vi.fn(),
    getReadyImage: vi.fn(),
    requireApiSession: vi.fn(),
    downloadFile: vi.fn(),
}));

vi.mock("@/db", () => ({ db: { select: m.select } }));
vi.mock("@/lib/env", () => ({ env: {} }));
vi.mock("@/lib/auth-server", () => ({
    requireApiSession: m.requireApiSession,
}));
vi.mock("@/lib/recordings/images", () => ({
    listReadyImages: m.listReadyImages,
    imageStatusCounts: m.imageStatusCounts,
    getReadyImage: m.getReadyImage,
}));
vi.mock("@/lib/storage/factory", () => ({
    createUserStorageProvider: vi.fn(async () => ({
        downloadFile: m.downloadFile,
    })),
}));

import { GET as getImage } from "@/app/api/recordings/[id]/images/[imageId]/route";
import { GET as listImages } from "@/app/api/recordings/[id]/images/route";
import { AppError, ErrorCode } from "@/lib/errors";

function selectReturns(...results: unknown[][]) {
    for (const rows of results) {
        m.select.mockReturnValueOnce({
            from: () => ({ where: () => ({ limit: async () => rows }) }),
        });
    }
}

const req = (path: string) => new Request(`http://localhost${path}`);

beforeEach(() => {
    vi.clearAllMocks();
    m.requireApiSession.mockResolvedValue({ user: { id: "u1" } });
});

describe("GET /api/recordings/[id]/images", () => {
    it("returns ready photos, not-ready counts and the import setting", async () => {
        selectReturns([{ id: "rec1" }], [{ importPlaudContent: true }]);
        m.listReadyImages.mockResolvedValue([
            {
                id: "img_a",
                mimeType: "image/jpeg",
                offsetMs: 105_920,
                capturedAt: new Date("2026-11-10T05:37:09.000Z"),
            },
        ]);
        m.imageStatusCounts.mockResolvedValue({
            syncing: 1,
            storageCap: 0,
            failed: 0,
        });

        const res = await listImages(req("/api/recordings/rec1/images"), {
            params: Promise.resolve({ id: "rec1" }),
        });

        expect(res.status).toBe(200);
        expect(await res.json()).toEqual({
            images: [
                {
                    id: "img_a",
                    url: "/api/recordings/rec1/images/img_a",
                    mimeType: "image/jpeg",
                    offsetMs: 105_920,
                    capturedAt: "2026-11-10T05:37:09.000Z",
                },
            ],
            notReady: { syncing: 1, storageCap: 0, failed: 0 },
            importPlaudContent: true,
        });
        expect(m.listReadyImages).toHaveBeenCalledWith("u1", "rec1");
    });

    it("returns 404 for another user's or a deleted recording", async () => {
        selectReturns([]);
        const res = await listImages(req("/api/recordings/rec1/images"), {
            params: Promise.resolve({ id: "rec1" }),
        });
        expect(res.status).toBe(404);
        expect(m.listReadyImages).not.toHaveBeenCalled();
    });

    it("requires a session", async () => {
        m.requireApiSession.mockRejectedValue(
            new AppError(ErrorCode.AUTH_SESSION_MISSING, "Unauthorized", 401),
        );
        const res = await listImages(req("/api/recordings/rec1/images"), {
            params: Promise.resolve({ id: "rec1" }),
        });
        expect(res.status).toBe(401);
    });
});

describe("GET /api/recordings/[id]/images/[imageId]", () => {
    const params = Promise.resolve({ id: "rec1", imageId: "img_a" });

    it("streams the signed-in user's photo", async () => {
        m.getReadyImage.mockResolvedValue({
            storageType: "local",
            storagePath: "u1/images/rec1/c_a.png",
            mimeType: "image/png",
        });
        m.downloadFile.mockResolvedValue(Buffer.from("png"));
        const res = await getImage(req("/api/recordings/rec1/images/img_a"), {
            params,
        });
        expect(res.status).toBe(200);
        expect(res.headers.get("content-type")).toBe("image/png");
        expect(m.getReadyImage).toHaveBeenCalledWith("u1", "rec1", "img_a");
    });

    it("returns 404 when the photo is not the user's or not ready", async () => {
        m.getReadyImage.mockResolvedValue(null);
        const res = await getImage(req("/api/recordings/rec1/images/img_a"), {
            params,
        });
        expect(res.status).toBe(404);
        expect(m.downloadFile).not.toHaveBeenCalled();
    });
});
