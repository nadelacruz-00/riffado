import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/db", () => ({ db: {} }));
vi.mock("@/lib/env", () => ({
    env: { WEBSHARE_API_KEY: undefined, PLAUD_PROXY_SCOPE: "all" },
}));

const { enforceStorageCap, fetchUrlWithLimit, rows } = vi.hoisted(() => ({
    enforceStorageCap: vi.fn(),
    fetchUrlWithLimit: vi.fn(),
    rows: {
        listImagesToDownload: vi.fn(),
        markImageFailed: vi.fn(),
        markImagePending: vi.fn(),
        markImageReady: vi.fn(),
        markImagesChecked: vi.fn(),
        resetFailedImages: vi.fn(),
        upsertListedImages: vi.fn(),
    },
}));

vi.mock("@/lib/hosted/billing/storage-cap", () => ({ enforceStorageCap }));

vi.mock("@/lib/plaud/fetch", async (orig) => ({
    ...(await orig<typeof import("@/lib/plaud/fetch")>()),
    fetchUrlWithLimit,
}));

vi.mock("@/lib/recordings/images", async (orig) => ({
    ...(await orig<typeof import("@/lib/recordings/images")>()),
    ...rows,
}));

import { AppError, ErrorCode } from "@/lib/errors";
import { RemoteDownloadError } from "@/lib/plaud/fetch";
import {
    importRecordingPhotos,
    needsPhotoImport,
    PHOTO_LIMITS,
    type PhotoCandidate,
} from "@/lib/sync/import-images";

const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4]);
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 9]);

function candidate(
    n: number,
    over: Partial<PhotoCandidate> = {},
): PhotoCandidate {
    return {
        recordingId: `rec${n}`,
        plaudFileId: `f_${n}`,
        startTimeMs: 1_000_000,
        plaudVersion: "v2",
        imagesCheckedVersion: null,
        ...over,
    };
}

function setup(
    listed: Record<
        string,
        { plaudImageId: string; url: string | null; offsetMs: number | null }[]
    >,
) {
    const plaudClient = {
        listRecordingImages: vi.fn(
            async (fileId: string) => listed[fileId] ?? [],
        ),
    };
    const storage = {
        uploadFile: vi.fn(
            async (key: string, _buffer: Buffer, _contentType: string) => key,
        ),
        deleteFile: vi.fn(async () => undefined),
    };
    const errors: string[] = [];
    return {
        plaudClient,
        storage,
        errors,
        deps: {
            userId: "u1",
            plaudClient,
            storage,
            storageType: "local",
            errors,
        },
    };
}

beforeEach(() => {
    for (const fn of Object.values(rows)) fn.mockReset();
    rows.markImageReady.mockResolvedValue(true);
    enforceStorageCap.mockReset();
    enforceStorageCap.mockResolvedValue({
        allowed: true,
        currentBytes: 0,
        limitBytes: null,
    });
    fetchUrlWithLimit.mockReset();
});

describe("needsPhotoImport", () => {
    const base = {
        importPlaudContent: true,
        usingPlaudV4: true,
        isTrash: false,
        deviceSn: "SN1",
        plaudVersion: "v2",
        imagesCheckedVersion: "v2",
        hasRetryableImages: false,
    };

    it("is true when never checked, version changed, or a photo is retryable", () => {
        expect(needsPhotoImport({ ...base, imagesCheckedVersion: null })).toBe(
            true,
        );
        expect(needsPhotoImport({ ...base, imagesCheckedVersion: "v1" })).toBe(
            true,
        );
        expect(needsPhotoImport({ ...base, hasRetryableImages: true })).toBe(
            true,
        );
        expect(needsPhotoImport(base)).toBe(false);
    });

    it("is false for import off, legacy accounts, trash and local uploads", () => {
        const gap = { ...base, imagesCheckedVersion: null };
        expect(needsPhotoImport({ ...gap, importPlaudContent: false })).toBe(
            false,
        );
        expect(needsPhotoImport({ ...gap, usingPlaudV4: false })).toBe(false);
        expect(needsPhotoImport({ ...gap, isTrash: true })).toBe(false);
        expect(needsPhotoImport({ ...gap, deviceSn: "local" })).toBe(false);
    });
});

describe("importRecordingPhotos", () => {
    it("stores each photo under the recording key and marks it ready", async () => {
        const { deps, storage } = setup({
            f_1: [
                { plaudImageId: "c_a", url: "https://s3/a", offsetMs: 105_920 },
                { plaudImageId: "c_b", url: "https://s3/b", offsetMs: 353_000 },
            ],
        });
        rows.listImagesToDownload.mockResolvedValue([
            { id: "img_a", plaudImageId: "c_a" },
            { id: "img_b", plaudImageId: "c_b" },
        ]);
        fetchUrlWithLimit
            .mockResolvedValueOnce({ buffer: JPEG })
            .mockResolvedValueOnce({ buffer: PNG });

        await importRecordingPhotos([candidate(1)], deps);

        expect(rows.upsertListedImages).toHaveBeenCalledWith(
            "u1",
            "rec1",
            "local",
            [
                {
                    plaudImageId: "c_a",
                    offsetMs: 105_920,
                    capturedAt: new Date(1_105_920),
                },
                {
                    plaudImageId: "c_b",
                    offsetMs: 353_000,
                    capturedAt: new Date(1_353_000),
                },
            ],
        );
        expect(rows.markImagesChecked).toHaveBeenCalledWith("u1", "rec1", "v2");
        expect(
            rows.upsertListedImages.mock.invocationCallOrder[0],
        ).toBeLessThan(rows.markImagesChecked.mock.invocationCallOrder[0]);
        expect(storage.uploadFile.mock.calls.map((c) => [c[0], c[2]])).toEqual([
            ["u1/images/rec1/c_a.jpg", "image/jpeg"],
            ["u1/images/rec1/c_b.png", "image/png"],
        ]);
        expect(rows.markImageReady).toHaveBeenCalledWith(
            "u1",
            "rec1",
            "img_a",
            {
                storagePath: "u1/images/rec1/c_a.jpg",
                mimeType: "image/jpeg",
                sizeBytes: JPEG.length,
            },
        );
        expect(fetchUrlWithLimit).toHaveBeenCalledWith(
            "https://s3/a",
            PHOTO_LIMITS.bytesPerPhoto,
        );
    });

    it("records download failures, bad bytes and missing URLs per photo and carries on", async () => {
        const { deps, storage } = setup({
            f_1: [
                { plaudImageId: "c_a", url: "https://s3/a", offsetMs: 1 },
                { plaudImageId: "c_b", url: "https://s3/b", offsetMs: 2 },
                { plaudImageId: "c_c", url: null, offsetMs: 3 },
                { plaudImageId: "c_d", url: "https://s3/d", offsetMs: 4 },
            ],
        });
        rows.listImagesToDownload.mockResolvedValue(
            ["a", "b", "c", "d"].map((x) => ({
                id: `img_${x}`,
                plaudImageId: `c_${x}`,
            })),
        );
        fetchUrlWithLimit
            .mockRejectedValueOnce(new RemoteDownloadError("http_error", 403))
            .mockResolvedValueOnce({ buffer: Buffer.from("<svg/>") })
            .mockResolvedValueOnce({ buffer: JPEG });

        await importRecordingPhotos([candidate(1)], deps);

        expect(rows.markImageFailed.mock.calls).toEqual([
            ["img_a", "http_403"],
            ["img_b", "unsupported_type"],
            ["img_c", "no_url"],
        ]);
        expect(storage.uploadFile).toHaveBeenCalledTimes(1);
        expect(rows.markImageReady).toHaveBeenCalledTimes(1);
    });

    it("counts an upload failure as a failed attempt", async () => {
        const { deps, storage } = setup({
            f_1: [{ plaudImageId: "c_a", url: "https://s3/a", offsetMs: 1 }],
        });
        rows.listImagesToDownload.mockResolvedValue([
            { id: "img_a", plaudImageId: "c_a" },
        ]);
        fetchUrlWithLimit.mockResolvedValue({ buffer: JPEG });
        storage.uploadFile.mockRejectedValueOnce(new Error("disk full"));

        await importRecordingPhotos([candidate(1)], deps);

        expect(rows.markImageFailed).toHaveBeenCalledWith(
            "img_a",
            "upload_error",
        );
        expect(rows.markImageReady).not.toHaveBeenCalled();
    });

    it("leaves photos pending with storage_cap and stops downloads at the cap", async () => {
        const { deps } = setup({
            f_1: [{ plaudImageId: "c_a", url: "https://s3/a", offsetMs: 1 }],
            f_2: [{ plaudImageId: "c_b", url: "https://s3/b", offsetMs: 1 }],
        });
        rows.listImagesToDownload.mockResolvedValue([
            { id: "img_a", plaudImageId: "c_a" },
        ]);
        enforceStorageCap.mockResolvedValue({
            allowed: false,
            currentBytes: 10,
            limitBytes: 10,
        });

        await importRecordingPhotos([candidate(1), candidate(2)], deps);

        expect(rows.markImagePending).toHaveBeenCalledWith(
            "img_a",
            "storage_cap",
        );
        expect(fetchUrlWithLimit).not.toHaveBeenCalled();
        expect(rows.markImageFailed).not.toHaveBeenCalled();
        // Later recordings are still listed and marked checked, just not downloaded.
        expect(rows.markImagesChecked).toHaveBeenCalledWith("u1", "rec2", "v2");
        expect(rows.listImagesToDownload).toHaveBeenCalledTimes(1);
    });

    it("refuses a photo whose real size passes the cap after download", async () => {
        const { deps, storage } = setup({
            f_1: [{ plaudImageId: "c_a", url: "https://s3/a", offsetMs: 1 }],
        });
        rows.listImagesToDownload.mockResolvedValue([
            { id: "img_a", plaudImageId: "c_a" },
        ]);
        enforceStorageCap.mockImplementation(
            async ({ additionalBytes }: { additionalBytes: number }) => ({
                allowed: additionalBytes < 5,
                currentBytes: 0,
                limitBytes: 4,
            }),
        );
        fetchUrlWithLimit.mockResolvedValue({ buffer: JPEG });

        await importRecordingPhotos([candidate(1)], deps);

        expect(rows.markImagePending).toHaveBeenCalledWith(
            "img_a",
            "storage_cap",
        );
        expect(storage.uploadFile).not.toHaveBeenCalled();
    });

    it("removes its upload and writes nothing when the recording was deleted meanwhile", async () => {
        const { deps, storage } = setup({
            f_1: [
                { plaudImageId: "c_a", url: "https://s3/a", offsetMs: 1 },
                { plaudImageId: "c_b", url: "https://s3/b", offsetMs: 2 },
            ],
        });
        rows.listImagesToDownload.mockResolvedValue([
            { id: "img_a", plaudImageId: "c_a" },
            { id: "img_b", plaudImageId: "c_b" },
        ]);
        fetchUrlWithLimit.mockResolvedValue({ buffer: JPEG });
        rows.markImageReady.mockResolvedValueOnce(false);

        await importRecordingPhotos([candidate(1)], deps);

        expect(storage.deleteFile).toHaveBeenCalledWith(
            "u1/images/rec1/c_a.jpg",
        );
        expect(fetchUrlWithLimit).toHaveBeenCalledTimes(1);
    });

    it("stops the pass on a dead Plaud token", async () => {
        const { deps, plaudClient, errors } = setup({});
        plaudClient.listRecordingImages.mockRejectedValueOnce(
            new AppError(ErrorCode.PLAUD_INVALID_TOKEN, "expired", 401),
        );

        await importRecordingPhotos([candidate(1), candidate(2)], deps);

        expect(plaudClient.listRecordingImages).toHaveBeenCalledTimes(1);
        expect(errors).toEqual([
            "Plaud photo import stopped: access token expired",
        ]);
    });

    it("handles at most 25 recordings per run, in candidate order", async () => {
        const { deps, plaudClient } = setup({});
        rows.listImagesToDownload.mockResolvedValue([]);

        await importRecordingPhotos(
            Array.from({ length: 30 }, (_, i) => candidate(i)),
            deps,
        );

        expect(plaudClient.listRecordingImages).toHaveBeenCalledTimes(25);
        expect(plaudClient.listRecordingImages.mock.calls.at(-1)?.[0]).toBe(
            "f_24",
        );
    });

    it("stops downloading once the time budget is spent, leaving the rest pending", async () => {
        const { deps } = setup({
            f_1: [
                { plaudImageId: "c_a", url: "https://s3/a", offsetMs: 1 },
                { plaudImageId: "c_b", url: "https://s3/b", offsetMs: 2 },
            ],
        });
        rows.listImagesToDownload.mockResolvedValue([
            { id: "img_a", plaudImageId: "c_a" },
            { id: "img_b", plaudImageId: "c_b" },
        ]);
        fetchUrlWithLimit.mockResolvedValue({ buffer: JPEG });
        const readings = [0, 1_000, PHOTO_LIMITS.msPerRun];
        const now = () => readings.shift() ?? PHOTO_LIMITS.msPerRun;

        await importRecordingPhotos([candidate(1)], { ...deps, now });

        expect(fetchUrlWithLimit).toHaveBeenCalledTimes(1);
        expect(rows.markImageFailed).not.toHaveBeenCalled();
        expect(rows.markImagePending).not.toHaveBeenCalled();
    });

    it("resets failed photos when the Plaud version changed since the last check", async () => {
        const { deps } = setup({});
        rows.listImagesToDownload.mockResolvedValue([]);

        await importRecordingPhotos(
            [candidate(1, { imagesCheckedVersion: "v1" }), candidate(2)],
            deps,
        );

        expect(rows.resetFailedImages.mock.calls).toEqual([["u1", "rec1"]]);
    });

    it("checks the storage cap against the database only once per pass when under it", async () => {
        const { deps } = setup({
            f_1: [
                { plaudImageId: "c_a", url: "https://s3/a", offsetMs: 1 },
                { plaudImageId: "c_b", url: "https://s3/b", offsetMs: 2 },
            ],
        });
        rows.listImagesToDownload.mockResolvedValue([
            { id: "img_a", plaudImageId: "c_a" },
            { id: "img_b", plaudImageId: "c_b" },
        ]);
        enforceStorageCap.mockResolvedValue({
            allowed: true,
            currentBytes: 0,
            limitBytes: 1_000,
        });
        fetchUrlWithLimit.mockResolvedValue({ buffer: JPEG });

        await importRecordingPhotos([candidate(1)], deps);

        expect(enforceStorageCap).toHaveBeenCalledTimes(1);
        expect(rows.markImageReady).toHaveBeenCalledTimes(2);
    });
});
