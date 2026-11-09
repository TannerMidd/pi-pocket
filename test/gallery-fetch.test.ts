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

/** A fetcher that records each request's address and authorization header, and answers from `answer`. */
function recorder(answer: (url: string) => Response) {
    const seen: { url: string; authorization: string | null }[] = [];

    const fetcher = async (url: string, init: RequestInit) => {
        seen.push({ url, authorization: new Headers(init.headers).get("authorization") });

        return answer(url);
    };

    return { seen, fetcher };
}

test("a GitHub token goes to GitHub's hosts", async () => {
    const { seen, fetcher } = recorder(() => new Response("ok"));

    for (const url of [
        "https://raw.githubusercontent.com/acme/index/HEAD/index.json",
        "https://api.github.com/repos/acme/index",
        "https://github.com/acme/index",
    ]) {
        await download(fetcher, url, 10, "file", { token: "ghp_secret" });
    }

    assert.deepEqual(
        seen.map((each) => each.authorization),
        ["Bearer ghp_secret", "Bearer ghp_secret", "Bearer ghp_secret"],
    );
});

test("a GitHub token never goes to another host, also not after a redirect", async () => {
    const { seen, fetcher } = recorder((url) =>
        url.startsWith("https://raw.githubusercontent.com/")
            ? new Response(null, {
                  status: 302,
                  headers: { location: "https://evil.example/steal" },
              })
            : new Response("ok"),
    );

    await download(fetcher, "https://example.com/index.json", 10, "file", { token: "ghp_secret" });
    await download(
        fetcher,
        "https://raw.githubusercontent.com/acme/index/HEAD/index.json",
        10,
        "file",
        {
            token: "ghp_secret",
        },
    );

    assert.deepEqual(seen, [
        { url: "https://example.com/index.json", authorization: null },
        {
            url: "https://raw.githubusercontent.com/acme/index/HEAD/index.json",
            authorization: "Bearer ghp_secret",
        },
        { url: "https://evil.example/steal", authorization: null },
    ]);
});

test("a GitHub look-alike host gets no token, and no token goes without one", async () => {
    const { seen, fetcher } = recorder(() => new Response("ok"));

    await download(fetcher, "https://raw.githubusercontent.com.evil.example/x", 10, "file", {
        token: "ghp_secret",
    });
    await download(fetcher, "https://raw.githubusercontent.com/acme/index/HEAD/x", 10, "file");

    assert.deepEqual(
        seen.map((each) => each.authorization),
        [null, null],
    );
});

test("a 404 from GitHub says how to read a private repository, and never shows the token", async () => {
    const { fetcher } = recorder(() => new Response("Not Found", { status: 404 }));
    const url = "https://raw.githubusercontent.com/acme/index/HEAD/index.json";

    await assert.rejects(
        download(fetcher, url, 10, "The index"),
        /give the gallery a GitHub token/,
    );
    await assert.rejects(
        download(fetcher, url, 10, "The index", { token: "ghp_secret" }),
        (error: Error) => {
            assert.match(error.message, /With the GitHub token and without it/);
            assert.doesNotMatch(error.message, /ghp_secret/);

            return true;
        },
    );
    await assert.rejects(
        download(fetcher, "https://example.com/index.json", 10, "The index"),
        (error: Error) => {
            assert.doesNotMatch(error.message, /token/);

            return true;
        },
    );
});

test("a token that cannot go in a header fails a request to GitHub, and the error never shows it", async () => {
    // As fetch does: a header value with a line break or a wide character throws, quoting the value.
    const { seen, fetcher } = recorder(() => new Response("ok"));
    const url = "https://raw.githubusercontent.com/acme/index/HEAD/index.json";

    for (const token of ["ghp_secret\r\nx-evil: 1", "ghp_secret\n", "ghp_sécret€", "ghp secret"]) {
        await assert.rejects(download(fetcher, url, 10, "The index", { token }), (error: Error) => {
            assert.match(error.message, /GitHub token in the gallery's settings/);
            assert.doesNotMatch(error.message, /secret|sécret/);

            return true;
        });
    }

    assert.deepEqual(seen, []);
    // Another host does not get the token, so it does not matter there.
    await download(fetcher, "https://example.com/index.json", 10, "The index", {
        token: "ghp_secret\n",
    });
    assert.deepEqual(seen, [{ url: "https://example.com/index.json", authorization: null }]);
});

test("a token GitHub refuses (401 or 404) does not stop a public index: the request goes again without it", async () => {
    // As raw.githubusercontent.com does: a token it does not take gets 404, also for a public repository. Without
    // it, the file is sent on to another of GitHub's hosts, which must get no token either.
    const { seen, fetcher } = recorder((url) =>
        url.startsWith("https://github.com/")
            ? new Response(null, {
                  status: 302,
                  headers: {
                      location: "https://raw.githubusercontent.com/acme/index/HEAD/index.json",
                  },
              })
            : url.startsWith("https://raw.githubusercontent.com/")
              ? seen.at(-1)?.authorization !== null
                  ? new Response("Not Found", { status: 404 })
                  : new Response(null, {
                        status: 302,
                        headers: {
                            location: "https://api.github.com/repos/acme/index/contents/index.json",
                        },
                    })
              : new Response("ok"),
    );

    const bytes = await download(fetcher, "https://github.com/acme/index", 10, "The index", {
        token: "ghp_expired",
    });

    assert.equal(new TextDecoder().decode(bytes), "ok");
    // The redirect went with the token; the 404 it got went again without it, once, and so did the hop after it.
    assert.deepEqual(
        seen.map((each) => [each.url.replace(/^https:\/\/([^/]+).*$/, "$1"), each.authorization]),
        [
            ["github.com", "Bearer ghp_expired"],
            ["raw.githubusercontent.com", "Bearer ghp_expired"],
            ["raw.githubusercontent.com", null],
            ["api.github.com", null],
        ],
    );
});

test("when GitHub refuses the token and the repository is not public either, the error says so without the token", async () => {
    // Refused (401) on the first hop, sent on without the token, and not found after it: the error still knows.
    const { seen, fetcher } = recorder((url) =>
        url.startsWith("https://raw.githubusercontent.com/")
            ? new Response("Not Found", { status: 404 })
            : seen.at(-1)?.authorization === null
              ? new Response(null, {
                    status: 302,
                    headers: {
                        location: "https://raw.githubusercontent.com/acme/index/HEAD/index.json",
                    },
                })
              : new Response("Bad credentials", { status: 401 }),
    );

    await assert.rejects(
        download(fetcher, "https://github.com/acme/index", 10, "The index", {
            token: "ghp_expired",
        }),
        (error: Error) => {
            assert.match(error.message, /did not accept the GitHub token \(401\)/);
            assert.doesNotMatch(error.message, /ghp_expired/);

            return true;
        },
    );
    assert.deepEqual(
        seen.map((each) => each.authorization),
        ["Bearer ghp_expired", null, null],
    );
});
