import assert from "node:assert/strict";
import { posix } from "node:path";
import { test } from "node:test";
import { crc32, deflateSync, inflateRawSync } from "node:zlib";
import { pptx } from "../src/server/design/pptx.ts";

/** A real 16:9 RGB PNG. No image fixtures or image libraries are required. */
function png(): Buffer {
    const chunk = (name: string, bytes: Buffer) => {
        const type = Buffer.from(name);
        const length = Buffer.alloc(4);
        const checksum = Buffer.alloc(4);

        length.writeUInt32BE(bytes.length);
        checksum.writeUInt32BE(crc32(Buffer.concat([type, bytes])));

        return Buffer.concat([length, type, bytes, checksum]);
    };

    const header = Buffer.alloc(13);
    const pixels = Buffer.alloc(9 * (16 * 3 + 1), 0);

    header.writeUInt32BE(16, 0);
    header.writeUInt32BE(9, 4);
    header[8] = 8;
    header[9] = 2;

    for (let y = 0; y < 9; y++) {
        for (let x = 0; x < 16; x++) {
            pixels.set([220, 40, 80], y * 49 + 1 + x * 3);
        }
    }

    return Buffer.concat([
        Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
        chunk("IHDR", header),
        chunk("IDAT", deflateSync(pixels)),
        chunk("IEND", Buffer.alloc(0)),
    ]);
}

const IMAGE = png();

test("custom slide proportions stay unchanged in the presentation and full-bleed image", () => {
    for (const [size, width, height] of [
        [{ width: 1080, height: 1080 }, 12192000, 12192000],
        [{ width: 720, height: 1280 }, 6858000, 12192000],
    ] as const) {
        const parts = unpack(pptx([{ image: IMAGE, text: "Custom slide" }], size));

        assert.ok(
            parts
                .get("ppt/presentation.xml")!
                .toString()
                .includes(`<p:sldSz cx="${width}" cy="${height}" type="custom"/>`),
        );
        assert.ok(
            parts
                .get("ppt/slides/slide1.xml")!
                .toString()
                .includes(`<a:ext cx="${width}" cy="${height}"/>`),
        );
    }

    assert.throws(() => pptx([], { width: 0, height: 1080 }), /aspect ratio/);
    assert.throws(() => pptx([], { width: NaN, height: 1080 }), /aspect ratio/);
});

/** Read central records and independently verify sizes, offsets, local headers, and CRC32. */
function unpack(bytes: Buffer): Map<string, Buffer> {
    const end = bytes.length - 22;

    assert.equal(bytes.readUInt32LE(end), 0x06054b50);
    assert.equal(bytes.readUInt16LE(end + 4), 0);
    assert.equal(bytes.readUInt16LE(end + 6), 0);
    assert.equal(bytes.readUInt16LE(end + 8), bytes.readUInt16LE(end + 10));
    assert.equal(bytes.readUInt16LE(end + 20), 0);

    const count = bytes.readUInt16LE(end + 10);
    const centralSize = bytes.readUInt32LE(end + 12);
    const centralStart = bytes.readUInt32LE(end + 16);
    const result = new Map<string, Buffer>();
    let offset = centralStart;
    let localEnd = 0;

    for (let i = 0; i < count; i++) {
        assert.equal(bytes.readUInt32LE(offset), 0x02014b50);

        const flags = bytes.readUInt16LE(offset + 8);
        const method = bytes.readUInt16LE(offset + 10);
        const checksum = bytes.readUInt32LE(offset + 16);
        const size = bytes.readUInt32LE(offset + 20);
        const originalSize = bytes.readUInt32LE(offset + 24);
        const nameLength = bytes.readUInt16LE(offset + 28);
        const extraLength = bytes.readUInt16LE(offset + 30);
        const commentLength = bytes.readUInt16LE(offset + 32);
        const localOffset = bytes.readUInt32LE(offset + 42);
        const name = bytes.subarray(offset + 46, offset + 46 + nameLength).toString("utf8");

        assert.equal(localOffset, localEnd);
        assert.equal(bytes.readUInt32LE(localOffset), 0x04034b50);
        assert.equal(bytes.readUInt16LE(localOffset + 6), flags);
        assert.equal(bytes.readUInt16LE(localOffset + 8), method);
        assert.equal(flags & 1, 0, "archive is not encrypted");
        assert.equal(flags & 8, 0, "sizes are present in the local header");
        assert.equal(bytes.readUInt32LE(localOffset + 14), checksum);
        assert.equal(bytes.readUInt32LE(localOffset + 18), size);
        assert.equal(bytes.readUInt32LE(localOffset + 22), originalSize);
        assert.equal(bytes.readUInt16LE(localOffset + 26), nameLength);
        assert.equal(
            bytes.subarray(localOffset + 30, localOffset + 30 + nameLength).toString("utf8"),
            name,
        );
        assert.equal(result.has(name), false, `duplicate ZIP entry: ${name}`);
        assert.equal(posix.normalize(name), name);
        assert.equal(name.startsWith("/"), false);
        assert.equal(name.startsWith("../"), false);

        const start = localOffset + 30 + nameLength + bytes.readUInt16LE(localOffset + 28);
        const compressed = bytes.subarray(start, start + size);

        assert.ok(method === 8 || method === 0, "archive uses deflate or store");

        const data = method === 8 ? inflateRawSync(compressed) : compressed;

        assert.equal(data.length, originalSize);
        assert.equal(crc32(data), checksum);
        result.set(name, data);
        localEnd = start + size;
        offset += 46 + nameLength + extraLength + commentLength;
    }

    assert.equal(localEnd, centralStart);
    assert.equal(offset, centralStart + centralSize);
    assert.equal(offset, end);

    return result;
}

function xml(parts: Map<string, Buffer>, name: string): string {
    const bytes = parts.get(name);

    assert.ok(bytes, `missing part: ${name}`);

    const text = bytes.toString("utf8");

    assert.match(text, /^<\?xml version="1.0" encoding="UTF-8" standalone="yes"\?>/);

    return text;
}

function attributes(tag: string): Record<string, string> {
    return Object.fromEntries([...tag.matchAll(/([\w:]+)="([^"]*)"/g)].map((m) => [m[1], m[2]]));
}

function noteLines(notes: string): string[] {
    return [...notes.matchAll(/<a:t\b[^>]*>([\s\S]*?)<\/a:t>/g)].map((match) =>
        match[1]!
            .replace(/&lt;/g, "<")
            .replace(/&gt;/g, ">")
            .replace(/&quot;/g, '"')
            .replace(/&apos;/g, "'")
            .replace(/&amp;/g, "&"),
    );
}

test("PPTX is a deterministic, deflated ZIP with full-bleed 16:9 images", () => {
    const slides = [
        { image: IMAGE, text: "First slide" },
        { image: IMAGE, text: "Second slide" },
    ];
    const bytes = pptx(slides);
    const parts = unpack(bytes);

    assert.ok(Buffer.isBuffer(bytes));
    assert.deepEqual(bytes, pptx(slides));
    assert.equal(parts.size, 23);
    assert.match(
        xml(parts, "ppt/presentation.xml"),
        /<p:sldSz cx="12192000" cy="6858000" type="screen16x9"\/>/,
    );
    assert.equal(
        [...xml(parts, "ppt/presentation.xml").matchAll(/<p:sldId\b/g)].length,
        slides.length,
    );

    for (let n = 1; n <= 2; n++) {
        const slide = xml(parts, `ppt/slides/slide${n}.xml`);

        assert.deepEqual(parts.get(`ppt/media/image${n}.png`), IMAGE);
        assert.match(slide, /<a:off x="0" y="0"\/><a:ext cx="12192000" cy="6858000"\/>/);
        assert.match(slide, /<a:blip r:embed="rId2"\/>/);
        assert.match(slide, /<a:stretch><a:fillRect\/><\/a:stretch>/);
        assert.doesNotMatch(slide, /First slide|Second slide/);
        assert.deepEqual(noteLines(xml(parts, `ppt/notesSlides/notesSlide${n}.xml`)), [
            slides[n - 1]!.text,
        ]);
    }
});

test("all OPC relationships resolve and every part has the correct content type", () => {
    const parts = unpack(pptx([{ image: IMAGE, text: "Notes" }]));
    const contentTypes = xml(parts, "[Content_Types].xml");
    const overrides = new Map(
        [...contentTypes.matchAll(/<Override\b[^>]*\/>/g)].map(([tag]) => {
            const a = attributes(tag);

            return [a.PartName!.slice(1), a.ContentType!];
        }),
    );
    const defaults = new Map(
        [...contentTypes.matchAll(/<Default\b[^>]*\/>/g)].map(([tag]) => {
            const a = attributes(tag);

            return [a.Extension!, a.ContentType!];
        }),
    );

    assert.equal(
        overrides.get("ppt/presentation.xml"),
        "application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml",
    );
    assert.equal(
        overrides.get("ppt/theme/theme1.xml"),
        "application/vnd.openxmlformats-officedocument.theme+xml",
    );
    assert.equal(defaults.get("png"), "image/png");

    for (const name of overrides.keys()) {
        assert.ok(parts.has(name), `content type targets a missing part: ${name}`);
    }

    for (const [name] of parts) {
        if (name === "[Content_Types].xml") {
            continue;
        }

        const extension = name.endsWith(".rels") ? "rels" : posix.extname(name).slice(1);

        assert.ok(overrides.has(name) || defaults.has(extension), name);

        if (!name.endsWith(".rels")) {
            continue;
        }

        const source =
            name === "_rels/.rels" ? "" : name.replace(/(^|\/)_rels\//, "$1").slice(0, -5);
        const ids = new Set<string>();

        for (const [tag] of xml(parts, name).matchAll(/<Relationship\b[^>]*\/>/g)) {
            const a = attributes(tag);
            const target = posix.normalize(posix.join(posix.dirname(source), a.Target!));

            assert.ok(a.Id && a.Type && a.Target);
            assert.equal(ids.has(a.Id), false, `${name}: duplicate relationship ID`);
            assert.ok(parts.has(target), `${name}: missing target ${target}`);
            ids.add(a.Id);
        }

        if (source) {
            for (const [, id] of xml(parts, source).matchAll(/r:(?:id|embed)="([^"]+)"/g)) {
                assert.ok(ids.has(id!), `${source}: unresolved ID ${id}`);
            }
        }
    }

    assert.match(xml(parts, "ppt/slideMasters/slideMaster1.xml"), /<p:sldLayoutId\b/);
    assert.match(xml(parts, "ppt/slideLayouts/slideLayout1.xml"), /type="blank"/);
    assert.match(xml(parts, "ppt/notesMasters/notesMaster1.xml"), /<p:notesMaster\b/);
    assert.match(xml(parts, "ppt/theme/theme1.xml"), /<a:themeElements>/);
});

test("notes escape XML, preserve lines and Unicode, and omit invalid XML characters", () => {
    const text =
        "  A & B <tag> \"quoted\" 'apostrophe'  \r\n\n日本語 🎨\rLast\tline\u0000\u0001\ud800\ufffe";
    const parts = unpack(pptx([{ image: IMAGE, text }]));
    const notes = xml(parts, "ppt/notesSlides/notesSlide1.xml");

    assert.match(notes, /<p:ph type="body" idx="3"\/>/);
    assert.match(notes, /A &amp; B &lt;tag&gt; &quot;quoted&quot; &apos;apostrophe&apos;/);
    assert.match(notes, /xml:space="preserve"/);
    assert.doesNotMatch(notes, /\u0000|\u0001|\ufffe|�/u);
    assert.deepEqual(noteLines(notes), [
        "  A & B <tag> \"quoted\" 'apostrophe'  ",
        "",
        "日本語 🎨",
        "Last\tline",
    ]);
});

test("empty notes and an empty deck remain valid packages", () => {
    const notes = unpack(pptx([{ image: IMAGE, text: "" }]));
    const empty = unpack(pptx([]));

    assert.deepEqual(noteLines(xml(notes, "ppt/notesSlides/notesSlide1.xml")), [""]);
    assert.doesNotMatch(xml(empty, "ppt/presentation.xml"), /<p:sldIdLst>/);
    assert.equal(
        [...empty.keys()].some((name) => name.startsWith("ppt/slides/")),
        false,
    );
    assert.match(xml(empty, "docProps/app.xml"), /<Slides>0<\/Slides>/);
});

test("PNG and JPEG images keep their bytes and get distinct OPC content types", () => {
    // A real 16x9 JPEG, generated once. The test does not require an image encoder.
    const jpeg = Buffer.from(
        "/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAMCAgICAgMCAgIDAwMDBAYEBAQEBAgGBgUGCQgKCgkICQkKDA8MCgsOCwkJDRENDg8QEBEQCgwSExIQEw8QEBD/2wBDAQMDAwQDBAgEBAgQCwkLEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBD/wAARCAAJABADAREAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAf/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFgEBAQEAAAAAAAAAAAAAAAAAAAUI/8QAFBEBAAAAAAAAAAAAAAAAAAAAAP/aAAwDAQACEQMRAD8Al6I3QAAA/9k=",
        "base64",
    );
    const parts = unpack(
        pptx([
            { image: IMAGE, text: "PNG" },
            { image: jpeg, text: "JPEG" },
        ]),
    );
    const contentTypes = xml(parts, "[Content_Types].xml");

    assert.deepEqual(parts.get("ppt/media/image1.png"), IMAGE);
    assert.deepEqual(parts.get("ppt/media/image2.jpeg"), jpeg);
    assert.match(contentTypes, /Extension="png" ContentType="image\/png"/);
    assert.match(contentTypes, /Extension="jpeg" ContentType="image\/jpeg"/);
    assert.match(
        xml(parts, "ppt/slides/_rels/slide2.xml.rels"),
        /Target="\.\.\/media\/image2.jpeg"/,
    );
});

test("unsupported slide image buffers fail with a clear message", () => {
    for (const image of [Buffer.alloc(0), Buffer.from("not an image"), Buffer.from("<svg/>")]) {
        assert.throws(() => pptx([{ image, text: "" }]), /PNG or JPEG/);
    }
});
