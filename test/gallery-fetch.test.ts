import assert from "node:assert/strict";
import { test } from "node:test";
import { download } from "../src/server/gallery/fetch.ts";

test("an encoded response may have a wire length above the decoded size limit", async () => {
    const bytes = await download(
        async () =>
            new Response("good", {
                headers: { "content-encoding": "gzip", "content-length": "51" },
            }),
        "https://example.com/file",
        4,
        "file",
    );

    assert.equal(new TextDecoder().decode(bytes), "good");
});

test("an encoded response is still rejected when its decoded body exceeds the limit", async () => {
    await assert.rejects(
        download(
            async () =>
                new Response("large", {
                    headers: { "content-encoding": "gzip", "content-length": "51" },
                }),
            "https://example.com/file",
            4,
            "file",
        ),
        /file is larger than 4 bytes/,
    );
});
