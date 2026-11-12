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
