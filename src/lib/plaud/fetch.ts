import {
    getPlaudProxyUrl,
    invalidatePlaudProxy,
    type SelectedProxy,
    shouldProxyPlaud,
} from "./proxy";

const MAX_PROXY_ROTATIONS = 1;
const PLAUD_WEB_ORIGIN = "https://web.plaud.ai";

/**
 * `fetch`-shaped wrapper. When `WEBSHARE_API_KEY` is configured and the URL
 * targets a Plaud host, routes the request through an HTTP proxy from the
 * configured pool with one rotation on 403/407. Otherwise behaves as a
 * pass-through to the global `fetch`.
 *
 * Uses the runtime's native `proxy` option so the same TLS stack handles
 * both proxied and direct requests.
 */
export async function plaudFetch(
    url: string,
    init?: RequestInit,
): Promise<Response> {
    if (!shouldProxyPlaud(url)) {
        return fetch(url, init);
    }

    let currentProxy: SelectedProxy | null = await getPlaudProxyUrl();
    if (!currentProxy) {
        return fetch(url, init);
    }

    const headers = mergeBrowserHeaders(init?.headers);

    let attempt = 0;
    while (true) {
        let response: Response;
        try {
            response = await fetch(url, {
                ...init,
                headers,
                // @ts-expect-error -- Bun extension to RequestInit
                proxy: currentProxy.url,
            });
        } catch (err) {
            if (attempt < MAX_PROXY_ROTATIONS) {
                logProxyEvent(
                    "network-error",
                    url,
                    currentProxy.label,
                    err instanceof Error ? err.message : String(err),
                );
                invalidatePlaudProxy(currentProxy);
                const next = await getPlaudProxyUrl();
                if (!next) return fetch(url, init);
                currentProxy = next;
                attempt += 1;
                continue;
            }
            throw err;
        }

        if (
            (response.status === 403 || response.status === 407) &&
            attempt < MAX_PROXY_ROTATIONS
        ) {
            logProxyEvent(
                `http-${response.status}`,
                url,
                currentProxy.label,
                response.statusText,
            );
            invalidatePlaudProxy(currentProxy);

            const next = await getPlaudProxyUrl();
            if (!next) return response;
            await response.body?.cancel().catch(() => undefined);
            currentProxy = next;
            attempt += 1;
            continue;
        }

        return response;
    }
}

/** Why `fetchUrlWithLimit` gave up: the body passed the cap, or a non-2xx status. */
export class RemoteDownloadError extends Error {
    constructor(
        readonly reason: "too_large" | "http_error",
        readonly status?: number,
    ) {
        super(
            reason === "too_large"
                ? "Download exceeds the size limit"
                : `Download failed with HTTP ${status}`,
        );
        this.name = "RemoteDownloadError";
    }
}

/**
 * Download a URL through `plaudFetch` with a byte cap. Rejects before reading
 * the body when `Content-Length` is above the cap, and aborts the request
 * once the streamed byte count passes it (missing or false `Content-Length`).
 */
export async function fetchUrlWithLimit(
    url: string,
    maxBytes: number,
): Promise<{ buffer: Buffer; contentType: string | null }> {
    const controller = new AbortController();
    const response = await plaudFetch(url, { signal: controller.signal });
    if (!response.ok) {
        await response.body?.cancel().catch(() => undefined);
        throw new RemoteDownloadError("http_error", response.status);
    }

    const declared = Number(response.headers.get("content-length"));
    if (Number.isFinite(declared) && declared > maxBytes) {
        controller.abort();
        throw new RemoteDownloadError("too_large");
    }

    const contentType = response.headers.get("content-type");
    const reader = response.body?.getReader();
    if (!reader) return { buffer: Buffer.alloc(0), contentType };

    const chunks: Uint8Array[] = [];
    let total = 0;
    while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > maxBytes) {
            await reader.cancel().catch(() => undefined);
            controller.abort();
            throw new RemoteDownloadError("too_large");
        }
        chunks.push(value);
    }
    return { buffer: Buffer.concat(chunks, total), contentType };
}

/**
 * Layer browser-shaped headers under the caller's headers in insertion order.
 * Caller-provided headers always win.
 */
function mergeBrowserHeaders(callerHeaders: HeadersInit | undefined): Headers {
    const out = new Headers();

    out.append(
        "sec-ch-ua",
        '"Google Chrome";v="142", "Chromium";v="142", "Not?A_Brand";v="24"',
    );
    out.append("sec-ch-ua-mobile", "?0");
    out.append("sec-ch-ua-platform", '"Windows"');
    out.append("accept", "application/json, text/plain, */*");
    out.append(
        "user-agent",
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36",
    );
    out.append("origin", PLAUD_WEB_ORIGIN);
    out.append("sec-fetch-site", "same-site");
    out.append("sec-fetch-mode", "cors");
    out.append("sec-fetch-dest", "empty");
    out.append("referer", `${PLAUD_WEB_ORIGIN}/`);
    out.append("accept-encoding", "gzip, deflate, br, zstd");
    out.append("accept-language", "en-US,en;q=0.9");
    out.append("priority", "u=1, i");

    if (callerHeaders) {
        const incoming = new Headers(callerHeaders);
        incoming.forEach((value, key) => {
            out.set(key, value);
        });
    }
    return out;
}

function logProxyEvent(
    kind: string,
    url: string,
    proxyLabel: string,
    detail: string,
): void {
    let host: string;
    try {
        host = new URL(url).host;
    } catch {
        host = "<invalid-url>";
    }
    console.warn(
        `[plaud/proxy] ${kind} via=${proxyLabel} host=${host} detail=${detail}`,
    );
}

/** Test-only: no-op kept for backward compat with existing test imports. */
export function _resetPlaudFetchForTest(): void {
    // Nothing to reset — proxy is now stateless (no agent cache).
}
