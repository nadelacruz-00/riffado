import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/env", () => ({
    env: { WEBSHARE_API_KEY: undefined, PLAUD_PROXY_SCOPE: "all" },
}));

import { PlaudClient } from "../lib/plaud/client";
import { fetchUrlWithLimit, RemoteDownloadError } from "../lib/plaud/fetch";
import { shouldProxyPlaud } from "../lib/plaud/proxy";
import { findMarkMemoObject, selectHighlightImages } from "../lib/plaud/v4";
import fixture from "./fixtures/plaud-v4-detail-with-highlights.json";

const API = "https://api-euc1.plaud.ai";
const MIGRATED = { status: -1800907, msg: "Account migrated to 4.0." };
const S3 = "https://example-bucket.s3-accelerate.amazonaws.com";

const json = (body: unknown) =>
    new Response(JSON.stringify(body), {
        status: 200,
        headers: { "Content-Type": "application/json" },
    });

describe("selectHighlightImages", () => {
    it("returns Highlight photos in offset order and ignores the summary card", () => {
        expect(selectHighlightImages(fixture.detail, fixture.memo)).toEqual([
            {
                plaudImageId: "c_01highlighta",
                url: `${S3}/a.jpg?sig=placeholder`,
                offsetMs: 105920,
            },
            {
                plaudImageId: "c_01highlightb",
                url: `${S3}/b.jpg?sig=placeholder`,
                offsetMs: 353000,
            },
        ]);
    });

    it("gives url null when the mapping lacks the id", () => {
        const detail = { ...fixture.detail, relation_content_mapping: {} };
        expect(
            selectHighlightImages(detail, fixture.memo).map((i) => i.url),
        ).toEqual([null, null]);
    });

    it("skips entries without a safe picture_link and deduplicates ids", () => {
        const memo = [
            { mark_type: 1, timestamp: 10 },
            { picture_link: "../../etc", timestamp: 20 },
            { picture_link: 42 },
            null,
            { picture_link: "c_01highlighta", timestamp: 30 },
            { picture_link: "c_01highlighta", timestamp: 40 },
        ];
        expect(selectHighlightImages(fixture.detail, memo)).toEqual([
            {
                plaudImageId: "c_01highlighta",
                url: `${S3}/a.jpg?sig=placeholder`,
                offsetMs: 30,
            },
        ]);
    });

    it("puts photos without a valid offset last", () => {
        const memo = [
            { picture_link: "c_01highlightb", timestamp: -1 },
            { picture_link: "c_01highlighta", timestamp: 5 },
        ];
        expect(
            selectHighlightImages(fixture.detail, memo).map((i) => [
                i.plaudImageId,
                i.offsetMs,
            ]),
        ).toEqual([
            ["c_01highlighta", 5],
            ["c_01highlightb", null],
        ]);
    });

    it("returns nothing for a memo body that is not a list", () => {
        expect(selectHighlightImages(fixture.detail, { entries: [] })).toEqual(
            [],
        );
        expect(selectHighlightImages(fixture.detail, "text")).toEqual([]);
    });
});

describe("findMarkMemoObject", () => {
    it("finds the MARK_MEMO object or nothing", () => {
        expect(findMarkMemoObject(fixture.detail)?.object_id).toBe("o_memo");
        expect(
            findMarkMemoObject({
                ...fixture.detail,
                objects: fixture.detail.objects.slice(0, 2),
            }),
        ).toBeUndefined();
    });
});

describe("PlaudClient.listRecordingImages", () => {
    const originalFetch = global.fetch;
    let detail: typeof fixture.detail;
    let urlMapCalls: string[][];

    beforeEach(() => {
        detail = structuredClone(fixture.detail);
        urlMapCalls = [];
        global.fetch = vi.fn(
            async (input: RequestInfo | URL, init?: RequestInit) => {
                const u = new URL(String(input));
                if (u.pathname === "/user-app/auth/workspace/token/ws_test") {
                    return json({
                        status: 0,
                        data: { workspace_token: "wt-1" },
                    });
                }
                if (u.pathname === "/file/simple/web") return json(MIGRATED);
                if (u.pathname === "/file-app/v4/recordings/all") {
                    return json({
                        status: 0,
                        data: {
                            items: [
                                {
                                    file_id: "f_photo",
                                    name: "x",
                                    duration_ms: 1,
                                },
                            ],
                            next_cursor: null,
                        },
                    });
                }
                if (u.pathname === "/file-app/v4/files/detail/f_photo") {
                    return json({ status: 0, data: detail });
                }
                if (u.pathname === "/file-app/v4/files/content/url") {
                    const ids = JSON.parse(String(init?.body))
                        .content_ids as string[];
                    urlMapCalls.push(ids);
                    return json({
                        status: 0,
                        data: {
                            url_map: Object.fromEntries(
                                ids.map((id) => [
                                    id,
                                    `${S3}/${id}.jpg?sig=resolved`,
                                ]),
                            ),
                        },
                    });
                }
                if (u.pathname === "/mark_memo.json") return json(fixture.memo);
                return new Response("not found", { status: 404 });
            },
        ) as typeof fetch;
    });

    afterEach(() => {
        global.fetch = originalFetch;
    });

    it("returns nothing on a legacy account without asking for a v4 detail", async () => {
        const client = new PlaudClient("ut-1", API, "ws_test");
        expect(await client.listRecordingImages("f_photo")).toEqual([]);
        expect(global.fetch).not.toHaveBeenCalled();
    });

    it("lists Highlight photos from the MARK_MEMO body", async () => {
        const client = new PlaudClient("ut-1", API, "ws_test");
        await client.getRecordings(0, 1, 0);
        const images = await client.listRecordingImages("f_photo");
        expect(images.map((i) => i.plaudImageId)).toEqual([
            "c_01highlighta",
            "c_01highlightb",
        ]);
        expect(urlMapCalls).toEqual([]);
    });

    it("resolves photo ids missing from the mapping", async () => {
        detail.relation_content_mapping = {
            c_01highlighta: `${S3}/a.jpg?sig=placeholder`,
        } as typeof detail.relation_content_mapping;
        const client = new PlaudClient("ut-1", API, "ws_test");
        await client.getRecordings(0, 1, 0);
        const images = await client.listRecordingImages("f_photo");
        expect(urlMapCalls).toEqual([["c_01highlightb"]]);
        expect(images[1].url).toBe(`${S3}/c_01highlightb.jpg?sig=resolved`);
    });

    it("returns nothing when the recording has no Highlights", async () => {
        detail.objects = detail.objects.filter(
            (o) => o.object_type !== "MARK_MEMO",
        );
        const client = new PlaudClient("ut-1", API, "ws_test");
        await client.getRecordings(0, 1, 0);
        expect(await client.listRecordingImages("f_photo")).toEqual([]);
    });
});

describe("fetchUrlWithLimit", () => {
    const originalFetch = global.fetch;
    afterEach(() => {
        global.fetch = originalFetch;
    });

    const streamOf = (chunks: number[]) =>
        new ReadableStream<Uint8Array>({
            start(c) {
                for (const n of chunks) c.enqueue(new Uint8Array(n));
                c.close();
            },
        });

    it("returns the body and content type within the limit", async () => {
        global.fetch = vi.fn(
            async () =>
                new Response(streamOf([3, 4]), {
                    headers: { "content-type": "image/jpeg" },
                }),
        ) as typeof fetch;
        const { buffer, contentType } = await fetchUrlWithLimit(
            `${S3}/a.jpg`,
            10,
        );
        expect(buffer.length).toBe(7);
        expect(contentType).toBe("image/jpeg");
    });

    it("rejects a Content-Length above the limit before reading the body", async () => {
        const body = streamOf([1]);
        const getReader = vi.spyOn(body, "getReader");
        global.fetch = vi.fn(
            async () =>
                new Response(body, { headers: { "content-length": "11" } }),
        ) as typeof fetch;
        await expect(
            fetchUrlWithLimit(`${S3}/a.jpg`, 10),
        ).rejects.toMatchObject({
            reason: "too_large",
        });
        expect(getReader).not.toHaveBeenCalled();
    });

    it("aborts a stream without Content-Length once it passes the limit", async () => {
        global.fetch = vi.fn(
            async () => new Response(streamOf([6, 6, 6])),
        ) as typeof fetch;
        await expect(
            fetchUrlWithLimit(`${S3}/a.jpg`, 10),
        ).rejects.toBeInstanceOf(RemoteDownloadError);
    });

    it("reports the HTTP status of a failed download", async () => {
        global.fetch = vi.fn(
            async () => new Response("expired", { status: 403 }),
        ) as typeof fetch;
        await expect(
            fetchUrlWithLimit(`${S3}/a.jpg`, 10),
        ).rejects.toMatchObject({
            reason: "http_error",
            status: 403,
        });
    });

    it("never proxies presigned S3 photo hosts, so a 403 cannot rotate a proxy", () => {
        expect(
            shouldProxyPlaud(
                "https://apse1-prod-plaud-content-storage.s3-accelerate.amazonaws.com/x/a.jpg?X-Amz-Signature=placeholder",
            ),
        ).toBe(false);
    });
});
