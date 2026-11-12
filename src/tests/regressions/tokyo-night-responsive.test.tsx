/**
 * @vitest-environment jsdom
 *
 * Tokyo Night dark theme + phone-width layout fixes.
 *
 * - The `.dark` tokens are the Tokyo Night (night) palette; the light
 *   `:root` palette is unchanged.
 * - Player controls: below `sm` the scrubber wraps onto its own
 *   full-width line and the volume group is hidden (at 360 px the
 *   one-row layout gave the waveform zero width and pushed the
 *   volume slider past the card edge).
 * - Player header: no "·" separators, so a wrapped metadata line
 *   cannot start with a dot.
 * - Buttons reach 44 px on coarse (touch) pointers.
 * - The list count label never wraps.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { cleanup, render } from "@testing-library/react";
import { createRef } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/components/recordings/recording-title", () => ({
    RecordingTitle: ({ filename }: { filename: string }) => (
        <span>{filename}</span>
    ),
}));
vi.mock("@/components/recordings/download-audio-button", () => ({
    DownloadAudioButton: () => <button type="button">Download</button>,
}));
vi.mock("@/components/local-time", () => ({
    LocalTimeRange: () => <span>Nov 12, 9:30–10:12 AM</span>,
}));

globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
} as unknown as typeof ResizeObserver;

import { RecordingListToolbar } from "@/components/dashboard/recording-list-toolbar";
import { RecordingPlayerControls } from "@/components/dashboard/recording-player-controls";
import { RecordingPlayerHeader } from "@/components/dashboard/recording-player-header";
import { metalButtonVariants } from "@/components/metal-button";
import { buttonVariants } from "@/components/ui/button";
import type { Recording } from "@/types/recording";

afterEach(cleanup);

const css = readFileSync(resolve(__dirname, "../../app/globals.css"), "utf8");

function block(selector: string): string {
    const start = css.indexOf(`${selector} {`);
    expect(start).toBeGreaterThanOrEqual(0);
    return css.slice(start, css.indexOf("\n}", start));
}

describe("Tokyo Night dark theme tokens", () => {
    it("maps the core .dark tokens to the night palette", () => {
        const dark = block(".dark");
        for (const [token, hex] of [
            ["--background", "#1a1b26"],
            ["--foreground", "#c0caf5"],
            ["--card", "#16161e"],
            ["--primary", "#7aa2f7"],
            ["--primary-foreground", "#16161e"],
            ["--border", "#292e42"],
            ["--input", "#3b4261"],
            ["--destructive", "#f7768e"],
            ["--ring", "#7aa2f7"],
        ]) {
            expect(dark).toContain(`${token}: ${hex};`);
        }
    });

    it("keeps the light :root palette", () => {
        expect(block(":root")).toContain(
            "--background: oklch(0.9818 0.0054 95.0986);",
        );
    });
});

describe("touch target size", () => {
    it("gives every Button size a 44px minimum on coarse pointers", () => {
        for (const size of ["default", "sm", "icon", "icon-sm"] as const) {
            const cls = buttonVariants({ size });
            expect(cls).toContain("pointer-coarse:min-h-11");
            expect(cls).toContain("pointer-coarse:min-w-11");
        }
    });

    it("gives MetalButton the same minimum", () => {
        expect(metalButtonVariants({ size: "icon" })).toContain(
            "pointer-coarse:min-h-11",
        );
    });
});

function renderControls() {
    return render(
        <RecordingPlayerControls
            isPlaying={false}
            onTogglePlay={() => {}}
            currentTime={0}
            duration={60}
            onSeekRatio={() => {}}
            playbackSpeed={1}
            onCycleSpeed={() => {}}
            volume={75}
            onVolumeChange={() => {}}
            onToggleMute={() => {}}
            scrubberStyle="slider"
            waveformPeaks={null}
        />,
    );
}

describe("player controls at phone width", () => {
    it("wraps the row below sm and keeps one row from sm up", () => {
        const { getByLabelText } = renderControls();
        const row = getByLabelText(/^Play$/).parentElement as HTMLElement;
        expect(row.className).toContain("flex-wrap");
        expect(row.className).toContain("sm:flex-nowrap");
    });

    it("puts the scrubber on its own full-width line below sm", () => {
        const { getByLabelText } = renderControls();
        const row = getByLabelText(/^Play$/).parentElement as HTMLElement;
        const scrubber = row.querySelector(".order-last") as HTMLElement;
        expect(scrubber).not.toBeNull();
        expect(scrubber.className).toContain("basis-full");
        expect(scrubber.className).toContain("sm:flex-1");
    });

    it("hides the volume group below sm", () => {
        const { getByLabelText } = renderControls();
        const group = getByLabelText("Mute").parentElement as HTMLElement;
        expect(group.className.split(" ")).toContain("hidden");
        expect(group.className).toContain("sm:flex");
    });

    it("makes the speed button 44px tall below sm", () => {
        const { getByLabelText } = renderControls();
        const speed = getByLabelText(/^Playback speed/);
        expect(speed.className).toContain("h-11");
        expect(speed.className).toContain("sm:h-8");
    });
});

describe("player header metadata", () => {
    it("renders no dot separators", () => {
        const recording = {
            id: "r1",
            filename: "Q4 board meeting.m4a",
            duration: 1_421_000,
            filesize: 11_400_000,
            startTime: new Date("2026-11-12T09:30:00Z"),
        } as unknown as Recording;
        const { container } = render(
            <RecordingPlayerHeader
                recording={recording}
                duration={0}
                scrubberStyle="waveform"
                waveformStatus="decoding"
                onDecodeWaveform={() => {}}
            />,
        );
        expect(container.textContent).not.toContain("·");
        expect(container.textContent).toContain("Analyzing audio");
    });
});

describe("recording list count label", () => {
    it("does not wrap", () => {
        const { getByText } = render(
            <RecordingListToolbar
                query=""
                onQueryChange={() => {}}
                onEnterSelectFirst={() => {}}
                searchRef={createRef<HTMLInputElement>()}
                filteredCount={8}
                totalCount={8}
                sortOrder="newest"
                onSortOrderChange={() => {}}
                density="comfortable"
                onDensityChange={() => {}}
            />,
        );
        const label = getByText(/8 of 8 recording/);
        expect(label.className).toContain("whitespace-nowrap");
    });
});
