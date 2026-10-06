/** Addresses for the built-in browser: what people and Pi type, made into URLs, and URLs made short to show. */
import { homedir } from "node:os";
import { posix, win32 } from "node:path";
import { pathToFileURL } from "node:url";

/** Host names that are this machine or the local network, where plain http is the likely scheme. */
function localHost(host: string): boolean {
    const name = host.toLowerCase().replace(/^\[|\]$/g, "");

    return (
        name === "localhost" ||
        name.endsWith(".localhost") ||
        name.endsWith(".local") ||
        name.endsWith(".lan") ||
        name.endsWith(".internal") ||
        name.endsWith(".home.arpa") ||
        name === "::1" ||
        name === "0.0.0.0" ||
        /^127\./.test(name) ||
        /^10\./.test(name) ||
        /^192\.168\./.test(name) ||
        /^172\.(1[6-9]|2\d|3[01])\./.test(name) ||
        /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(name) ||
        // One label, as `myserver:8080`: a name on the local network.
        !name.includes(".")
    );
}

/** Paths as people write them: absolute, from the home folder, or from the current folder. */
const POSIX_PATH = /^(\/|~\/|~$|\.\.?\/)/;
/** On Windows also `C:\site`, `C:/site`, `\\server\share`, `.\site`, and `~\site`. */
const WINDOWS_PATH = /^(\/|\\|[a-z]:[\\/]|~[\\/]|~$|\.\.?[\\/])/i;

/**
 * An address as people and Pi type it, as a URL the browser may open. `localhost:5173` and other local addresses
 * become http, other bare host names https. With `trusted` (Pi, or the owner), paths to files on this machine become
 * file URLs, and file and data URLs are allowed. Undefined for anything else, such as `javascript:` or `chrome:` URLs.
 * `windows` reads paths as Windows does (the default on Windows).
 */
export function normalizeUrl(
    input: string,
    options: { trusted?: boolean; cwd?: string; windows?: boolean } = {},
): string | undefined {
    const text = input.trim();

    if (text === "") {
        return undefined;
    }

    if (text === "about:blank") {
        return text;
    }

    const windows = options.windows ?? process.platform === "win32";

    if ((windows ? WINDOWS_PATH : POSIX_PATH).test(text)) {
        if (options.trusted !== true) {
            return undefined;
        }

        const paths = windows ? win32 : posix;
        const home = text === "~" || /^~[\\/]/.test(text);
        const path = paths.resolve(
            options.cwd ?? process.cwd(),
            home ? homedir() + text.slice(1) : text,
        );

        return pathToFileURL(path, { windows }).href;
    }

    // A backslash is no part of a web address: browsers read it as a slash, which turns `.\site` into a host named ".".
    if (/^[^:]*\\/.test(text)) {
        return undefined;
    }

    // `host:port`, which looks like a scheme followed by a path.
    const hostPort = /^([^\s/:?#]+|\[[0-9a-f:]+\]):(\d{1,5})(?=$|[/?#])/i.exec(text);
    const scheme =
        hostPort === null ? /^([a-z][a-z0-9+.-]*):/i.exec(text)?.[1]?.toLowerCase() : undefined;
    let candidate: string;

    if (scheme === undefined) {
        // Words with spaces are a search, which this browser does not do.
        if (/\s/.test(text)) {
            return undefined;
        }

        const host = hostPort?.[1] ?? /^[^/?#]+/.exec(text)?.[0] ?? "";
        const bare = host.replace(/:\d+$/, "");

        // A bare word is not an address unless it names a local machine with a port.
        if (
            hostPort === null &&
            !bare.includes(".") &&
            bare !== "localhost" &&
            !bare.startsWith("[")
        ) {
            return undefined;
        }

        candidate = `${localHost(bare) ? "http" : "https"}://${text}`;
    } else if (scheme === "http" || scheme === "https") {
        candidate = text;
    } else if ((scheme === "file" || scheme === "data") && options.trusted === true) {
        candidate = text;
    } else {
        return undefined;
    }

    try {
        const url = new URL(candidate);

        if (url.protocol === "http:" || url.protocol === "https:") {
            // A name made of labels (letters, digits, hyphens) with dots between, or an IPv6 address.
            const host = url.hostname;

            if (
                !host.startsWith("[") &&
                !/^[a-z0-9_]([a-z0-9_-]*[a-z0-9_])?(\.[a-z0-9_]([a-z0-9_-]*[a-z0-9_])?)*\.?$/i.test(
                    host,
                )
            ) {
                return undefined;
            }
        }

        return url.href;
    } catch {
        return undefined;
    }
}

/** An address as the address bar shows it: without `http://` and a lone trailing slash. */
export function displayUrl(url: string): string {
    if (url === "" || url === "about:blank") {
        return "";
    }

    return url.replace(/^https?:\/\//, "").replace(/^([^/?#]+)\/$/, "$1");
}
