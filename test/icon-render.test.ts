import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { inflateSync } from "node:zlib";
import { APP_ICON, renderIcon } from "../src/server/icon-render.ts";

// The owner's stored colors live in the data folder: a folder of this test's own, not the real one.
const dataDir = mkdtempSync(join(tmpdir(), "icon-store-"));

/** An 8-bit RGB PNG with no interlacing, as pixels. */
function decode(png: Buffer): { size: number; pixels: Buffer } {
    let at = 8;
    let size = 0;
    const data: Buffer[] = [];

    while (at < png.length) {
        const length = png.readUInt32BE(at);
        const type = png.toString("latin1", at + 4, at + 8);

        if (type === "IHDR") {
            size = png.readUInt32BE(at + 8);
            assert.equal(png[at + 16], 8, "8 bits");
            assert.equal(png[at + 17], 2, "RGB");
        }

        if (type === "IDAT") {
            data.push(png.subarray(at + 8, at + 8 + length));
        }

        at += 12 + length;
    }

    const raw = inflateSync(Buffer.concat(data));
    const stride = size * 3;
    const pixels = Buffer.alloc(size * stride);

    for (let y = 0; y < size; y++) {
        const filter = raw[y * (stride + 1)]!;

        for (let x = 0; x < stride; x++) {
            const value = raw[y * (stride + 1) + 1 + x]!;
            const left = x >= 3 ? pixels[y * stride + x - 3]! : 0;
            const up = y > 0 ? pixels[(y - 1) * stride + x]! : 0;
            const upLeft = x >= 3 && y > 0 ? pixels[(y - 1) * stride + x - 3]! : 0;
            let add = 0;

            if (filter === 1) {
                add = left;
            } else if (filter === 2) {
                add = up;
            } else if (filter === 3) {
                add = (left + up) >> 1;
            } else if (filter === 4) {
                const p = left + up - upLeft;
                const [a, b, c] = [Math.abs(p - left), Math.abs(p - up), Math.abs(p - upLeft)];

                add = a <= b && a <= c ? left : b <= c ? up : upLeft;
            }

            pixels[y * stride + x] = (value + add) & 255;
        }
    }

    return { size, pixels };
}

const meanDifference = (a: Buffer, b: Buffer) => {
    let sum = 0;

    for (let i = 0; i < a.length; i++) {
        sum += Math.abs(a[i]! - b[i]!);
    }

    return sum / a.length;
};

test("in the app's own colors the server draws the icon of web/icon-512.png", () => {
    const drawn = decode(renderIcon(APP_ICON, 512)!);
    const file = decode(readFileSync(new URL("../web/icon-512.png", import.meta.url)));

    assert.equal(drawn.size, 512);
    // Edges differ by anti-aliasing and the π was taken from this very file, so the mean difference stays small; a shape
    // in the wrong place, or a wrong color, is many pixels off at once and fails this.
    assert.ok(meanDifference(drawn.pixels, file.pixels) < 1.5, "the same drawing");
});

test("other colors give other pixels, in the places the colors name", () => {
    const grey = {
        frame: "#070707",
        card: "#000000",
        ring1: "#b0b0b0",
        ring2: "#b6b6b6",
        pi: "#b9b9b9",
    };
    const { size, pixels } = decode(renderIcon(grey, 180)!);
    const at = (x: number, y: number) => [
        ...pixels.subarray((y * size + x) * 3, (y * size + x) * 3 + 3),
    ];

    assert.deepEqual(at(2, 2), [7, 7, 7], "the frame");
    assert.deepEqual(at(40, 40), [0, 0, 0], "the card");
    // The brightest pixel of the middle is the π's, in the color given; the card and the frame are darker than it.
    let brightest = 0;

    for (let y = 40; y < 140; y++) {
        for (let x = 40; x < 140; x++) {
            brightest = Math.max(brightest, at(x, y)[0]!);
        }
    }

    assert.equal(brightest, 0xb9, "the π");
});

test("a size is kept in range, and a color that is not hex is refused", () => {
    assert.equal(decode(renderIcon(APP_ICON, 5)!).size, 64);
    assert.equal(decode(renderIcon(APP_ICON, 99999)!).size, 1024);
    assert.equal(renderIcon({ ...APP_ICON, pi: "red" }, 180), null);
});

test("the page carries the icon address of the colors in the cookie, and no other", async () => {
    const { iconAddress } = await import("../src/server/http/icon-route.ts");
    const request = (cookie?: string) =>
        ({ headers: cookie === undefined ? {} : { cookie } }) as never;

    assert.equal(
        iconAddress(request("a=1; pocket_icon=070707.000.b0b0b0.b6b6b6.b9b9b9"), dataDir),
        "/app-icon.png?frame=070707&card=000&ring1=b0b0b0&ring2=b6b6b6&pi=b9b9b9&size=180",
    );
    assert.equal(iconAddress(request(), dataDir), null, "no cookie");
    assert.equal(iconAddress(request("pocket_icon=zz"), dataDir), null, "not colors");
    assert.equal(
        iconAddress(request('pocket_icon=070707.000.b0b0b0.b6b6b6.b9b9b9"><script>'), dataDir),
        null,
        "nothing but the colors reaches the page",
    );
});

test("a maskable icon fills the square with the frame's color and keeps the art in the safe zone", () => {
    const { size, pixels } = decode(renderIcon(APP_ICON, 512, true)!);
    const at = (x: number, y: number) => [
        ...pixels.subarray((y * size + x) * 3, (y * size + x) * 3 + 3),
    ];

    assert.deepEqual(at(5, 5), [0x13, 0x14, 0x1c], "the corner is the frame's");
    assert.deepEqual(
        at(90, 256),
        [0x13, 0x14, 0x1c],
        "outside the 80-pixel margin there is no card",
    );
    // Where the plain icon has its ring (x = 40), the maskable one has the card's own edge at 80 + 40 × 0.6875.
    assert.notDeepEqual(at(110, 256), at(5, 5), "the ring of the art starts inside the margin");
});

test("the manifest takes the icons and colors of the cookie, and is left alone without one", async () => {
    const { manifestFor } = await import("../src/server/http/icon-route.ts");
    const file = JSON.stringify({
        name: "Pi Pocket",
        icons: [{ src: "/icon.svg" }],
        theme_color: "#13141c",
    });
    const request = (cookie?: string) =>
        ({ headers: cookie === undefined ? {} : { cookie } }) as never;

    assert.equal(manifestFor(request(), file, dataDir), null, "the static file is served");

    const made = JSON.parse(
        manifestFor(request("pocket_icon=070707.000.b0b0b0.b6b6b6.b9b9b9"), file, dataDir)!,
    );

    assert.equal(made.name, "Pi Pocket", "the rest stays");
    assert.equal(made.theme_color, "#070707");
    assert.deepEqual(
        made.icons.map((icon: { sizes: string; purpose?: string }) => [icon.sizes, icon.purpose]),
        [
            ["192x192", undefined],
            ["192x192", "maskable"],
        ],
    );
    assert.match(made.icons[1].src, /pi=b9b9b9.*maskable=1/);
});

test("the owner's colors serve a request with no cookie, and the cookie still wins", async () => {
    const { storeIconColors, storedIconColors } = await import("../src/server/icon-store.ts");
    const { iconAddress, manifestFor } = await import("../src/server/http/icon-route.ts");
    const request = (cookie?: string) =>
        ({ headers: cookie === undefined ? {} : { cookie } }) as never;

    assert.equal(storedIconColors(dataDir), null, "nothing stored yet");
    assert.equal(iconAddress(request(), dataDir), null);

    storeIconColors(dataDir, "070707.000.b0b0b0.b6b6b6.b9b9b9");

    assert.deepEqual(storedIconColors(dataDir), ["070707", "000", "b0b0b0", "b6b6b6", "b9b9b9"]);
    assert.match(
        iconAddress(request(), dataDir)!,
        /frame=070707.*pi=b9b9b9/,
        "no cookie: the owner's colors",
    );
    assert.match(
        iconAddress(request("pocket_icon=111.222.333.444.555"), dataDir)!,
        /frame=111/,
        "a cookie wins",
    );
    assert.ok(manifestFor(request(), "{}", dataDir), "the manifest too");
    assert.throws(() => storeIconColors(dataDir, "nope"), TypeError, "only colors are stored");
});

test("the icon route draws no more than 192 pixels, and a size that is not a number is a 400", async () => {
    const { iconRoute } = await import("../src/server/http/icon-route.ts");

    const get = (query: string) => {
        let body: Buffer = Buffer.alloc(0);
        const response = { writeHead() {}, end: (data: Buffer) => (body = data) };

        iconRoute({ method: "GET" } as never, response as never, new URL(`http://x/?${query}`));

        return decode(body).size;
    };

    assert.equal(get("size=99999"), 192);
    assert.equal(get("size=99999"), 192, "the second one comes from the cache");
    assert.throws(() => get("size=abc"), { status: 400 });
    assert.throws(() => get("size=Infinity"), { status: 400 });
});

test("a client that changes the colors in each request cannot keep the server drawing", async () => {
    const { iconRoute } = await import("../src/server/http/icon-route.ts");
    const statuses: number[] = [];

    for (let index = 0; index < 20; index++) {
        const response = { writeHead: (status: number) => statuses.push(status), end() {} };
        const card = (0x100 + index).toString(16).padStart(6, "0");

        iconRoute({ method: "GET" } as never, response as never, new URL(`http://x/?card=${card}`));
    }

    // 20 drawings take less than 2 seconds, which allow 16 at most.
    assert.ok(statuses.filter((status) => status === 503).length >= 4, String(statuses));
});
