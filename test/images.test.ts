import assert from "node:assert/strict";
import { test } from "node:test";

process.env.PI_POCKET_GUARD = "off";
const { sniffImage } = await import("../src/server/http.ts");

test("images are recognized by their bytes, not their names", () => {
	assert.equal(sniffImage(Buffer.from("89504e470d0a1a0a0000000d49484452", "hex")), "image/png");
	assert.equal(sniffImage(Buffer.from("ffd8ffe000104a464946", "hex")), "image/jpeg");
	assert.equal(sniffImage(Buffer.from("GIF89a\x01\x00", "latin1")), "image/gif");
	assert.equal(sniffImage(Buffer.from("RIFF\x10\x00\x00\x00WEBPVP8 ", "latin1")), "image/webp");
	assert.equal(sniffImage(Buffer.from("\x00\x00\x00\x1cftypavif", "latin1")), "image/avif");
	assert.equal(sniffImage(Buffer.from('<?xml version="1.0"?>\n<svg xmlns="http://www.w3.org/2000/svg"></svg>')), "image/svg+xml");
	assert.equal(sniffImage(Buffer.from('\uFEFF  <svg viewBox="0 0 1 1"/>')), "image/svg+xml");
	assert.equal(sniffImage(Buffer.from("root:x:0:0:root:/root:/bin/bash\n")), undefined);
	assert.equal(sniffImage(Buffer.from("<html><body>hi</body></html>")), undefined);
	assert.equal(sniffImage(Buffer.alloc(0)), undefined);
});
