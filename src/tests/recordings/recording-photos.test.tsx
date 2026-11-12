/**
 * @vitest-environment jsdom
 *
 * Photos card on the recording surfaces (#331): no request and no card for
 * recordings without photos, placeholders while loading, an error line with
 * Retry, status lines that match the sync rules, the viewer, and the time
 * badge that seeks the player.
 */

import {
    cleanup,
    fireEvent,
    render,
    screen,
    waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RecordingPhotos } from "@/components/recordings/recording-photos";
import { onRecordingSeek } from "@/lib/recordings/seek-event";

const photos = [
    {
        id: "img_a",
        url: "/api/recordings/rec1/images/img_a",
        mimeType: "image/jpeg",
        offsetMs: 105_920,
        capturedAt: null,
    },
    {
        id: "img_b",
        url: "/api/recordings/rec1/images/img_b",
        mimeType: "image/heic",
        offsetMs: 353_000,
        capturedAt: null,
    },
];

function respond(body: unknown, ok = true) {
    vi.mocked(global.fetch).mockResolvedValueOnce({
        ok,
        status: ok ? 200 : 500,
        json: async () => body,
    } as Response);
}

beforeEach(() => {
    global.fetch = vi.fn();
});

afterEach(() => {
    cleanup();
});

describe("RecordingPhotos", () => {
    it("renders nothing and makes no request without photos", () => {
        const { container } = render(
            <RecordingPhotos
                recordingId="rec1"
                recordingTitle="Lecture"
                imageCount={0}
            />,
        );
        expect(container.innerHTML).toBe("");
        expect(global.fetch).not.toHaveBeenCalled();
    });

    it("shows one placeholder per photo while loading", () => {
        vi.mocked(global.fetch).mockReturnValueOnce(new Promise(() => {}));
        const { container } = render(
            <RecordingPhotos
                recordingId="rec1"
                recordingTitle="Lecture"
                imageCount={3}
            />,
        );
        expect(
            container.querySelectorAll('li[aria-hidden="true"]'),
        ).toHaveLength(3);
    });

    it("shows an error line with Retry, and retries", async () => {
        respond({}, false);
        render(
            <RecordingPhotos
                recordingId="rec1"
                recordingTitle="Lecture"
                imageCount={2}
            />,
        );
        expect(
            await screen.findByText(/Photos could not be loaded/),
        ).toBeTruthy();

        respond({
            images: photos,
            notReady: { syncing: 0, storageCap: 0, failed: 0 },
            importPlaudContent: true,
        });
        fireEvent.click(screen.getByRole("button", { name: "Retry" }));
        expect(
            await screen.findByRole("button", { name: "Open photo at 1:45" }),
        ).toBeTruthy();
    });

    it("lists photos with time badges, a HEIC download tile and alt text", async () => {
        respond({
            images: photos,
            notReady: { syncing: 0, storageCap: 0, failed: 0 },
            importPlaudContent: true,
        });
        render(
            <RecordingPhotos
                recordingId="rec1"
                recordingTitle="Lecture"
                imageCount={2}
            />,
        );

        const img = await screen.findByAltText("Photo at 1:45 in Lecture");
        expect(img.getAttribute("loading")).toBe("lazy");
        expect(img.getAttribute("decoding")).toBe("async");
        expect(
            screen
                .getByRole("link", { name: /Download HEIC/ })
                .getAttribute("href"),
        ).toBe("/api/recordings/rec1/images/img_b");
        expect(
            screen.getByRole("button", { name: "Play from 5:53" }),
        ).toBeTruthy();
    });

    it("asks the player to seek when a time badge is clicked", async () => {
        respond({
            images: photos,
            notReady: { syncing: 0, storageCap: 0, failed: 0 },
            importPlaudContent: true,
        });
        const seek = vi.fn();
        const off = onRecordingSeek("rec1", seek);
        render(
            <RecordingPhotos
                recordingId="rec1"
                recordingTitle="Lecture"
                imageCount={2}
            />,
        );

        fireEvent.click(
            await screen.findByRole("button", { name: "Play from 1:45" }),
        );
        expect(seek).toHaveBeenCalledWith(105_920);
        off();
    });

    it("replaces a photo that fails to load with an unavailable tile", async () => {
        respond({
            images: photos.slice(0, 1),
            notReady: { syncing: 0, storageCap: 0, failed: 0 },
            importPlaudContent: true,
        });
        render(
            <RecordingPhotos
                recordingId="rec1"
                recordingTitle="Lecture"
                imageCount={1}
            />,
        );
        fireEvent.error(await screen.findByAltText("Photo at 1:45 in Lecture"));
        expect(await screen.findByText("Photo unavailable")).toBeTruthy();
    });

    it("opens the viewer and plays from the photo's moment", async () => {
        respond({
            images: photos.slice(0, 1),
            notReady: { syncing: 0, storageCap: 0, failed: 0 },
            importPlaudContent: true,
        });
        const seek = vi.fn();
        const off = onRecordingSeek("rec1", seek);
        render(
            <RecordingPhotos
                recordingId="rec1"
                recordingTitle="Lecture"
                imageCount={1}
            />,
        );

        fireEvent.click(
            await screen.findByRole("button", { name: "Open photo at 1:45" }),
        );
        fireEvent.click(
            await screen.findByRole("button", { name: /Play from 1:45/ }),
        );
        expect(seek).toHaveBeenCalledWith(105_920);
        await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
        off();
    });

    it.each([
        [
            { syncing: 1, storageCap: 0, failed: 0 },
            true,
            "1 photo is still syncing.",
        ],
        [
            { syncing: 0, storageCap: 2, failed: 0 },
            true,
            "2 photos are waiting for storage space.",
        ],
        [
            { syncing: 0, storageCap: 0, failed: 1 },
            true,
            "1 photo could not be synced.",
        ],
        [
            { syncing: 1, storageCap: 1, failed: 0 },
            false,
            "2 photos were not synced. Turn on Import Plaud transcripts, summaries and photos in",
        ],
    ])("shows the status line for %j (import on: %s)", async (notReady, importPlaudContent, text) => {
        respond({ images: [], notReady, importPlaudContent });
        render(
            <RecordingPhotos
                recordingId="rec1"
                recordingTitle="Lecture"
                imageCount={3}
            />,
        );
        const status = await screen.findByRole("status");
        expect(status.textContent).toContain(text);
        if (!importPlaudContent) {
            expect(status.textContent).not.toContain("still syncing");
        }
    });
});
