/**
 * Reading from other sites for the gallery: https only, also where a request is sent on, with a size limit kept while
 * the body comes in (whatever its length header says), and a time limit for each request.
 */
import { describe, HttpError } from "../errors.ts";

/** How long one request to another site may take. */
const REQUEST_MS = 20_000;

/** How the gallery reaches other sites, as `fetch` does: tests and local copies stand in for it. */
export type Fetcher = (url: string, init: RequestInit) => Promise<Response>;

/**
 * Get `url`'s body, `limit` bytes at most: https only, also where it redirects to (three times at most, and only on its
 * own host when `sameHost`), each request within `REQUEST_MS`, through `fetcher`. `what` names it in errors; `large` is
 * the error for a body past `limit`.
 */
export async function download(
    fetcher: Fetcher,
    url: string,
    limit: number,
    what: string,
    options: { signal?: AbortSignal; large?: () => HttpError; sameHost?: boolean } = {},
): Promise<Uint8Array> {
    const { signal, sameHost = false } = options;
    const large =
        options.large ?? (() => new HttpError(502, `${what} is larger than ${limit} bytes`));
    const host = new URL(url).host;
    let address = url;

    for (let hop = 0; ; hop++) {
        const target = new URL(address);

        if (sameHost && target.host !== host) {
            throw new HttpError(502, `${what}: ${host} sends it on to ${target.host}`);
        }

        if (target.protocol !== "https:") {
            throw new HttpError(
                502,
                `${what}: Pi Pocket reads only https addresses, not ${target.protocol}//${target.host}`,
            );
        }

        const stop = AbortSignal.any([
            AbortSignal.timeout(REQUEST_MS),
            ...(signal === undefined ? [] : [signal]),
        ]);
        const late = () => new HttpError(502, `${what}: ${target.host} took too long to answer`);
        let response: Response;

        try {
            response = await fetcher(address, {
                redirect: "manual",
                signal: stop,
                headers: { "user-agent": "pi-pocket" },
            });
        } catch (error) {
            const cause = (error as { cause?: unknown }).cause;

            throw stop.aborted
                ? late()
                : new HttpError(
                      502,
                      `${what}: could not reach ${target.host} (${describe(cause ?? error)})`,
                  );
        }

        if ([301, 302, 303, 307, 308].includes(response.status)) {
            await response.body?.cancel().catch(() => {});
            const location = response.headers.get("location");

            if (location === null || hop >= 3) {
                throw new HttpError(502, `${what}: ${target.host} sends it on too many times`);
            }

            address = new URL(location, address).href;
            continue;
        }

        if (!response.ok) {
            await response.body?.cancel().catch(() => {});

            throw new HttpError(
                502,
                `${what}: ${target.host} answered ${response.status} for ${target.pathname}`,
            );
        }

        if (Number(response.headers.get("content-length")) > limit) {
            await response.body?.cancel().catch(() => {});

            throw large();
        }

        const chunks: Uint8Array[] = [];
        let total = 0;
        const reader = response.body?.getReader();

        try {
            for (;;) {
                const chunk = await reader?.read();

                if (chunk === undefined || chunk.done) {
                    break;
                }

                total += chunk.value.byteLength;

                if (total > limit) {
                    await reader?.cancel().catch(() => {});

                    throw large();
                }

                chunks.push(chunk.value);
            }
        } catch (error) {
            throw error instanceof HttpError
                ? error
                : stop.aborted
                  ? late()
                  : new HttpError(502, `${what}: the download broke off`);
        }

        return Buffer.concat(chunks);
    }
}
