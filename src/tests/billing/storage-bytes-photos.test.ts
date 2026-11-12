import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
    select: vi.fn(),
    getUserImageBytes: vi.fn(),
}));

vi.mock("@/db", () => ({ db: { select: m.select } }));
vi.mock("@/lib/recordings/images", () => ({
    getUserImageBytes: m.getUserImageBytes,
}));

import { getUserStorageBytes } from "@/db/queries/billing";

function stubAudioTotal(total: string | null) {
    m.select.mockReturnValue({
        from: () => ({ where: async () => [{ total }] }),
    });
}

beforeEach(() => {
    vi.clearAllMocks();
});

describe("getUserStorageBytes (#331)", () => {
    it("returns the same total as before for a user without photos", async () => {
        stubAudioTotal("1500");
        m.getUserImageBytes.mockResolvedValue(0);
        expect(await getUserStorageBytes("u1")).toBe(1500);
    });

    it("adds ready photo bytes to the audio bytes", async () => {
        stubAudioTotal("1500");
        m.getUserImageBytes.mockResolvedValue(250);
        expect(await getUserStorageBytes("u1")).toBe(1750);
        expect(m.getUserImageBytes).toHaveBeenCalledWith("u1");
    });

    it("counts photos for a user with no live recordings", async () => {
        stubAudioTotal(null);
        m.getUserImageBytes.mockResolvedValue(0);
        expect(await getUserStorageBytes("u1")).toBe(0);
    });
});
