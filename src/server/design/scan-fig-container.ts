import { closeSync, constants, fstatSync, openSync, readSync } from "node:fs";
import { inflateRawSync, inflateSync, zstdDecompressSync } from "node:zlib";
import { quoted } from "../fence.ts";
import {
    type Budget,
    type FigLimits,
    FIG_LIMITS,
    type FigSchema,
    type Obj,
    fail,
    readMessage,
    readSchema,
} from "./scan-fig-kiwi.ts";

const HEADERS = new Set(["fig-kiwi", "fig-jam.", "fig-deck", "fig-make", "fig-site", "fig-buzz"]);

const ZSTD_MAGIC = [0x28, 0xb5, 0x2f, 0xfd];

const EOCD = 0x06054b50;
const CENTRAL = 0x02014b50;
const LOCAL = 0x04034b50;

// Printable ASCII only: the header is repeated in the report.
const oneLine = (text: string): string => text.replace(/[^\x20-\x7e]/g, "?");

// A `.fig` is a Figma file only by its header (MATLAB writes `.fig` files too). 8 bytes are enough.
export function figHeaderReason(bytes: Buffer): string | undefined {
    if (bytes.length === 0) {
        return "the file is empty";
    }

    if (bytes.length >= 2 && bytes[0] === 0x50 && bytes[1] === 0x4b) {
        return undefined;
    }

    return headerReason(bytes);
}

function headerReason(bytes: Buffer): string | undefined {
    const header = bytes.subarray(0, 8).toString("latin1");

    return HEADERS.has(header)
        ? undefined
        : `it is not a Figma file: its first bytes are "${oneLine(header.slice(0, 4))}" and not "fig-kiwi"`;
}

interface ZipEntry {
    name: string;
    method: number;
    compressed: number;
    uncompressed: number;
    offset: number;
}

export interface FigDecoded {
    container: "zip" | "kiwi";
    version: number;
    schema: FigSchema;
    message: Obj;
    nodes: Obj[];
    entries: string[];
    values: number;
}

// A `.fig` holds 2 chunks: the rest is room for a version that adds some.
const MAX_CHUNKS = 8;

function kiwiChunks(bytes: Buffer, limits: FigLimits): { version: number; chunks: Buffer[] } {
    const reason = headerReason(bytes);

    if (reason !== undefined) {
        return fail(reason);
    }

    if (bytes.length < 12) {
        return fail("it ends before its version and its chunks");
    }

    const version = bytes.readUInt32LE(8);
    const chunks: Buffer[] = [];
    let at = 12;
    let total = 0;
    let count = 0;

    while (at + 4 <= bytes.length) {
        const length = bytes.readUInt32LE(at);

        at += 4;

        if (length > bytes.length - at) {
            return fail(
                `a chunk claims ${length} bytes, more than the ${bytes.length - at} left in the file`,
            );
        }

        total += length;

        if (total > limits.raw) {
            return fail(
                `its chunks claim ${total} bytes, more than the ${limits.raw} this scan reads`,
            );
        }

        // A Buffer view for each chunk of 99 MB of empty chunks was 3.4 GB.
        count += 1;

        if (count > MAX_CHUNKS) {
            return fail(`it holds more than ${MAX_CHUNKS} chunks, where a .fig holds 2`);
        }

        if (count <= 2) {
            chunks.push(bytes.subarray(at, at + length));
        }

        at += length;
    }

    return { version, chunks };
}

function zipEntries(bytes: Buffer, limits: FigLimits): ZipEntry[] {
    const floor = Math.max(0, bytes.length - 65_557);
    let end = -1;

    for (let at = bytes.length - 22; at >= floor; at--) {
        if (bytes.readUInt32LE(at) === EOCD) {
            end = at;

            break;
        }
    }

    if (end < 0) {
        return fail("it is a ZIP without a central directory, so its files cannot be listed");
    }

    const count = bytes.readUInt16LE(end + 10);
    const start = bytes.readUInt32LE(end + 16);

    if (count === 0xffff || start === 0xffffffff) {
        return fail("it is a ZIP64 file, which this scan does not read");
    }

    if (count > limits.entries) {
        return fail(`it is a ZIP of ${count} files, more than the ${limits.entries} a .fig has`);
    }

    const entries: ZipEntry[] = [];
    let at = start;

    for (let index = 0; index < count; index++) {
        if (at + 46 > bytes.length || bytes.readUInt32LE(at) !== CENTRAL) {
            return fail("its ZIP central directory is broken");
        }

        const method = bytes.readUInt16LE(at + 10);
        const compressed = bytes.readUInt32LE(at + 20);
        const uncompressed = bytes.readUInt32LE(at + 24);
        const nameLength = bytes.readUInt16LE(at + 28);
        const extraLength = bytes.readUInt16LE(at + 30);
        const commentLength = bytes.readUInt16LE(at + 32);
        const offset = bytes.readUInt32LE(at + 42);

        if (at + 46 + nameLength > bytes.length) {
            return fail("its ZIP central directory ends in the middle of a name");
        }

        entries.push({
            name: bytes.subarray(at + 46, at + 46 + nameLength).toString("utf8"),
            method,
            compressed,
            uncompressed,
            offset,
        });
        at += 46 + nameLength + extraLength + commentLength;
    }

    return entries;
}

// Every inflate of one file pays from one budget, so the peak is that budget and no more.
interface Spend {
    used: number;
}

function left(limits: FigLimits, spend: Spend): number {
    return Math.max(0, limits.raw - spend.used);
}

function zipBytes(bytes: Buffer, entry: ZipEntry, limits: FigLimits, spend: Spend): Buffer {
    const room = left(limits, spend);

    if (entry.uncompressed > room) {
        return fail(
            `its ZIP entry ${quoted(entry.name, 60)} claims ${entry.uncompressed} bytes after decompression, more than the ${room} this scan has left for it`,
        );
    }

    const ceiling = Math.min(room, entry.uncompressed + 1);

    if (entry.offset + 30 > bytes.length || bytes.readUInt32LE(entry.offset) !== LOCAL) {
        return fail(`its ZIP entry ${quoted(entry.name, 60)} has no local header`);
    }

    const nameLength = bytes.readUInt16LE(entry.offset + 26);
    const extraLength = bytes.readUInt16LE(entry.offset + 28);
    const start = entry.offset + 30 + nameLength + extraLength;

    if (start > bytes.length || entry.compressed > bytes.length - start) {
        return fail(`its ZIP entry ${quoted(entry.name, 60)} is cut short`);
    }

    const data = bytes.subarray(start, start + entry.compressed);
    const out =
        entry.method === 0
            ? data
            : entry.method === 8
              ? inflate(data, ceiling, quoted(entry.name, 60))
              : fail(
                    `its ZIP entry ${quoted(entry.name, 60)} uses compression ${entry.method}, which is not deflate`,
                );

    spend.used += out.length;

    return out;
}

// `what` is already quoted when it comes from the file: a name reaches no reason raw.
function inflate(data: Buffer, ceiling: number, what: string): Buffer {
    const zstd =
        data.length >= 4 &&
        ZSTD_MAGIC.every((byte, at) => data[at] === byte) &&
        typeof zstdDecompressSync === "function";

    if (zstd) {
        try {
            return zstdDecompressSync(data, { maxOutputLength: ceiling }) as Buffer;
        } catch (error) {
            return fail(`${what} is zstd that cannot be decompressed (${reasonOf(error)})`);
        }
    }

    for (const decompress of [inflateRawSync, inflateSync]) {
        try {
            return decompress(data, { maxOutputLength: ceiling }) as Buffer;
        } catch {
            // Not this form: the next one is tried.
        }
    }

    return fail(
        `${what} is not deflate data, or it is bigger than the ${ceiling} bytes this scan reads`,
    );
}

const reasonOf = (error: unknown): string =>
    error instanceof Error ? error.message.replace(/\s+/g, " ").slice(0, 160) : "unknown";

function container(
    bytes: Buffer,
    limits: FigLimits,
    spend: Spend,
): { container: "zip" | "kiwi"; version: number; schema: Buffer; data: Buffer; entries: string[] } {
    const zip = bytes.length >= 4 && bytes[0] === 0x50 && bytes[1] === 0x4b;

    if (!zip) {
        const { version, chunks } = kiwiChunks(bytes, limits);

        if (chunks.length < 2) {
            return fail(`it holds ${chunks.length} chunk of data and not the 2 that a .fig has`);
        }

        return {
            container: "kiwi",
            version,
            schema: chunk(chunks[0]!, limits, spend, quoted("its schema", 60)),
            data: chunk(chunks[1]!, limits, spend, quoted("its data", 60)),
            entries: [],
        };
    }

    const entries = zipEntries(bytes, limits);
    const canvas =
        entries.find((entry) => entry.name.toLowerCase() === "canvas.fig") ??
        entries.filter((entry) => /\.fig$/i.test(entry.name)).at(-1);

    if (canvas === undefined) {
        return fail("it is a ZIP with no canvas.fig in it, so it is not a Figma file");
    }

    const inner = zipBytes(bytes, canvas, limits, spend);
    const { version, chunks } = kiwiChunks(inner, limits);

    if (chunks.length < 2) {
        return fail(`its canvas.fig holds ${chunks.length} chunk of data and not 2`);
    }

    return {
        container: "zip",
        version,
        schema: chunk(chunks[0]!, limits, spend, quoted("its schema", 60)),
        data: chunk(chunks[1]!, limits, spend, quoted("its data", 60)),
        entries: entries.map((entry) => entry.name),
    };
}

function chunk(bytes: Buffer, limits: FigLimits, spend: Spend, what: string): Buffer {
    const out = inflate(bytes, left(limits, spend), what);

    spend.used += out.length;

    return out;
}

/** `until` is the deadline of all the scan's Figma files; the default is one file's own limit. */
export function decodeFig(
    bytes: Buffer,
    limits: FigLimits = FIG_LIMITS,
    until: number = Date.now() + limits.ms,
): FigDecoded {
    if (bytes.length === 0) {
        return fail("the file is empty");
    }

    const budget: Budget = {
        limits,
        // The reader stops when `now - started` passes `limits.ms`.
        started: until - limits.ms,
        values: 0,
        decoded: 0,
    };
    const opened = container(bytes, limits, { used: 0 });

    const schema = readSchema(opened.schema, budget);
    const message = readMessage(schema, opened.data, budget);
    const changes = message.nodeChanges;
    const nodes = Array.isArray(changes)
        ? changes.filter((node): node is Obj => typeof node === "object" && node !== null)
        : [];

    return {
        container: opened.container,
        version: opened.version,
        schema,
        message,
        nodes,
        entries: opened.entries,
        values: budget.values,
    };
}

// Never through a link, never a folder or a pipe, and never more than the limit.
export function readFigBytes(path: string, limit: number = FIG_LIMITS.file): Buffer {
    const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);

    try {
        const info = fstatSync(fd);

        if (!info.isFile()) {
            return fail(
                info.isDirectory()
                    ? "it is a folder, and not a Figma file"
                    : "it is not a regular file, and not a Figma file",
            );
        }

        const size = info.size;

        if (size > limit) {
            fail(`it is ${size} bytes, more than the ${limit} bytes this scan reads`);
        }

        const buffer = Buffer.alloc(size);
        let read = 0;

        while (read < size) {
            const got = readSync(fd, buffer, read, size - read, null);

            if (got <= 0) {
                break;
            }

            read += got;
        }

        return buffer.subarray(0, read);
    } finally {
        closeSync(fd);
    }
}
