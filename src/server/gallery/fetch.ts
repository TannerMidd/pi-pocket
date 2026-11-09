/**
 * Reading from other sites for the gallery: https only, also where a request is sent on, with a size limit kept while
 * the body comes in (whatever its length header says), and a time limit for each request.
 */
import { describe, HttpError } from "../errors.ts";

/** How long one request to another site may take. */
const REQUEST_MS = 20_000;

/** The only hosts that get the owner's GitHub token: GitHub's own, over https. Checked again on each redirect. */
const GITHUB_HOSTS = new Set(["github.com", "api.github.com", "raw.githubusercontent.com"]);
/**
 * A token as it can go in a header: visible ASCII only. Anything else (a line break, a space, a character past U+00FF)
 * makes `fetch` throw an error that quotes the header, token and all.
 */
const TOKEN = /^[\x21-\x7e]+$/;

/**
 * What a failed answer from GitHub means for a private repository, to add to the error: GitHub answers 404 for one that
 * a request cannot see. `withToken` is GitHub's answer to the token, once it refused it in this download. Never
 * the token itself.
 */
function githubHint(host: string, status: number, withToken: number | undefined): string {
    if (!GITHUB_HOSTS.has(host) || (status !== 404 && status !== 401)) {
        return "";
    }

    if (withToken === 401) {
        return ". GitHub did not accept the GitHub token (401), and without it the repository is not there or is private: check the token (Menu → Extensions → Extension gallery, or gh auth status)";
    }

    if (withToken === 404) {
        return ". With the GitHub token and without it: the repository is not there, or the token cannot read it";
    }

    return ". If the repository is private, give the gallery a GitHub token in its settings (Menu → Extensions → Extension gallery)";
}

/** How the gallery reaches other sites, as `fetch` does: tests and local copies stand in for it. */
export type Fetcher = (url: string, init: RequestInit) => Promise<Response>;

/**
 * Get `url`'s body, `limit` bytes at most: https only, also where it redirects to (three times at most, and only on its
 * own host when `sameHost`), each request within `REQUEST_MS`, through `fetcher`. `what` names it in errors; `large` is
 * the error for a body past `limit`. `token`, a GitHub token, goes only to GitHub's hosts (`GITHUB_HOSTS`), so a private
 * index or repository can be read; a redirect to any other host gets no token. A token that cannot go in a header
 * (`TOKEN`) fails a request to GitHub with an error that does not show it.
 */
export async function download(
    fetcher: Fetcher,
    url: string,
    limit: number,
    what: string,
    options: {
        signal?: AbortSignal;
        large?: () => HttpError;
        sameHost?: boolean;
        token?: string;
    } = {},
): Promise<Uint8Array> {
    const { signal, sameHost = false, token } = options;
    const large =
        options.large ?? (() => new HttpError(502, `${what} is larger than ${limit} bytes`));
    const host = new URL(url).host;
    let address = url;
    // What GitHub answered to the token (401 or 404) once it refused it in this download: the requests after it go
    // without it, and the error says that a token was given.
    let refused: number | undefined;

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

        const authorized =
            token !== undefined &&
            token !== "" &&
            refused === undefined &&
            GITHUB_HOSTS.has(target.host);

        if (authorized && !TOKEN.test(token)) {
            throw new HttpError(
                400,
                `${what}: the GitHub token in the gallery's settings has a space, a line break, or another character that a token cannot have. Paste it again (Menu → Extensions → Extension gallery)`,
            );
        }

        const late = () => new HttpError(502, `${what}: ${target.host} took too long to answer`);
        // The time limit of the request sent last: its body is read within it too.
        let stop = AbortSignal.abort();

        const send = async (withToken: boolean): Promise<Response> => {
            stop = AbortSignal.any([
                AbortSignal.timeout(REQUEST_MS),
                ...(signal === undefined ? [] : [signal]),
            ]);

            try {
                return await fetcher(address, {
                    redirect: "manual",
                    signal: stop,
                    headers: {
                        "user-agent": "pi-pocket",
                        ...(withToken ? { authorization: `Bearer ${token}` } : {}),
                    },
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
        };

        let response = await send(authorized);

        // GitHub answers 401 for a token it does not take (expired, revoked), and 404 for a repository that the token
        // cannot read, also a public one. Neither should stop a public index or repository: ask once more, without
        // the token, and send none for the rest of this download.
        if (authorized && (response.status === 401 || response.status === 404)) {
            await response.body?.cancel().catch(() => {});
            refused = response.status;
            response = await send(false);
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
                `${what}: ${target.host} answered ${response.status} for ${target.pathname}${githubHint(target.host, response.status, refused)}`,
            );
        }

        if (
            response.headers.get("content-encoding") === null &&
            Number(response.headers.get("content-length")) > limit
        ) {
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
