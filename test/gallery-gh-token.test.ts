// The extension gallery's GitHub token: its setting, else the GitHub CLI's for github.com, hidden.
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { after, test } from "node:test";
import { cleanUp, openApp, owner, root, scriptedModel } from "./helpers.ts";

const TOKEN = "gho_0123456789abcdefghijklmnop";

after(cleanUp);

test("the setting wins, trimmed; while it is empty, gh's github.com token goes, not GH_HOST's, and is hidden", async () => {
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
    process.env.PATH = `${bin}${delimiter}${saved.PATH ?? ""}`;
    process.env.GH_HOST = "github.example.com";
    const app = await openApp(scriptedModel(), join(root, "gallery-gh-token"));
    const seen: (string | null)[] = [];

    app.gallery.fetch = async (_url, init) => {
        seen.push(new Headers(init.headers).get("authorization"));

        return new Response(JSON.stringify({ format: 1, extensions: [] }));
    };

    try {
        app.setExtensionSettings(owner(app), "gallery", { githubToken: "  ghp_from_setting  " });
        await app.gallery.listing(true);
        app.setExtensionSettings(owner(app), "gallery", { githubToken: "" });
        await app.gallery.listing(true);
        assert.deepEqual(seen, ["Bearer ghp_from_setting", `Bearer ${TOKEN}`]);
        assert.equal(app.hidden.replace(`a ${TOKEN} b`, 1), "a [GitHub token from gh] b");
    } finally {
        process.env.PATH = saved.PATH;

        if (saved.GH_HOST === undefined) {
            delete process.env.GH_HOST;
        } else {
            process.env.GH_HOST = saved.GH_HOST;
        }

        await app.close();
        rmSync(bin, { recursive: true, force: true });
    }
});
