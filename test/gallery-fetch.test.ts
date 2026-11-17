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

/** A fetcher that records each request's host and authorization header, and answers from `answer`. */
function recorder(answer: (url: string, authorization: string | null) => Response) {
    const seen: [string, string | null][] = [];

    const fetcher = async (url: string, init: RequestInit) => {
        const authorization = new Headers(init.headers).get("authorization");

        seen.push([new URL(url).host, authorization]);

        return answer(url, authorization);
    };

    return { seen, fetcher };
}

const RAW = "https://raw.githubusercontent.com/acme/index/HEAD/index.json";
const moved = (location: string) => new Response(null, { status: 302, headers: { location } });

test("a GitHub token goes only to GitHub's hosts, also after a redirect", async () => {
    const { seen, fetcher } = recorder((url) =>
        url === RAW ? moved("https://evil.example/x") : new Response("ok"),
    );

    for (const url of [RAW, "https://raw.githubusercontent.com.evil.example/x"]) {
        await download(fetcher, url, 10, "file", { token: "ghp_secret" });
    }

    assert.deepEqual(seen, [
        ["raw.githubusercontent.com", "Bearer ghp_secret"],
        ["evil.example", null],
        ["raw.githubusercontent.com.evil.example", null],
    ]);
});

test("a token GitHub refuses does not stop a public index: the request goes again without it, and so does the rest", async () => {
    // GitHub answers 404 to a token that cannot read a repository, also a public one.
    const { seen, fetcher } = recorder((url, authorization) =>
        authorization !== null
            ? new Response("Not Found", { status: 404 })
            : url === RAW
              ? moved("https://api.github.com/x")
              : new Response("ok"),
    );

    const bytes = await download(fetcher, RAW, 10, "The index", { token: "ghp_expired" });

    assert.equal(new TextDecoder().decode(bytes), "ok");
    assert.deepEqual(seen, [
        ["raw.githubusercontent.com", "Bearer ghp_expired"],
        ["raw.githubusercontent.com", null],
        ["api.github.com", null],
    ]);
});

test("a token that cannot go in a header fails a request to GitHub, and the error does not show it", async () => {
    // fetch would throw an error that quotes the header, token and all.
    const { seen, fetcher } = recorder(() => new Response("ok"));

    for (const token of ["ghp_secret\r\nx-evil: 1", "ghp_sécret€"]) {
        await assert.rejects(
            download(fetcher, RAW, 10, "The index", { token }),
            (error: Error) =>
                /GitHub token in the gallery's settings/.test(error.message) &&
                !/secret|sécret/.test(error.message),
        );
    }

    assert.deepEqual(seen, []);
});
