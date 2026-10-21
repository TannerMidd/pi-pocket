/**
 * Compression of what the server sends, as each browser accepts it (`Accept-Encoding`): brotli, else gzip. A whole
 * answer is compressed at once (`compressed`, used by `send`); an event stream goes through one compressor for its whole
 * life, flushed after each event, so each event reaches the tab at once and later ones refer back to earlier ones.
 */
import type { IncomingMessage } from "node:http";
import {
    type BrotliCompress,
    brotliCompress,
    brotliCompressSync,
    constants,
    createBrotliCompress,
    createGzip,
    type Gzip,
    gzip,
    gzipSync,
} from "node:zlib";

export type Encoding = "br" | "gzip";

/** Smaller answers are sent as they are: compressing them saves next to nothing. */
export const MIN_COMPRESS_BYTES = 1024;

/** Types worth compressing: text. Images, fonts, and archives are compressed already. */
export function compressible(type: string): boolean {
    return /^(text\/|application\/(json|javascript|manifest\+json|xml)|image\/svg\+xml)/i.test(
        type,
    );
}

/** The encoding to send a request's answer in: brotli, else gzip, unless the browser takes neither. */
export function accepted(request: IncomingMessage | undefined): Encoding | undefined {
    const header = request?.headers["accept-encoding"];

    if (typeof header !== "string") {
        return undefined;
    }

    const weights = new Map<string, number>();

    for (const part of header.toLowerCase().split(",")) {
        const [name = "", ...params] = part.split(";").map((each) => each.trim());
        const q = params.find((param) => param.startsWith("q="));

        weights.set(name, q === undefined ? 1 : Number(q.slice(2)) || 0);
    }

    const weight = (name: string) => weights.get(name) ?? weights.get("*") ?? 0;

    if (weight("br") > 0 && weight("br") >= weight("gzip")) {
        return "br";
    }

    return weight("gzip") > 0 ? "gzip" : undefined;
}

/**
 * Brotli's quality: 4 for answers made for one request (about as fast as gzip, and smaller), 6 for files kept once
 * compressed (11 would be a tenth smaller, but takes a large stylesheet's first load after each edit 70 times longer).
 */
const brotli = (quality: number, size?: number) => ({
    params: {
        [constants.BROTLI_PARAM_QUALITY]: quality,
        ...(size === undefined ? {} : { [constants.BROTLI_PARAM_SIZE_HINT]: size }),
    },
});

/** An answer made for one request, compressed at once. */
export function compressed(body: Buffer | string, encoding: Encoding): Buffer {
    return encoding === "br"
        ? brotliCompressSync(body, brotli(4, Buffer.byteLength(body)))
        : gzipSync(body, { level: 6 });
}

/** A file's bytes, compressed off the main thread, to keep. */
export function compressFile(body: Buffer, encoding: Encoding): Promise<Buffer> {
    return new Promise((resolve, reject) => {
        const done = (error: Error | null, result: Buffer) =>
            error === null ? resolve(result) : reject(error);

        if (encoding === "br") {
            brotliCompress(body, brotli(6, body.length), done);
        } else {
            gzip(body, { level: 9 }, done);
        }
    });
}

/**
 * A compressor for an event stream, and how to flush it so that all written so far goes out. Brotli keeps a 1 MB
 * window (not its 4 MB default) per open stream.
 */
export function streamCompressor(encoding: Encoding): {
    stream: Gzip | BrotliCompress;
    flush: number;
} {
    return encoding === "br"
        ? {
              stream: createBrotliCompress({
                  params: {
                      [constants.BROTLI_PARAM_QUALITY]: 4,
                      [constants.BROTLI_PARAM_LGWIN]: 20,
                  },
              }),
              flush: constants.BROTLI_OPERATION_FLUSH,
          }
        : { stream: createGzip({ level: 6 }), flush: constants.Z_SYNC_FLUSH };
}
