/** Downloads for the connectors: only from the hosts a service names, and never more than the cap. */

/** At most `max` bytes of a response, or an error: a larger file is never read to its end. */
export async function bytesOf(response: Response, max: number): Promise<Uint8Array> {
    if (Number(response.headers.get("content-length") ?? 0) > max) {
        await response.body?.cancel();

        throw new Error(`the file is larger than ${Math.round(max / 1048576)} MB`);
    }

    const parts: Uint8Array[] = [];
    let size = 0;

    for await (const part of (response.body ?? []) as AsyncIterable<Uint8Array>) {
        size += part.byteLength;

        if (size > max) {
            throw new Error(`the file is larger than ${Math.round(max / 1048576)} MB`);
        }

        parts.push(part);
    }

    const data = new Uint8Array(size);
    let at = 0;

    for (const part of parts) {
        data.set(part, at);
        at += part.byteLength;
    }

    return data;
}

/**
 * GET `url`, and follow up to 3 redirects, each only to a host `allowed` takes: the headers (a token) go to no other
 * host. Errors name no link.
 */
export async function getFrom(
    url: string,
    allowed: (url: URL) => boolean,
    init: { headers?: Record<string, string>; signal: AbortSignal },
    where: string,
): Promise<Response> {
    let next = url;

    for (let hop = 0; hop <= 3; hop += 1) {
        const parsed = URL.canParse(next) ? new URL(next) : undefined;

        if (parsed === undefined || !allowed(parsed)) {
            throw new Error(`the attachment is not on ${where}`);
        }

        let response: Response;

        try {
            response = await fetch(parsed, { ...init, redirect: "manual" });
        } catch {
            throw new Error(`the download from ${where} failed`);
        }

        const location = response.headers.get("location");

        if (![301, 302, 303, 307, 308].includes(response.status) || location === null) {
            return response;
        }

        await response.body?.cancel();
        next = URL.canParse(location, parsed) ? new URL(location, parsed).href : "";
    }

    throw new Error(`${where} redirected too often`);
}
