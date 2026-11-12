"use client";

import {
    ChevronLeft,
    ChevronRight,
    FileImage,
    ImageOff,
    Info,
    Play,
} from "lucide-react";
import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogTitle,
} from "@/components/ui/dialog";
import { formatImageOffset } from "@/lib/recordings/image-format";
import { requestRecordingSeek } from "@/lib/recordings/seek-event";
import { cn } from "@/lib/utils";

interface PhotoItem {
    id: string;
    url: string;
    mimeType: string | null;
    offsetMs: number | null;
    capturedAt: string | null;
}

interface PhotosResponse {
    images: PhotoItem[];
    notReady: { syncing: number; storageCap: number; failed: number };
    importPlaudContent: boolean;
}

interface RecordingPhotosProps {
    recordingId: string;
    recordingTitle: string;
    /** Photo rows of the recording (any status); the card renders only above 0. */
    imageCount: number;
}

const PLACEHOLDER_MAX = 8;
const SWIPE_MIN_PX = 50;

function photoLabel(offsetMs: number | null): string {
    return offsetMs === null
        ? "Photo"
        : `Photo at ${formatImageOffset(offsetMs)}`;
}

function plural(n: number, word: string): string {
    return `${n} ${word}${n === 1 ? "" : "s"}`;
}

/** Status lines for photos that are not ready, one per category (Eng review R19). */
function statusLines(data: PhotosResponse): React.ReactNode[] {
    const { syncing, storageCap, failed } = data.notReady;
    const lines: React.ReactNode[] = [];
    if (!data.importPlaudContent) {
        const waiting = syncing + storageCap;
        if (waiting > 0) {
            lines.push(
                <>
                    {plural(waiting, "photo")} {waiting === 1 ? "was" : "were"}{" "}
                    not synced. Turn on Import Plaud transcripts, summaries and
                    photos in{" "}
                    <Link
                        href="/settings"
                        className="underline underline-offset-2"
                    >
                        Settings
                    </Link>{" "}
                    to sync them.
                </>,
            );
        }
    } else {
        if (storageCap > 0) {
            lines.push(
                <>
                    {plural(storageCap, "photo")}{" "}
                    {storageCap === 1 ? "is" : "are"} waiting for storage space.{" "}
                    <Link
                        href="/settings#billing"
                        className="underline underline-offset-2"
                    >
                        Manage storage
                    </Link>
                </>,
            );
        }
        if (syncing > 0) {
            lines.push(
                <>
                    {plural(syncing, "photo")} {syncing === 1 ? "is" : "are"}{" "}
                    still syncing.
                </>,
            );
        }
    }
    if (failed > 0) {
        lines.push(<>{plural(failed, "photo")} could not be synced.</>);
    }
    return lines;
}

function TimeBadge({
    recordingId,
    offsetMs,
}: {
    recordingId: string;
    offsetMs: number;
}) {
    const label = formatImageOffset(offsetMs);
    return (
        <button
            type="button"
            aria-label={`Play from ${label}`}
            onClick={() => requestRecordingSeek(recordingId, offsetMs)}
            className="absolute bottom-0 left-0 flex min-h-11 min-w-11 items-end justify-start p-1.5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring rounded-md"
        >
            <span className="rounded-sm bg-foreground/70 px-1.5 text-xs leading-5 text-background tabular-nums">
                {label}
            </span>
        </button>
    );
}

/** Plaud Highlight photos of a recording: grid, viewer and status lines (#331). */
export function RecordingPhotos({
    recordingId,
    recordingTitle,
    imageCount,
}: RecordingPhotosProps) {
    const [data, setData] = useState<PhotosResponse | null>(null);
    const [error, setError] = useState(false);
    const [broken, setBroken] = useState<Set<string>>(new Set());
    const [openIndex, setOpenIndex] = useState<number | null>(null);
    const touchStartX = useRef<number | null>(null);

    const load = useCallback(async () => {
        setError(false);
        setData(null);
        try {
            const res = await fetch(`/api/recordings/${recordingId}/images`);
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            setData((await res.json()) as PhotosResponse);
        } catch {
            setError(true);
        }
    }, [recordingId]);

    useEffect(() => {
        setBroken(new Set());
        setOpenIndex(null);
        if (imageCount > 0) void load();
    }, [imageCount, load]);

    if (imageCount <= 0) return null;

    const images = data?.images ?? [];
    const open = openIndex === null ? null : images[openIndex];
    const step = (delta: number) =>
        setOpenIndex((i) =>
            i === null || images.length === 0
                ? i
                : (i + delta + images.length) % images.length,
        );

    return (
        <Card>
            <CardHeader>
                <CardTitle className="flex items-baseline gap-2">
                    Photos
                    {data && images.length > 0 && (
                        <span className="text-sm font-normal text-muted-foreground tabular-nums">
                            {images.length}
                        </span>
                    )}
                </CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
                {error ? (
                    <p className="text-sm text-muted-foreground">
                        Photos could not be loaded.{" "}
                        <button
                            type="button"
                            onClick={() => void load()}
                            className="underline underline-offset-2"
                        >
                            Retry
                        </button>
                    </p>
                ) : (
                    <ul className="grid grid-cols-3 gap-2 sm:grid-cols-4">
                        {data === null
                            ? Array.from(
                                  {
                                      length: Math.min(
                                          imageCount,
                                          PLACEHOLDER_MAX,
                                      ),
                                  },
                                  (_, i) => (
                                      <li
                                          // biome-ignore lint/suspicious/noArrayIndexKey: static placeholders
                                          key={i}
                                          aria-hidden="true"
                                          className="aspect-square rounded-md bg-muted"
                                      />
                                  ),
                              )
                            : images.map((photo, index) => {
                                  const label = photoLabel(photo.offsetMs);
                                  const isHeic =
                                      photo.mimeType === "image/heic";
                                  const isBroken = broken.has(photo.id);
                                  return (
                                      <li
                                          key={photo.id}
                                          className="relative aspect-square overflow-hidden rounded-md bg-muted"
                                      >
                                          {isBroken ? (
                                              <div className="flex h-full flex-col items-center justify-center gap-1 p-2 text-center text-xs text-muted-foreground">
                                                  <ImageOff
                                                      className="size-5"
                                                      aria-hidden="true"
                                                  />
                                                  Photo unavailable
                                              </div>
                                          ) : isHeic ? (
                                              <a
                                                  href={photo.url}
                                                  download
                                                  className="flex h-full flex-col items-center justify-center gap-1 p-2 text-center text-xs text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring rounded-md"
                                              >
                                                  <FileImage
                                                      className="size-5"
                                                      aria-hidden="true"
                                                  />
                                                  Download HEIC
                                              </a>
                                          ) : (
                                              <button
                                                  type="button"
                                                  aria-label={`Open ${label.toLowerCase()}`}
                                                  onClick={() =>
                                                      setOpenIndex(index)
                                                  }
                                                  className="block h-full w-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring rounded-md"
                                              >
                                                  {/* biome-ignore lint/performance/noImgElement: authenticated route, no image optimizer */}
                                                  <img
                                                      src={photo.url}
                                                      alt={`${label} in ${recordingTitle}`}
                                                      loading="lazy"
                                                      decoding="async"
                                                      className="h-full w-full object-cover"
                                                      onError={() =>
                                                          setBroken((prev) =>
                                                              new Set(prev).add(
                                                                  photo.id,
                                                              ),
                                                          )
                                                      }
                                                  />
                                              </button>
                                          )}
                                          {photo.offsetMs !== null &&
                                              !isBroken && (
                                                  <TimeBadge
                                                      recordingId={recordingId}
                                                      offsetMs={photo.offsetMs}
                                                  />
                                              )}
                                      </li>
                                  );
                              })}
                    </ul>
                )}

                {data && (
                    <output className="block space-y-1">
                        {statusLines(data).map((line, i) => (
                            <p
                                // biome-ignore lint/suspicious/noArrayIndexKey: fixed order of categories
                                key={i}
                                className="flex items-start gap-1.5 text-sm text-muted-foreground"
                            >
                                <Info
                                    className="mt-0.5 size-4 shrink-0"
                                    aria-hidden="true"
                                />
                                <span>{line}</span>
                            </p>
                        ))}
                    </output>
                )}
            </CardContent>

            <Dialog
                open={open !== null && open !== undefined}
                onOpenChange={(next) => !next && setOpenIndex(null)}
            >
                {open && (
                    <DialogContent
                        className="max-sm:h-dvh max-sm:max-w-none max-sm:w-screen max-sm:rounded-none sm:max-w-5xl"
                        onKeyDown={(e) => {
                            if (e.key === "ArrowLeft") {
                                e.preventDefault();
                                step(-1);
                            } else if (e.key === "ArrowRight") {
                                e.preventDefault();
                                step(1);
                            }
                        }}
                        onTouchStart={(e) => {
                            touchStartX.current = e.touches[0]?.clientX ?? null;
                        }}
                        onTouchEnd={(e) => {
                            const start = touchStartX.current;
                            const end = e.changedTouches[0]?.clientX;
                            touchStartX.current = null;
                            if (start === null || end === undefined) return;
                            if (end - start > SWIPE_MIN_PX) step(-1);
                            else if (start - end > SWIPE_MIN_PX) step(1);
                        }}
                    >
                        <DialogTitle>{photoLabel(open.offsetMs)}</DialogTitle>
                        <DialogDescription className="sr-only">
                            {recordingTitle}. Use the left and right arrow keys
                            to move between photos.
                        </DialogDescription>
                        {/* biome-ignore lint/performance/noImgElement: authenticated route, no image optimizer */}
                        <img
                            src={open.url}
                            alt={`${photoLabel(open.offsetMs)} in ${recordingTitle}`}
                            className="mx-auto max-h-[80vh] w-full object-contain"
                        />
                        <div
                            className={cn(
                                "flex items-center gap-2",
                                images.length > 1
                                    ? "justify-between"
                                    : "justify-end",
                            )}
                        >
                            {images.length > 1 && (
                                <div className="flex gap-2">
                                    <Button
                                        variant="outline"
                                        size="icon"
                                        className="size-11"
                                        aria-label="Previous photo"
                                        onClick={() => step(-1)}
                                    >
                                        <ChevronLeft className="size-4" />
                                    </Button>
                                    <Button
                                        variant="outline"
                                        size="icon"
                                        className="size-11"
                                        aria-label="Next photo"
                                        onClick={() => step(1)}
                                    >
                                        <ChevronRight className="size-4" />
                                    </Button>
                                </div>
                            )}
                            {open.offsetMs !== null && (
                                <Button
                                    className="min-h-11"
                                    onClick={() => {
                                        const offsetMs =
                                            open.offsetMs as number;
                                        setOpenIndex(null);
                                        requestRecordingSeek(
                                            recordingId,
                                            offsetMs,
                                        );
                                    }}
                                >
                                    <Play
                                        className="size-4"
                                        aria-hidden="true"
                                    />
                                    Play from {formatImageOffset(open.offsetMs)}
                                </Button>
                            )}
                        </div>
                    </DialogContent>
                )}
            </Dialog>
        </Card>
    );
}
