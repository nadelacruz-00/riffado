import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
    db: { select: vi.fn(), transaction: vi.fn() },
    deleteFile: vi.fn(),
    listImageStoragePathsForRecording: vi.fn(),
    deleteImagesForRecording: vi.fn(),
    emitEvent: vi.fn(),
}));

vi.mock("@/db", () => ({ db: m.db }));
vi.mock("@/lib/env", () => ({ env: {} }));
vi.mock("@/lib/auth-server", () => ({
    requireApiSession: vi.fn().mockResolvedValue({ user: { id: "u1" } }),
}));
vi.mock("@/lib/storage/factory", () => ({
    createUserStorageProvider: vi.fn(async () => ({
        deleteFile: m.deleteFile,
    })),
}));
vi.mock("@/lib/recordings/images", () => ({
    listImageStoragePathsForRecording: m.listImageStoragePathsForRecording,
    deleteImagesForRecording: m.deleteImagesForRecording,
}));
vi.mock("@/lib/webhooks/emit", () => ({ emitEvent: m.emitEvent }));
vi.mock("@/lib/webhooks/payload", () => ({
    createRedactedWebhookPayload: vi.fn(() => ({})),
}));

import { DELETE } from "@/app/api/recordings/[id]/route";

const params = Promise.resolve({ id: "rec1" });
const request = () =>
    new Request("http://localhost/api/recordings/rec1", { method: "DELETE" });

function stubLookup() {
    m.db.select.mockReturnValueOnce({
        from: () => ({
            where: () => ({
                limit: async () => [
                    { id: "rec1", userId: "u1", storagePath: "u1/f.mp3" },
                ],
            }),
        }),
    });
}

function stubTransaction() {
    const tx = {
        select: () => ({
            from: () => ({
                where: () => ({
                    for: () => ({ limit: async () => [{ deletedAt: null }] }),
                }),
            }),
        }),
        delete: () => ({ where: async () => undefined }),
        update: () => ({
            set: () => ({
                where: () =>
                    Object.assign(Promise.resolve(undefined), {
                        returning: async () => [{ id: "rec1" }],
                    }),
            }),
        }),
    };
    m.db.transaction.mockImplementation(async (cb: (t: unknown) => unknown) =>
        cb(tx),
    );
    return tx;
}

beforeEach(() => {
    vi.clearAllMocks();
    m.deleteFile.mockResolvedValue(undefined);
    m.deleteImagesForRecording.mockResolvedValue([]);
});

describe("DELETE /api/recordings/[id] with photos", () => {
    it("deletes photo files before the transaction and photo rows inside it", async () => {
        stubLookup();
        const tx = stubTransaction();
        m.listImageStoragePathsForRecording.mockResolvedValue([
            "u1/images/rec1/c_a.jpg",
        ]);
        m.deleteImagesForRecording.mockResolvedValue([
            "u1/images/rec1/c_a.jpg",
        ]);

        const res = await DELETE(request(), { params });

        expect(res.status).toBe(200);
        expect(m.deleteFile.mock.calls.map((c) => c[0])).toEqual([
            "u1/f.mp3",
            "u1/images/rec1/c_a.jpg",
        ]);
        expect(m.deleteFile.mock.invocationCallOrder[1]).toBeLessThan(
            m.db.transaction.mock.invocationCallOrder[0],
        );
        expect(m.deleteImagesForRecording).toHaveBeenCalledWith(
            tx,
            "u1",
            "rec1",
        );
    });

    it("refuses to tombstone when a photo file cannot be deleted", async () => {
        stubLookup();
        stubTransaction();
        m.listImageStoragePathsForRecording.mockResolvedValue([
            "u1/images/rec1/c_a.jpg",
        ]);
        m.deleteFile
            .mockResolvedValueOnce(undefined)
            .mockRejectedValueOnce(new Error("S3 internal error 503"));

        const res = await DELETE(request(), { params });

        expect(res.status).toBe(500);
        expect(m.db.transaction).not.toHaveBeenCalled();
    });

    it("treats an already missing photo file as deleted", async () => {
        stubLookup();
        stubTransaction();
        m.listImageStoragePathsForRecording.mockResolvedValue([
            "u1/images/rec1/c_a.jpg",
        ]);
        m.deleteFile
            .mockResolvedValueOnce(undefined)
            .mockRejectedValueOnce(
                Object.assign(new Error("gone"), { code: "ENOENT" }),
            );

        const res = await DELETE(request(), { params });

        expect(res.status).toBe(200);
        expect(m.db.transaction).toHaveBeenCalledTimes(1);
    });

    it("deletes files of photos that appeared between the file deletion and the lock", async () => {
        stubLookup();
        stubTransaction();
        m.listImageStoragePathsForRecording.mockResolvedValue([]);
        m.deleteImagesForRecording.mockResolvedValue([
            "u1/images/rec1/c_late.jpg",
        ]);

        const res = await DELETE(request(), { params });

        expect(res.status).toBe(200);
        expect(m.deleteFile.mock.calls.map((c) => c[0])).toEqual([
            "u1/f.mp3",
            "u1/images/rec1/c_late.jpg",
        ]);
        expect(m.deleteFile.mock.invocationCallOrder[1]).toBeGreaterThan(
            m.db.transaction.mock.invocationCallOrder[0],
        );
    });
});
