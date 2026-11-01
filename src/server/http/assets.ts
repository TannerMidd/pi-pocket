/** The web app's own files and the modules it imports, its content security policy, and image files it shows. */
import { createHash } from "node:crypto";
import { closeSync, createReadStream, openSync, readFileSync, readSync, statSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { extname, join, posix } from "node:path";
import { APP_ROOT, modulesWith } from "../config.ts";
import { HttpError } from "../errors.ts";
import {
    accepted,
    compressFile,
    compressible,
    type Encoding,
    MIN_COMPRESS_BYTES,
} from "./compress.ts";
import { send } from "./io.ts";

export const WEB = join(APP_ROOT, "web");
/** A file of a package, wherever npm put the package. */
const vendor = (name: string, ...path: string[]) => join(modulesWith(name), name, ...path);

export const VENDOR: Record<string, string> = {
    "preact.mjs": vendor("preact", "dist", "preact.mjs"),
    "preact-hooks.mjs": vendor("preact", "hooks", "dist", "hooks.mjs"),
    "htm.mjs": vendor("htm", "dist", "htm.module.js"),
    "marked.mjs": vendor("marked", "lib", "marked.esm.js"),
    "purify.mjs": vendor("dompurify", "dist", "purify.es.mjs"),
};

export const TYPES: Record<string, string> = {
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".mjs": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".json": "application/json",
    ".webmanifest": "application/manifest+json",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".gif": "image/gif",
    ".webp": "image/webp",
    ".woff2": "font/woff2",
    ".pdf": "application/pdf",
    ".txt": "text/plain; charset=utf-8",
    ".md": "text/markdown; charset=utf-8",
};

/** File types the image route shows; the bytes must match too (see `sniffImage`). */
const IMAGE_EXTENSIONS = new Set([
    ".png",
    ".jpg",
    ".jpeg",
    ".gif",
    ".webp",
    ".avif",
    ".bmp",
    ".ico",
    ".svg",
]);
const MAX_IMAGE_FILE = 25 * 1024 * 1024;
/** Opened on its own, an SVG could run script: give it an opaque origin and nothing to load. */
const IMAGE_CSP =
    "sandbox; default-src 'none'; img-src data:; style-src 'unsafe-inline'; font-src data:";

/** The image type of a file's first bytes, or undefined when it is not an image this app shows. */
export function sniffImage(head: Buffer): string | undefined {
    const ascii = (start: number, text: string) =>
        head.subarray(start, start + text.length).toString("latin1") === text;

    if (head[0] === 0x89 && ascii(1, "PNG\r\n\x1a\n")) {
        return "image/png";
    }

    if (head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) {
        return "image/jpeg";
    }

    if (ascii(0, "GIF87a") || ascii(0, "GIF89a")) {
        return "image/gif";
    }

    if (ascii(0, "RIFF") && ascii(8, "WEBP")) {
        return "image/webp";
    }

    if (ascii(4, "ftypavif") || ascii(4, "ftypavis")) {
        return "image/avif";
    }

    if (ascii(0, "BM")) {
        return "image/bmp";
    }

    if (head[0] === 0 && head[1] === 0 && head[2] === 1 && head[3] === 0) {
        return "image/x-icon";
    }

    const text = head
        .toString("utf8")
        .replace(/^\uFEFF/, "")
        .trimStart();

    if (text.startsWith("<") && /<svg[\s>]/i.test(text)) {
        return "image/svg+xml";
    }

    return undefined;
}

/**
 * The app page's policy. Replies show markdown that Pi wrote, and what Pi writes can be steered by any file or page it
 * reads: nothing on the page may load from, send to, or post to another site. The inline import map is allowed by hash.
 */
function appPolicy(html: string): string {
    // Browsers hash script text after turning CRLF and CR into LF, as their HTML parser does.
    const hashes = [...html.matchAll(/<script(?![^>]*\ssrc=)[^>]*>([\s\S]*?)<\/script>/gi)].map(
        (match) =>
            `'sha256-${createHash("sha256").update(match[1]!.replace(/\r\n?/g, "\n")).digest("base64")}'`,
    );

    return [
        "default-src 'self'",
        ["script-src 'self'", ...hashes].join(" "),
        "style-src 'self' 'unsafe-inline'",
        "img-src 'self' data: blob:",
        "media-src 'self' data: blob:",
        "connect-src 'self'",
        "frame-src 'self'",
        "worker-src 'self'",
        "object-src 'none'",
        "base-uri 'none'",
        "form-action 'self'",
        "frame-ancestors 'self'",
    ].join("; ");
}

/** A file as last read: its bytes, a hash of them, and the same compressed once each way a browser asked for. */
interface ReadFile {
    /** The file's identity, size, and time of change when read: any edit changes it. */
    stamp: string;
    body: Buffer;
    hash: string;
    encoded: Map<Encoding, Promise<Buffer>>;
    /** The addresses of the modules it imports as it stands, once asked for (`preloads`). */
    imports?: string[];
}

/** The web app's files and the vendored modules served so far, each as last read. */
const readFiles = new Map<string, ReadFile>();

/** A file as it is now: as last read when its size and times are the same, else read again. Throws when it is not there. */
function readNow(file: string): ReadFile {
    const stats = statSync(file, { bigint: true });
    const stamp = `${stats.dev}:${stats.ino}:${stats.size}:${stats.mtimeNs}:${stats.ctimeNs}`;
    const known = readFiles.get(file);

    if (known?.stamp === stamp) {
        return known;
    }

    const body = readFileSync(file);
    // A file changed this moment may change again within the file system's clock tick, with the same size and times: it
    // is read again for each request until it has been still for a while.
    const settled = Date.now() - Number(stats.mtimeNs / 1_000_000n) > 2000;
    const read: ReadFile = {
        stamp,
        body,
        hash: createHash("sha256").update(body).digest("hex").slice(0, 24),
        encoded: new Map(),
    };

    if (settled) {
        readFiles.set(file, read);
    } else {
        readFiles.delete(file);
    }

    return read;
}

/** Where a module address (`/chat.js`, `/vendor/preact.mjs`) is on disk. */
function moduleFile(address: string): string | undefined {
    const vendor = /^\/vendor\/([^/]+)$/.exec(address)?.[1];

    if (vendor !== undefined) {
        return VENDOR[vendor];
    }

    return address.endsWith(".js") ? join(WEB, address) : undefined;
}

/** What a module imports at its start: `import … from "x"`, `export … from "x"`, and `import "x"`, not `import(…)`. */
const STATIC_IMPORT =
    /(?:^|\n)\s*(?:import|export)\b[^"'`;()]*?\bfrom\s*"([^"]+)"|(?:^|\n)\s*import\s*"([^"]+)"/g;

/**
 * Every module the app loads before it runs, the app's own and the vendored ones, found from `/app.js` by the imports as
 * the files are now. The page lists them so the browser fetches them all at once, not each as the one before it arrives.
 */
function preloads(imports: Record<string, string>): string[] {
    const found = new Set<string>();

    const visit = (address: string) => {
        if (found.has(address)) {
            return;
        }

        found.add(address);
        const file = moduleFile(address);

        if (file === undefined) {
            return;
        }

        try {
            const read = readNow(file);

            read.imports ??= [...read.body.toString("utf8").matchAll(STATIC_IMPORT)].map(
                (match) => match[1] ?? match[2]!,
            );

            for (const specifier of read.imports) {
                const target = specifier.startsWith(".")
                    ? posix.join(posix.dirname(address), specifier)
                    : imports[specifier];

                if (target !== undefined) {
                    visit(target);
                }
            }
        } catch {
            // A file that is not there fails the page's own import, with its own error.
        }
    };

    visit("/app.js");

    return [...found];
}

/** The app page, with its content security policy, and the modules it loads listed for the browser to fetch at once. */
export function serveApp(response: ServerResponse, icon: string | null = null): void {
    let body: string;

    try {
        body = readFileSync(join(WEB, "index.html"), "utf8");
    } catch {
        send(response, 404, "Not found");

        return;
    }

    // The home-screen icon in the colors this browser chose, in the page as it is served (`http/icon-route.ts`).
    if (icon !== null) {
        body = body.replace(
            '<link rel="apple-touch-icon" href="/apple-touch-icon.png" />',
            () => `<link rel="apple-touch-icon" href="${icon}" />`,
        );
    }

    // The policy is of the page as it is stored: links are not scripts, and add nothing to it.
    const policy = appPolicy(body);

    try {
        const map = /<script type="importmap">([\s\S]*?)<\/script>/.exec(body)?.[1];
        const imports = (map === undefined ? {} : JSON.parse(map).imports) as Record<
            string,
            string
        >;
        const links = preloads(imports)
            .map((address) => `<link rel="modulepreload" href="${address}" />`)
            .join("");

        body = body.replace("</head>", () => `${links}</head>`);
    } catch {
        // The page as it is: the browser finds the modules as it runs them.
    }

    send(response, 200, body, "text/html; charset=utf-8", {
        "cache-control": "no-cache",
        "content-security-policy": policy,
    });
}

/**
 * A file of the web app. The app is edited live, so the browser asks each time whether its copy is still the newest (`no-cache`):
 * the answer is a short "not modified" while the file's bytes are the same (the ETag is their hash), else the file. Text
 * goes compressed, compressed once for each edit.
 */
export async function serveFile(
    request: IncomingMessage,
    response: ServerResponse,
    file: string,
    fallbackType?: string,
): Promise<void> {
    let read: ReadFile;

    try {
        read = readNow(file);
    } catch {
        send(response, 404, "Not found");

        return;
    }

    const type = fallbackType ?? TYPES[extname(file).toLowerCase()] ?? "application/octet-stream";
    const encoding =
        compressible(type) && read.body.length >= MIN_COMPRESS_BYTES
            ? accepted(request)
            : undefined;
    const headers: Record<string, string> = {
        "content-type": type,
        "cache-control": "no-cache",
        etag: `"${read.hash}${encoding === undefined ? "" : `-${encoding}`}"`,
        ...(compressible(type) ? { vary: "accept-encoding" } : {}),
    };

    // Any encoding of the same bytes will do: the browser keeps them decoded.
    const tags = String(request.headers["if-none-match"] ?? "")
        .split(",")
        .map((tag) =>
            tag
                .trim()
                .replace(/^W\//, "")
                .replace(/-(br|gzip)"$/, '"'),
        );

    if (tags.includes(`"${read.hash}"`)) {
        response.writeHead(304, headers);
        response.end();

        return;
    }

    let body = read.body;

    if (encoding !== undefined) {
        let encoded = read.encoded.get(encoding);

        if (encoded === undefined) {
            encoded = compressFile(read.body, encoding);
            read.encoded.set(encoding, encoded);
        }

        try {
            body = await encoded;
            headers["content-encoding"] = encoding;
        } catch {
            // Sent as it is, then; the next request tries again.
            read.encoded.delete(encoding);
            headers.etag = `"${read.hash}"`;
        }
    }

    response.writeHead(200, { ...headers, "content-length": String(body.length) });
    response.end(body);
}

/** An image file from this machine, for `![alt](path)` in replies and for uploaded attachments. */
export function serveImage(request: IncomingMessage, response: ServerResponse, file: string): void {
    if (!IMAGE_EXTENSIONS.has(extname(file).toLowerCase())) {
        throw new HttpError(415, "Only image files can be shown");
    }

    let size: number;
    let mtime: number;
    let type: string | undefined;

    try {
        const stats = statSync(file);

        if (!stats.isFile()) {
            throw new Error("not a file");
        }

        size = stats.size;
        mtime = stats.mtimeMs;
        const head = Buffer.alloc(1024);
        const fd = openSync(file, "r");

        try {
            type = sniffImage(head.subarray(0, readSync(fd, head, 0, head.length, 0)));
        } finally {
            closeSync(fd);
        }
    } catch {
        throw new HttpError(404, "Image not found");
    }

    if (type === undefined) {
        throw new HttpError(415, "That file is not an image");
    }

    if (size > MAX_IMAGE_FILE) {
        throw new HttpError(413, "Image too large to show");
    }

    const etag = `"${size.toString(36)}-${Math.floor(mtime).toString(36)}"`;
    const headers = {
        etag,
        "cache-control": "private, no-cache",
        "content-security-policy": IMAGE_CSP,
    };

    if (request.headers["if-none-match"] === etag) {
        response.writeHead(304, headers);
        response.end();

        return;
    }

    response.writeHead(200, {
        ...headers,
        "content-type": type,
        "content-length": String(size),
    });
    createReadStream(file)
        .on("error", () => response.destroy())
        .pipe(response);
}
