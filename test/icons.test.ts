// The app's icons, as the systems that show them cut them. iOS and macOS cut the home-screen and Dock icon
// (apple-touch-icon.png) to their rounded square, and Android cuts a maskable icon to any shape that keeps the circle
// in its middle 80%: the frame and the π must stay clear of both, so only background is cut off.
//
// The PNGs are web/icon.svg drawn by rsvg-convert:
//
//   rsvg-convert -w N -h N web/icon.svg -o web/<file>   (apple-touch-icon.png at 180, icon-192.png, icon-512.png)
//   rsvg-convert -w 352 -h 352 --page-width 512 --page-height 512 --left 80 --top 80 -b "#13141c" \
//       web/icon.svg -o web/icon-maskable-512.png
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { inflateSync } from "node:zlib";

const WEB = new URL("../web/", import.meta.url);
/** The icon's background, which a mask may cut away. */
const BACKGROUND = [0x13, 0x14, 0x1c];

type Image = { width: number; height: number; channels: number; data: Uint8Array };
type Icon = { src: string; type?: string; purpose?: string };

/** An 8-bit, non-interlaced RGB or RGBA PNG's pixels. */
function decodePng(bytes: Buffer): Image {
    assert.equal(bytes.subarray(0, 8).toString("hex"), "89504e470d0a1a0a", "a PNG");
    assert.equal(bytes.toString("latin1", 12, 16), "IHDR", "its header first");
    const header = bytes.subarray(16, 29);
    const width = header.readUInt32BE(0);
    const height = header.readUInt32BE(4);
    const [depth, color, , , interlace] = header.subarray(8);

    assert.ok(depth === 8 && (color === 2 || color === 6) && interlace === 0, "8-bit RGB(A)");
    const channels = color === 2 ? 3 : 4;
    const chunks: Buffer[] = [];
    let at = 8;

    while (at < bytes.length) {
        const length = bytes.readUInt32BE(at);

        if (bytes.toString("latin1", at + 4, at + 8) === "IDAT") {
            chunks.push(bytes.subarray(at + 8, at + 8 + length));
        }

        at += 12 + length;
    }

    const raw = inflateSync(Buffer.concat(chunks));
    const stride = width * channels;
    const data = new Uint8Array(height * stride);

    for (let y = 0; y < height; y++) {
        const filter = raw[y * (stride + 1)]!;

        assert.ok(filter <= 4, `filter ${filter}`);

        for (let x = 0; x < stride; x++) {
            const left = x >= channels ? data[y * stride + x - channels]! : 0;
            const up = y > 0 ? data[(y - 1) * stride + x]! : 0;
            const corner = x >= channels && y > 0 ? data[(y - 1) * stride + x - channels]! : 0;
            const value = raw[y * (stride + 1) + 1 + x]!;
            let predicted = 0;

            if (filter === 1) {
                predicted = left;
            } else if (filter === 2) {
                predicted = up;
            } else if (filter === 3) {
                predicted = (left + up) >> 1;
            } else if (filter === 4) {
                const estimate = left + up - corner;
                const [a, b, c] = [left, up, corner].map((near) => Math.abs(estimate - near));

                predicted = a! <= b! && a! <= c! ? left : b! <= c! ? up : corner;
            }

            data[y * stride + x] = (value + predicted) & 255;
        }
    }

    return { width, height, channels, data };
}

function load(file: string): Image {
    return decodePng(readFileSync(new URL(file, WEB)));
}

/** The pixels a mask would cut off (`kept` says false) that are not plain background, as "x,y". */
function cutContent(image: Image, kept: (u: number, v: number) => boolean): string[] {
    const found: string[] = [];

    for (let y = 0; y < image.height; y++) {
        for (let x = 0; x < image.width; x++) {
            // From the middle, in half the icon's width: -1 to 1 across.
            const u = ((x + 0.5) * 2) / image.width - 1;
            const v = ((y + 0.5) * 2) / image.height - 1;

            if (kept(u, v)) {
                continue;
            }

            const at = (y * image.width + x) * image.channels;
            const plain = BACKGROUND.every(
                (value, channel) => Math.abs(image.data[at + channel]! - value) <= 2,
            );

            if (!plain) {
                found.push(`${x},${y}`);
            }
        }
    }

    return found;
}

/**
 * Apple's rounded square, as the superellipse |u|⁵ + |v|⁵ = 1 that stands in for its continuous corners, shrunk by 3%
 * of the icon's width: what it keeps of an icon, less a margin, so the frame does not run along the cut.
 */
const appleMask = (u: number, v: number) => Math.abs(u) ** 5 + Math.abs(v) ** 5 <= 0.94 ** 5;

/** A maskable icon's safe zone: the circle in its middle 80%, which every mask keeps. */
const safeZone = (u: number, v: number) => Math.hypot(u, v) <= 0.8;

function manifestIcons(): Icon[] {
    return JSON.parse(readFileSync(new URL("manifest.webmanifest", WEB), "utf8")).icons;
}

test("Apple's rounded mask cuts only background off the home-screen icon", () => {
    const page = readFileSync(new URL("index.html", WEB), "utf8");
    const href = /<link rel="apple-touch-icon" href="\/([^"]+)"/.exec(page)?.[1];

    assert.ok(href, "index.html names an apple-touch-icon");
    const icon = load(href);

    // Apple asks for 180×180; a size it scales is drawn blurry.
    assert.deepEqual([icon.width, icon.height], [180, 180]);
    const cut = cutContent(icon, appleMask);

    assert.deepEqual(cut.slice(0, 5), [], `${cut.length} pixels of the frame or π are cut off`);
});

test("the manifest's plain PNG icons fit Apple's rounded mask too", () => {
    const plain = manifestIcons().filter(
        (icon) => icon.type === "image/png" && (icon.purpose ?? "any") === "any",
    );

    assert.ok(plain.length > 0);

    for (const { src } of plain) {
        const cut = cutContent(load(src.slice(1)), appleMask);

        assert.deepEqual(cut.slice(0, 5), [], `${src}: ${cut.length} pixels cut off`);
    }
});

test("maskable icons keep the frame and π inside the safe zone, and plain ones are not maskable", () => {
    const icons = manifestIcons();
    const purposes = icons.map((icon) => (icon.purpose ?? "any").split(/\s+/));

    // One icon for both is either padded too much where it is shown whole, or cut where it is masked.
    assert.ok(
        purposes.every((purpose) => !(purpose.includes("any") && purpose.includes("maskable"))),
        "no icon is both any and maskable",
    );
    const maskable = icons.filter((_, index) => purposes[index]!.includes("maskable"));

    assert.ok(maskable.length > 0, "a maskable icon, for Android's shapes");

    for (const { src, type } of maskable) {
        assert.equal(type, "image/png", `${src}: a PNG, which this test can read`);
        const image = load(src.slice(1));
        const cut = cutContent(image, safeZone);

        assert.ok(image.width >= 512, `${src}: 512 pixels or more`);
        assert.ok(cutContent(image, () => false).length > 0, `${src}: the icon is in it`);
        assert.deepEqual(cut.slice(0, 5), [], `${src}: ${cut.length} pixels outside the safe zone`);
    }
});

test("the showcase site's icon is the app's, drawn the same", () => {
    // Its comments aside: what each says about where it is used differs.
    const drawing = (path: URL) =>
        readFileSync(path, "utf8")
            .replace(/<!--[\s\S]*?-->/g, "")
            .replace(/\s+/g, " ")
            .trim();

    assert.equal(
        drawing(new URL("../site/icon.svg", import.meta.url)),
        drawing(new URL("icon.svg", WEB)),
    );
});
