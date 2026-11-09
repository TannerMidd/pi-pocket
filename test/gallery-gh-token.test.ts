// The GitHub CLI's token for the extension gallery: which host it asks for, and how long an answer is kept.
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { after, test } from "node:test";
import { ghToken } from "../src/server/extensions/gallery.ts";
import { cleanUp, openApp, owner, root, scriptedModel } from "./helpers.ts";

const TOKEN = "gho_0123456789abcdefghijklmnop";

/** A stand-in for `gh auth token` that answers from `answers` in turn, and a clock the test moves. */
function fake(answers: (string | Error)[]) {
    let asked = 0;
    let at = 1_000_000;

    const ask = async () => {
        const answer = answers[asked++];

        if (answer instanceof Error) {
            throw answer;
        }

        return answer;
    };

    return {
        token: ghToken(ask, () => at),
        asked: () => asked,
        wait: (ms: number) => {
            at += ms;
        },
    };
}

test("gh is asked for github.com's token, so GH_HOST cannot pick an Enterprise server's", async () => {
    // A stand-in `gh` that answers as the real one does: GH_HOST's token, unless --hostname names another host.
    const bin = mkdtempSync(join(tmpdir(), "gallery-gh-"));
    const saved = { PATH: process.env.PATH, GH_HOST: process.env.GH_HOST };

    writeFileSync(
        join(bin, "gh"),
        `#!/bin/sh
host="\${GH_HOST:-github.com}"
[ "$3" = "--hostname" ] && host="$4"
[ "$host" = "github.com" ] && echo "${TOKEN}" || echo "ghe_enterprise_token_0123456789"
`,
    );
    chmodSync(join(bin, "gh"), 0o755);
    process.env.PATH = `${bin}${delimiter}${process.env.PATH ?? ""}`;
    process.env.GH_HOST = "github.example.com";

    try {
        assert.equal(await ghToken()(), TOKEN);
    } finally {
        process.env.PATH = saved.PATH;

        if (saved.GH_HOST === undefined) {
            delete process.env.GH_HOST;
        } else {
            process.env.GH_HOST = saved.GH_HOST;
        }

        rmSync(bin, { recursive: true, force: true });
    }
});

test("a token from gh is kept for 10 minutes, then asked again", async () => {
    const gh = fake([`${TOKEN}\n`, `${TOKEN}\n`]);

    assert.equal(await gh.token(), TOKEN);
    gh.wait(9 * 60 * 1000);
    assert.equal(await gh.token(), TOKEN);
    assert.equal(gh.asked(), 1);
    gh.wait(2 * 60 * 1000);
    assert.equal(await gh.token(), TOKEN);
    assert.equal(gh.asked(), 2);
});

test("no token (gh fails, says nothing, or says no token) is kept 30 seconds only", async () => {
    const gh = fake([new Error("gh: not found"), "", "not a token at all", `${TOKEN}\n`]);

    assert.equal(await gh.token(), undefined);
    assert.equal(await gh.token(), undefined);
    assert.equal(gh.asked(), 1);

    for (const _ of [1, 2]) {
        gh.wait(31 * 1000);
        assert.equal(await gh.token(), undefined);
    }

    // A sign-in to gh counts within half a minute, not after 10.
    gh.wait(31 * 1000);
    assert.equal(await gh.token(), TOKEN);
    assert.equal(gh.asked(), 4);
});

test("tabs that ask at once share one call to gh", async () => {
    const gh = fake([`${TOKEN}\n`]);

    assert.deepEqual(await Promise.all([gh.token(), gh.token(), gh.token()]), [
        TOKEN,
        TOKEN,
        TOKEN,
    ]);
    assert.equal(gh.asked(), 1);
});

after(cleanUp);

test("the gallery's setting wins over gh's token, trimmed; while it is empty gh's goes, and is hidden", async () => {
    // A stand-in `gh` that counts its calls.
    const bin = mkdtempSync(join(tmpdir(), "gallery-gh-"));
    const calls = join(bin, "calls");
    const saved = process.env.PATH;

    writeFileSync(join(bin, "gh"), `#!/bin/sh\necho x >> "${calls}"\necho "${TOKEN}"\n`);
    chmodSync(join(bin, "gh"), 0o755);
    process.env.PATH = `${bin}${delimiter}${saved ?? ""}`;
    const app = await openApp(scriptedModel(), join(root, "gallery-gh-token"));
    const seen: (string | null)[] = [];

    app.gallery.fetch = async (_url, init) => {
        seen.push(new Headers(init.headers).get("authorization"));

        return new Response(JSON.stringify({ format: 1, extensions: [] }));
    };

    try {
        app.setExtensionSettings(owner(app), "gallery", { githubToken: "  ghp_from_setting  " });
        await app.gallery.listing(true);
        assert.deepEqual(seen, ["Bearer ghp_from_setting"]);
        assert.throws(
            () => readFileSync(calls),
            /ENOENT/,
            "gh is not asked while the setting holds a token",
        );

        app.setExtensionSettings(owner(app), "gallery", { githubToken: "" });
        await app.gallery.listing(true);
        assert.equal(seen.at(-1), `Bearer ${TOKEN}`);
        assert.equal(app.hidden.replace(`a ${TOKEN} b`, 1), "a [GitHub token from gh] b");
    } finally {
        process.env.PATH = saved;
        await app.close();
        rmSync(bin, { recursive: true, force: true });
    }
});
