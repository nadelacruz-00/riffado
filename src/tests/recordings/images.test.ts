import type { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { drizzle } from "drizzle-orm/postgres-js";
import { describe, expect, it, vi } from "vitest";
import * as schema from "@/db/schema";

vi.mock("@/db", () => ({ db: {} }));

const {
    deleteImagesForRecording,
    formatImageOffset,
    imageExportName,
    imageStorageKey,
    listImageStoragePaths,
    readyImagesQuery,
    retryableImageCondition,
    sniffImage,
} = await import("@/lib/recordings/images");

const mockDb = drizzle.mock({ schema }) as unknown as Parameters<
    typeof readyImagesQuery
>[0];
const dialect = new PgDialect();
const render = (cond: unknown) => {
    const { sql, params } = dialect.sqlToQuery(cond as SQL);
    return { sql, params };
};

describe("imageStorageKey", () => {
    it("keys photos by user, recording and Plaud id", () => {
        expect(
            imageStorageKey("user_1", "rec_A", "c_01a1c3f6136d", "jpg"),
        ).toBe("user_1/images/rec_A/c_01a1c3f6136d.jpg");
    });

    it.each([
        ["../etc", "rec_A", "c_1"],
        ["user_1", "rec/A", "c_1"],
        ["user_1", "rec_A", "c 1"],
        ["user_1", "rec_A", ""],
    ])("rejects unsafe segment %s / %s / %s", (u, r, p) => {
        expect(() => imageStorageKey(u, r, p, "png")).toThrow();
    });

    it("rejects an extension outside the allowed set", () => {
        expect(() =>
            imageStorageKey("u", "r", "c_1", "svg" as unknown as "png"),
        ).toThrow();
    });
});

describe("formatImageOffset", () => {
    it.each([
        [0, "0:00"],
        [105_920, "1:45"],
        [3_544_000, "59:04"],
        [3_725_000, "1:02:05"],
        [-5, "0:00"],
    ])("%i ms -> %s", (ms, label) => {
        expect(formatImageOffset(ms)).toBe(label);
    });
});

describe("imageExportName", () => {
    it("uses the 1-based position and the offset in total minutes", () => {
        expect(imageExportName(0, 7, 105_920, "jpg")).toBe("01-01m45s.jpg");
        expect(imageExportName(6, 7, 3_544_000, "jpg")).toBe("07-59m04s.jpg");
        expect(imageExportName(1, 2, 3_725_000, "png")).toBe("02-62m05s.png");
    });

    it("pads to 3 digits from 100 photos", () => {
        expect(imageExportName(4, 120, 0, "webp")).toBe("005-00m00s.webp");
    });

    it("falls back to the position when there is no offset", () => {
        expect(imageExportName(2, 3, null, "heic")).toBe("03.heic");
    });
});

describe("readyImagesQuery", () => {
    const { sql, params } = readyImagesQuery(mockDb, "user_1", "rec_A").toSQL();

    it("filters by owner, recording, ready status and live recording", () => {
        expect(sql).toContain('"recording_images"."user_id" = $1');
        expect(sql).toContain('"recording_images"."recording_id" = $2');
        expect(sql).toContain('"recording_images"."status" = $3');
        expect(sql).toContain('"recordings"."user_id" = $4');
        expect(sql).toContain('"recordings"."deleted_at" is null');
        expect(params).toEqual(["user_1", "rec_A", "ready", "user_1"]);
    });

    it("orders by offset (nulls last), then Plaud id", () => {
        expect(sql).toMatch(
            /order by "recording_images"\."offset_ms" asc nulls last, "recording_images"\."plaud_image_id" asc$/,
        );
    });
});

function fakeExecutor(rows: { storagePath: string | null }[]) {
    const where = vi.fn();
    const returning = vi.fn(() => Promise.resolve(rows));
    const chain = {
        delete: vi.fn(() => chain),
        select: vi.fn(() => chain),
        from: vi.fn(() => chain),
        where: vi.fn((cond: unknown) => {
            where(cond);
            return Object.assign(Promise.resolve(rows), { returning });
        }),
        returning,
    };
    return { chain, where };
}

describe("deleteImagesForRecording", () => {
    it("deletes the recording's rows and returns only stored paths", async () => {
        const { chain, where } = fakeExecutor([
            { storagePath: "u/images/r/c_1.jpg" },
            { storagePath: null },
            { storagePath: "u/images/r/c_2.png" },
        ]);
        const paths = await deleteImagesForRecording(chain as never, "u", "r");
        expect(chain.delete).toHaveBeenCalledWith(schema.recordingImages);
        expect(render(where.mock.calls[0][0])).toEqual({
            sql: '("recording_images"."user_id" = $1 and "recording_images"."recording_id" = $2)',
            params: ["u", "r"],
        });
        expect(chain.returning).toHaveBeenCalledTimes(1);
        expect(paths).toEqual(["u/images/r/c_1.jpg", "u/images/r/c_2.png"]);
    });
});

describe("listImageStoragePaths", () => {
    it("returns every stored path of the user, skipping unstored rows", async () => {
        const { chain, where } = fakeExecutor([
            { storagePath: "u/images/r1/c_1.jpg" },
            { storagePath: null },
        ]);
        const paths = await listImageStoragePaths("u", chain as never);
        expect(chain.from).toHaveBeenCalledWith(schema.recordingImages);
        expect(render(where.mock.calls[0][0])).toEqual({
            sql: '"recording_images"."user_id" = $1',
            params: ["u"],
        });
        expect(paths).toEqual(["u/images/r1/c_1.jpg"]);
    });
});

describe("sniffImage", () => {
    const heic = Buffer.concat([
        Buffer.from([0, 0, 0, 24]),
        Buffer.from("ftypheic", "ascii"),
        Buffer.alloc(4),
    ]);
    const webp = Buffer.concat([
        Buffer.from("RIFF", "ascii"),
        Buffer.alloc(4),
        Buffer.from("WEBP", "ascii"),
    ]);

    it.each([
        [Buffer.from([0xff, 0xd8, 0xff, 0xe1]), "jpg", "image/jpeg"],
        [
            Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
            "png",
            "image/png",
        ],
        [webp, "webp", "image/webp"],
        [heic, "heic", "image/heic"],
    ])("detects %#", (buf, ext, mimeType) => {
        expect(sniffImage(buf)).toEqual({ ext, mimeType });
    });

    it("rejects SVG, empty and truncated data", () => {
        expect(sniffImage(Buffer.from("<svg xmlns='x'/>"))).toBeNull();
        expect(sniffImage(Buffer.alloc(0))).toBeNull();
        expect(sniffImage(Buffer.from([0xff, 0xd8]))).toBeNull();
    });
});

describe("retryableImageCondition", () => {
    it("selects pending rows and failed rows with attempts left, except unsupported_type", () => {
        expect(render(retryableImageCondition())).toEqual({
            sql: '("recording_images"."status" = $1 or ("recording_images"."status" = $2 and "recording_images"."attempts" < $3 and ("recording_images"."last_error" is null or "recording_images"."last_error" <> $4)))',
            params: ["pending", "failed", 5, "unsupported_type"],
        });
    });
});
