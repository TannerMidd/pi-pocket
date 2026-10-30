import assert from "node:assert/strict";
import { test } from "node:test";

process.env.PI_POCKET_GUARD = "off";
const { sniffImage } = await import("../src/server/http/assets.ts");
const { uploadMime } = await import("../src/server/http/conversation-routes.ts");

test("images are recognized by their bytes, not their names", () => {
    assert.equal(sniffImage(Buffer.from("89504e470d0a1a0a0000000d49484452", "hex")), "image/png");
    assert.equal(sniffImage(Buffer.from("root:x:0:0:root:/root:/bin/bash\n")), undefined);
    assert.equal(sniffImage(Buffer.from("<html><body>hi</body></html>")), undefined);
});

test("an upload's type comes from its name when the browser does not know it", () => {
    assert.equal(uploadMime("photo.heic", undefined), "image/heic");
    assert.equal(uploadMime("photo.heif", "application/octet-stream"), "image/heif");
    assert.equal(uploadMime("burst.heic", "image/heic-sequence"), "image/heic-sequence");
    assert.equal(uploadMime("photo.png", "image/png"), "image/png");
    assert.equal(uploadMime("notes.txt", "text/plain; charset=utf-8"), "text/plain");
});
