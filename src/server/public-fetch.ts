// Fetch for addresses that came from outside (a model, a page, a person): refuses non-public ranges and this
// machine's current interface addresses. Checks literal addresses and every DNS answer where the connection is made,
// preventing DNS rebinding to a refused address. Public addresses that route back into the network through NAT
// reflection or internal public ranges are not detected.
import { lookup as dnsLookup } from "node:dns";
import type { LookupAddress } from "node:dns";
import { BlockList, isIP } from "node:net";
import { networkInterfaces } from "node:os";
import * as undici from "undici";

/** What `host.fetchPublic` takes besides the address: a part of fetch's own init, and its limits. */
export interface PublicFetchInit {
    method?: string;
    headers?: Record<string, string> | [string, string][] | Headers;
    /** Kept as it is, so a 307 or 308 redirect can send it again. */
    body?: string | Uint8Array;
    signal?: AbortSignal;
    /** `"follow"` (default) checks each address it goes to; `"manual"` gives the redirect; `"error"` throws on one. */
    redirect?: "follow" | "manual" | "error";
    /** Redirects to follow at most: 5 by default, 20 at most. */
    maxRedirects?: number;
    /** The body's size at most, decoded, in bytes: 10 MiB by default. A larger body errors when it is read. */
    maxBytes?: number;
    /** The whole request at most, body included, in milliseconds: 30 s by default. */
    timeoutMs?: number;
}

/** Why a fetch was refused, as the `code` of its error. */
export type PublicFetchCode = "POCKET_NOT_PUBLIC" | "POCKET_TOO_LARGE" | "POCKET_REDIRECTS";

export const PUBLIC_FETCH_LIMITS = {
    maxRedirects: 5,
    maxRedirectsCeiling: 20,
    maxBytes: 10 * 1024 * 1024,
    timeoutMs: 30_000,
} as const;

function refused(code: PublicFetchCode, message: string): Error {
    return Object.assign(new Error(message), { code });
}

// Non-public ranges: loopback, private networks, shared and link-local ones, and the
// ranges set apart for documentation, benchmarks, multicast, and later use (IANA's special-purpose registries).
const V4: [string, number][] = [
    ["0.0.0.0", 8],
    ["10.0.0.0", 8],
    ["100.64.0.0", 10],
    ["127.0.0.0", 8],
    ["169.254.0.0", 16],
    ["172.16.0.0", 12],
    ["192.0.0.0", 24],
    ["192.0.2.0", 24],
    ["192.31.196.0", 24],
    ["192.52.193.0", 24],
    ["192.88.99.0", 24],
    ["192.168.0.0", 16],
    ["192.175.48.0", 24],
    ["198.18.0.0", 15],
    ["198.51.100.0", 24],
    ["203.0.113.0", 24],
    ["224.0.0.0", 4],
    ["240.0.0.0", 4],
];
// IPv6 is public only in 2000::/3, the global unicast range, less the parts of it set apart. That leaves out
// loopback, unique-local, link-local, multicast, NAT64, and IPv4-mapped addresses (checked as IPv4 below).
const V6_GLOBAL: [string, number] = ["2000::", 3];
const V6: [string, number][] = [
    ["2001::", 23],
    ["2001:db8::", 32],
    ["2002::", 16],
    ["3fff::", 20],
];

const notPublic = new BlockList();
const global6 = new BlockList();

for (const [network, prefix] of V4) {
    notPublic.addSubnet(network, prefix, "ipv4");
}

for (const [network, prefix] of V6) {
    notPublic.addSubnet(network, prefix, "ipv6");
}

global6.addSubnet(V6_GLOBAL[0], V6_GLOBAL[1], "ipv6");

/** The IPv4 address an IPv4-mapped IPv6 address (`::ffff:a.b.c.d`) carries, or undefined. */
function mappedV4(address: string): string | undefined {
    let canonical: string;

    try {
        canonical = new URL(`http://[${address}]/`).hostname;
    } catch {
        return undefined;
    }

    const match = /^\[::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})\]$/.exec(canonical);

    if (match === null) {
        return undefined;
    }

    const high = parseInt(match[1] ?? "", 16);
    const low = parseInt(match[2] ?? "", 16);

    return [high >> 8, high & 255, low >> 8, low & 255].join(".");
}

/** Whether an IP address is in a public range, without checking local interfaces or routes. */
export function isPublicAddress(address: string): boolean {
    // A zone (fe80::1%eth0) is only for link-local addresses.
    if (address.includes("%")) {
        return false;
    }

    const family = isIP(address);

    if (family === 4) {
        return !notPublic.check(address, "ipv4");
    }

    if (family === 6) {
        const v4 = mappedV4(address);

        if (v4 !== undefined) {
            return isPublicAddress(v4);
        }

        return global6.check(address, "ipv6") && !notPublic.check(address, "ipv6");
    }

    return false;
}

/** Every address a name resolves to. */
export type Resolve = (hostname: string) => Promise<LookupAddress[]>;

const systemResolve: Resolve = (hostname) =>
    new Promise((resolve, reject) => {
        dnsLookup(hostname, { all: true, order: "verbatim" }, (error, addresses) => {
            if (error) {
                reject(error);
            } else {
                resolve(addresses);
            }
        });
    });

type LookupCallback = (
    error: Error | null,
    address: string | LookupAddress[],
    family?: number,
) => void;

/**
 * A `lookup` for the connection: it resolves the name, refuses it when any of its addresses is not public, and gives
 * the connection only addresses it checked.
 */
function guardedLookup(resolve: Resolve, isPublic: (address: string) => boolean) {
    return (hostname: string, options: unknown, callback: LookupCallback): void => {
        const { family = 0, all = false } =
            typeof options === "object" && options !== null
                ? (options as { family?: number | string; all?: boolean })
                : { family: typeof options === "number" ? options : 0 };
        const wanted = family === "IPv4" ? 4 : family === "IPv6" ? 6 : Number(family) || 0;

        resolve(hostname).then(
            (addresses) => {
                const inside = addresses.find((each) => !isPublic(each.address));

                if (inside !== undefined) {
                    callback(
                        refused(
                            "POCKET_NOT_PUBLIC",
                            `${hostname} resolves to ${inside.address}, which is not a public address`,
                        ),
                        [],
                    );

                    return;
                }

                const usable = addresses.filter((each) => wanted === 0 || each.family === wanted);
                const first = usable[0];

                if (first === undefined) {
                    callback(
                        Object.assign(new Error(`${hostname} has no address`), {
                            code: "ENOTFOUND",
                        }),
                        [],
                    );

                    return;
                }

                if (all) {
                    callback(null, usable);
                } else {
                    callback(null, first.address, first.family);
                }
            },
            (error: Error) => callback(error, []),
        );
    };
}

/** Refuses an address that is not http(s), has a user or password in it, or names an IP that is not public. */
function checkUrl(url: URL, isPublic: (address: string) => boolean): void {
    if (url.protocol !== "http:" && url.protocol !== "https:") {
        throw refused("POCKET_NOT_PUBLIC", `Only http and https addresses: ${url.protocol}`);
    }

    if (url.username !== "" || url.password !== "") {
        throw refused("POCKET_NOT_PUBLIC", "An address with a user or password in it");
    }

    // The URL parser writes IPv4 in its usual form (0x7f.1 is 127.0.0.1); IPv6 comes in brackets.
    const host = url.hostname.replace(/^\[(.*)\]$/, "$1");

    if (isIP(host) !== 0 && !isPublic(host)) {
        throw refused("POCKET_NOT_PUBLIC", `${host} is not a public address`);
    }
}

const REDIRECTS = new Set([301, 302, 303, 307, 308]);
// Fetch writes these methods in capitals, whatever case they come in; it keeps any other method as it is.
const NORMAL_METHODS = new Set(["DELETE", "GET", "HEAD", "OPTIONS", "POST", "PUT"]);
// The headers about a request's body, which go when a redirect drops the body.
const BODY_HEADERS = [
    "content-encoding",
    "content-language",
    "content-location",
    "content-type",
    "content-length",
];

/** The response with the address it came from and whether it was redirected, kept by its clones too. */
function tagged(response: undici.Response, url: string, redirected: boolean): undici.Response {
    const clone = response.clone.bind(response);

    Object.defineProperty(response, "url", { value: url });
    Object.defineProperty(response, "redirected", { value: redirected });
    Object.defineProperty(response, "clone", { value: () => tagged(clone(), url, redirected) });

    return response;
}

/** The body, cut off with an error past `max` bytes. */
function capped(body: ReadableStream<Uint8Array>, max: number): ReadableStream<Uint8Array> {
    let seen = 0;

    return body.pipeThrough(
        new TransformStream<Uint8Array, Uint8Array>({
            transform(chunk, controller) {
                seen += chunk.byteLength;

                if (seen > max) {
                    controller.error(
                        refused("POCKET_TOO_LARGE", `The response is larger than ${max} bytes`),
                    );

                    return;
                }

                controller.enqueue(chunk);
            },
        }),
    );
}

function clamp(value: number | undefined, fallback: number, low: number, high: number): number {
    if (value === undefined || !Number.isFinite(value)) {
        return fallback;
    }

    return Math.min(high, Math.max(low, Math.floor(value)));
}

export interface PublicFetchOptions {
    /** For tests: how names resolve. The system's resolver by default. */
    resolve?: Resolve;
    /** For tests: which addresses count as public. */
    isPublic?: (address: string) => boolean;
    /** For tests: the current network interfaces. Read fresh for each address check. */
    networkInterfaces?: typeof networkInterfaces;
}

export type FetchPublic = (url: string | URL, init?: PublicFetchInit) => Promise<Response>;

/** A fetch that filters addresses, on its own connections (not the HTTP proxy, which resolves names). */
export function createPublicFetch(options: PublicFetchOptions = {}): FetchPublic {
    const inPublicRange = options.isPublic ?? isPublicAddress;
    const interfaces = options.networkInterfaces ?? networkInterfaces;

    const isPublic = (address: string): boolean => {
        if (!inPublicRange(address)) {
            return false;
        }

        // BlockList compares equivalent IPv6 spellings and IPv4-mapped addresses too.
        const own = new BlockList();

        for (const entries of Object.values(interfaces())) {
            for (const entry of entries ?? []) {
                own.addAddress(
                    entry.address.split("%")[0]!,
                    entry.family === "IPv4" ? "ipv4" : "ipv6",
                );
            }
        }

        return !own.check(address, isIP(address) === 4 ? "ipv4" : "ipv6");
    };

    const dispatcher = new undici.Agent({
        connect: { lookup: guardedLookup(options.resolve ?? systemResolve, isPublic) },
    });

    return async (input, init = {}) => {
        let url = new URL(String(input));
        let method = init.method ?? "GET";

        if (NORMAL_METHODS.has(method.toUpperCase())) {
            method = method.toUpperCase();
        }

        let body = init.body;
        const headers = new undici.Headers(init.headers as undici.HeadersInit | undefined);
        const mode = init.redirect ?? "follow";
        const maxRedirects = clamp(
            init.maxRedirects,
            PUBLIC_FETCH_LIMITS.maxRedirects,
            0,
            PUBLIC_FETCH_LIMITS.maxRedirectsCeiling,
        );
        const maxBytes = clamp(
            init.maxBytes,
            PUBLIC_FETCH_LIMITS.maxBytes,
            0,
            Number.MAX_SAFE_INTEGER,
        );
        const timeoutMs = clamp(init.timeoutMs, PUBLIC_FETCH_LIMITS.timeoutMs, 1, 2_147_483_647);
        const signal = AbortSignal.any(
            [init.signal, AbortSignal.timeout(timeoutMs)].filter(
                (each): each is AbortSignal => each !== undefined,
            ),
        );

        for (let hops = 0; ; hops++) {
            checkUrl(url, isPublic);
            let response: undici.Response;

            try {
                response = await undici.fetch(url, {
                    method,
                    headers,
                    body,
                    signal,
                    redirect: "manual",
                    dispatcher,
                });
            } catch (error) {
                // A refusal from the lookup comes wrapped in fetch's own "fetch failed".
                const cause = (error as { cause?: { code?: unknown } }).cause;

                throw cause?.code === "POCKET_NOT_PUBLIC" ? cause : error;
            }

            const location = response.headers.get("location");

            if (!REDIRECTS.has(response.status) || location === null || mode === "manual") {
                // Content-Length counts the body as it is sent: only an unencoded one can fail before it is read.
                const encoding = response.headers.get("content-encoding")?.trim().toLowerCase();
                const length = Number(response.headers.get("content-length"));

                if (
                    response.body !== null &&
                    (encoding === undefined || encoding === "" || encoding === "identity") &&
                    Number.isFinite(length) &&
                    length > maxBytes
                ) {
                    await response.body?.cancel();

                    throw refused(
                        "POCKET_TOO_LARGE",
                        `The response is larger than ${maxBytes} bytes`,
                    );
                }

                const result = new undici.Response(
                    response.body === null
                        ? null
                        : (capped(
                              response.body as ReadableStream<Uint8Array>,
                              maxBytes,
                          ) as undici.BodyInit),
                    {
                        status: response.status,
                        statusText: response.statusText,
                        headers: response.headers,
                    },
                );

                return tagged(result, url.href, hops > 0) as unknown as Response;
            }

            await response.body?.cancel();

            if (mode === "error") {
                throw refused("POCKET_REDIRECTS", `${url.href} redirects, and redirects are off`);
            }

            if (hops >= maxRedirects) {
                throw refused("POCKET_REDIRECTS", `More than ${maxRedirects} redirects`);
            }

            const next = new URL(location, url);

            // As browsers do: a 303 becomes a GET, and so does a POST that a 301 or 302 sends on.
            if (
                (response.status === 303 && method !== "HEAD") ||
                ((response.status === 301 || response.status === 302) && method === "POST")
            ) {
                method = "GET";
                body = undefined;

                for (const name of BODY_HEADERS) {
                    headers.delete(name);
                }
            }

            // Credentials are for the site they were given to.
            if (next.origin !== url.origin) {
                headers.delete("authorization");
                headers.delete("cookie");
                headers.delete("proxy-authorization");
            }

            url = next;
        }
    };
}
