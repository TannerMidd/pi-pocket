// ZIP writer: round-trip decode of the archive it builds, and validation of unsafe inputs.
import assert from "node:assert/strict";
import { test } from "node:test";
import { inflateRawSync } from "node:zlib";
import { zip } from "../src/server/zip.ts";

function decode(archive: Buffer): { name: string; bytes: Buffer; method: number }[] {
    // Find the EOCD, then walk the central directory.
    const eocdOffset = archive.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));

    assert.ok(eocdOffset >= 0, "EOCD missing");
    assert.equal(archive.readUInt32LE(eocdOffset), 0x06054b50);
    const count = archive.readUInt16LE(eocdOffset + 10);
    const centralSize = archive.readUInt32LE(eocdOffset + 12);
    const centralStart = archive.readUInt32LE(eocdOffset + 16);

    assert.equal(centralStart + centralSize + 22, archive.length, "EOCD sizes disagree");

    const entries: { name: string; bytes: Buffer; method: number }[] = [];
    let p = centralStart;

    for (let i = 0; i < count; i++) {
        assert.equal(archive.readUInt32LE(p), 0x02014b50, "central signature");
        const method = archive.readUInt16LE(p + 10);
        const crc = archive.readUInt32LE(p + 16);
        const packedSize = archive.readUInt32LE(p + 20);
        const size = archive.readUInt32LE(p + 24);
        const nameLength = archive.readUInt16LE(p + 28);
        const flags = archive.readUInt16LE(p + 8);
        const localOffset = archive.readUInt32LE(p + 42);
        const name = archive.subarray(p + 46, p + 46 + nameLength).toString("utf8");

        // Read the local header for the data.
        assert.equal(archive.readUInt32LE(localOffset), 0x04034b50, "local signature");
        const localNameLength = archive.readUInt16LE(localOffset + 26);
        const dataStart = localOffset + 30 + localNameLength;
        const packed = archive.subarray(dataStart, dataStart + packedSize);

        let bytes: Buffer;

        if (method === 8) {
            bytes = inflateRawSync(packed);
        } else {
            assert.equal(method, 0, "unknown method");
            bytes = Buffer.from(packed);
        }

        assert.equal(bytes.length, size, `size of ${name}`);
        assert.equal(
            packed.length,
            archive.readUInt32LE(localOffset + 18),
            `packed size of ${name}`,
        );
        assert.equal(crc32Of(bytes), crc, `crc of ${name}`);
        assert.notEqual(flags & 0x0800, 0, `utf-8 flag of ${name}`);
        entries.push({ name, bytes, method });
        p += 46 + nameLength;
    }

    return entries;
}

function crc32Of(bytes: Buffer): number {
    let crc = 0xffffffff;

    for (let i = 0; i < bytes.length; i++) {
        crc ^= bytes[i]!;

        for (let bit = 0; bit < 8; bit++) {
            crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
        }
    }

    return ~crc >>> 0;
}

test("zip builds an archive that decodes back to the entries", () => {
    const entries = [
        { name: "hello.txt", bytes: Buffer.from("Hello, world!\n") },
        {
            name: "docs/notes.md",
            bytes: Buffer.from("# Notes\n\nSome longer text that deflates well. ".repeat(20)),
        },
        { name: "empty.bin", bytes: Buffer.alloc(0) },
        { name: "中文/名字.txt", bytes: Buffer.from("utf-8 name\n") },
    ];
    const archive = zip(entries);
    const decoded = decode(archive);

    assert.equal(decoded.length, entries.length);

    for (let i = 0; i < entries.length; i++) {
        assert.equal(decoded[i]!.name, entries[i]!.name);
        assert.ok(decoded[i]!.bytes.equals(entries[i]!.bytes), `bytes of ${entries[i]!.name}`);
    }

    // The repeating markdown entry should deflate; the tiny ones are stored.
    assert.equal(decoded[0]!.method, 0);
    assert.equal(decoded[1]!.method, 8);
    assert.ok(archive.length < entries[1]!.bytes.length);
});

test("zip rejects unsafe paths, duplicates, and ZIP32 bounds", () => {
    const ok = Buffer.from("x");

    assert.throws(() => zip([{ name: "../escape.txt", bytes: ok }]), /unsafe path segment/);
    assert.throws(() => zip([{ name: "a/../../b.txt", bytes: ok }]), /unsafe path segment/);
    assert.throws(() => zip([{ name: "/absolute.txt", bytes: ok }]), /absolute/);
    assert.throws(() => zip([{ name: "C:\\drive.txt", bytes: ok }]), /drive letter/);
    assert.throws(() => zip([{ name: "", bytes: ok }]), /empty or has a NUL/);
    assert.throws(() => zip([{ name: "a.txt\0hidden", bytes: ok }]), /empty or has a NUL/);
    // 22,000 Chinese characters are 66,000 UTF-8 bytes, over the 65,535 byte name field.
    const longName = "中".repeat(22000);

    assert.throws(() => zip([{ name: longName, bytes: ok }]), /too long in UTF-8 bytes/);
    assert.throws(
        () =>
            zip([
                { name: "same.txt", bytes: ok },
                { name: "same.txt", bytes: ok },
            ]),
        /duplicate entry name/,
    );
    assert.throws(
        () =>
            zip(
                new Array(65536)
                    .fill({ name: "a.txt", bytes: ok })
                    .map((e, i) => ({ name: `f${i}.txt`, bytes: ok })),
            ),
        /too many entries/,
    );
});
