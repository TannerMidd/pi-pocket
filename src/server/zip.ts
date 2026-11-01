// Minimal ZIP writer: builds an uncompressed-or-deflated ZIP32 archive in memory, with no dependencies.
import { deflateRawSync } from "node:zlib";

export interface ZipEntry {
    name: string;
    bytes: Buffer;
}

const MAX_ENTRIES = 65535;
const MAX_NAME_BYTES = 65535;
const UINT32_MAX = 0xffffffff;

function crc32(bytes: Buffer): number {
    let crc = 0xffffffff;

    for (let i = 0; i < bytes.length; i++) {
        crc ^= bytes[i]!;

        for (let bit = 0; bit < 8; bit++) {
            crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
        }
    }

    return ~crc >>> 0;
}

function validateName(name: string): void {
    // The name length field counts UTF-8 bytes, and a NUL could hide a suffix from other tools.
    const nameBytes = Buffer.byteLength(name, "utf8");

    if (name.length === 0 || name.includes("\0")) {
        throw new Error("zip: entry name is empty or has a NUL character");
    }

    if (nameBytes > MAX_NAME_BYTES) {
        throw new Error(`zip: entry name too long in UTF-8 bytes: ${nameBytes}`);
    }

    if (name.startsWith("/") || name.startsWith("\\")) {
        throw new Error(`zip: entry name is absolute: ${name}`);
    }

    if (/^[a-zA-Z]:/.test(name)) {
        throw new Error(`zip: entry name has a drive letter: ${name}`);
    }

    const segments = name.split(/[/\\]/);

    for (const segment of segments) {
        if (segment === ".." || segment === ".") {
            throw new Error(`zip: entry name has an unsafe path segment: ${name}`);
        }
    }
}

/**
 * Builds a ZIP32 archive from the given entries. Names are UTF-8, paths are validated,
 * duplicate names are rejected, and data is deflated when that is smaller than stored.
 */
export function zip(entries: ZipEntry[]): Buffer {
    if (entries.length > MAX_ENTRIES) {
        throw new Error(`zip: too many entries: ${entries.length}`);
    }

    const seen = new Set<string>();

    for (const entry of entries) {
        validateName(entry.name);

        if (seen.has(entry.name)) {
            throw new Error(`zip: duplicate entry name: ${entry.name}`);
        }

        seen.add(entry.name);

        if (entry.bytes.length > UINT32_MAX) {
            throw new Error(`zip: entry too large for ZIP32: ${entry.name}`);
        }
    }

    // Fixed DOS timestamp (1980-01-01 00:00:00) keeps output deterministic.
    const dosTime = 0;
    const dosDate = (1 << 5) | 1;

    const localParts: Buffer[] = [];
    const centralParts: Buffer[] = [];
    let offset = 0;

    for (const entry of entries) {
        const nameBytes = Buffer.from(entry.name, "utf8");
        const crc = crc32(entry.bytes);
        const deflated = deflateRawSync(entry.bytes);
        const useDeflate = deflated.length < entry.bytes.length;
        const data = useDeflate ? deflated : entry.bytes;
        const method = useDeflate ? 8 : 0;

        if (offset + data.length > UINT32_MAX) {
            throw new Error(`zip: archive exceeds ZIP32 bounds at entry: ${entry.name}`);
        }

        const local = Buffer.alloc(30);

        local.writeUInt32LE(0x04034b50, 0);
        local.writeUInt16LE(20, 4);
        local.writeUInt16LE(0x0800, 6);
        local.writeUInt16LE(method, 8);
        local.writeUInt16LE(dosTime, 10);
        local.writeUInt16LE(dosDate, 12);
        local.writeUInt32LE(crc, 14);
        local.writeUInt32LE(data.length, 18);
        local.writeUInt32LE(entry.bytes.length, 22);
        local.writeUInt16LE(nameBytes.length, 26);
        local.writeUInt16LE(0, 28);

        const central = Buffer.alloc(46);

        central.writeUInt32LE(0x02014b50, 0);
        central.writeUInt16LE(20, 4);
        central.writeUInt16LE(20, 6);
        central.writeUInt16LE(0x0800, 8);
        central.writeUInt16LE(method, 10);
        central.writeUInt16LE(dosTime, 12);
        central.writeUInt16LE(dosDate, 14);
        central.writeUInt32LE(crc, 16);
        central.writeUInt32LE(data.length, 20);
        central.writeUInt32LE(entry.bytes.length, 24);
        central.writeUInt16LE(nameBytes.length, 28);
        central.writeUInt16LE(0, 30);
        central.writeUInt16LE(0, 32);
        central.writeUInt16LE(0, 34);
        central.writeUInt16LE(0, 36);
        central.writeUInt32LE(0, 38);
        central.writeUInt32LE(offset, 42);

        localParts.push(local, nameBytes, data);
        centralParts.push(central, nameBytes);
        offset += local.length + nameBytes.length + data.length;
    }

    const centralStart = offset;
    let centralSize = 0;

    for (const part of centralParts) {
        centralSize += part.length;
    }

    if (centralStart + centralSize > UINT32_MAX) {
        throw new Error("zip: archive exceeds ZIP32 bounds in central directory");
    }

    const eocd = Buffer.alloc(22);

    eocd.writeUInt32LE(0x06054b50, 0);
    eocd.writeUInt16LE(0, 4);
    eocd.writeUInt16LE(0, 6);
    eocd.writeUInt16LE(entries.length, 8);
    eocd.writeUInt16LE(entries.length, 10);
    eocd.writeUInt32LE(centralSize, 12);
    eocd.writeUInt32LE(centralStart, 16);
    eocd.writeUInt16LE(0, 20);

    return Buffer.concat([...localParts, ...centralParts, eocd]);
}
