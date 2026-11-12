/** File extensions a stored photo may have (from sniffed magic bytes). */
export const IMAGE_EXTENSIONS = ["jpg", "png", "webp", "heic"] as const;
export type ImageExtension = (typeof IMAGE_EXTENSIONS)[number];
