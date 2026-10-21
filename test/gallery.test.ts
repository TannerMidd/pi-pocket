// The extension gallery: what comes from its index is untrusted, and what it installs never runs on its own.
import { cleanUp, openApp, owner, root, scriptedModel } from "./helpers.ts";
import type { Installed } from "../src/server/gallery.ts";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import {
    existsSync,
    mkdirSync,
    readdirSync,
    readFileSync,
    renameSync,
    symlinkSync,
    writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { after, before, test } from "node:test";

const dataDir = join(root, "gallery-data");
const dropIns = join(dataDir, "extensions");
const INDEX = "https://raw.githubusercontent.com/TannerMidd/pi-pocket-extensions/HEAD/index.json";

const clock = `/** A clock tool, for the gallery's tests. */
import { Type } from "@earendil-works/pi-ai";
import { defineExtension, defineTool } from "@earendil-works/pi-durable";

export default () => defineExtension({
    name: "test-clock",
    tools: [defineTool({ name: "test_clock", description: "Now", parameters: Type.Object({}),
        execute: async () => ({ content: [{ type: "text", text: "now" }] }) })],
});
`;

/** What the stand-in for the network serves, by address. */
const served = new Map<string, string>();
let app: Awaited<ReturnType<typeof openApp>>;

/** An entry for `name` whose files are `files` (name to text) at `commit`, served where the gallery downloads them. */
function entry(name: string, files: Record<string, string>, commit: string, extra = {}) {
    for (const [file, text] of Object.entries(files)) {
        served.set(
            `https://raw.githubusercontent.com/someone/pocket-${name}/${commit}/${file}`,
            text,
        );
    }

    return {
        name,
        title: `Test ${name}`,
        description: "For the gallery's tests.",
        tags: ["test"],
        author: { name: "Someone" },
        version: "1.0.0",
        source: { repo: `someone/pocket-${name}`, commit },
        files: Object.entries(files).map(([file, text]) => ({
            name: file,
            sha256: createHash("sha256").update(text).digest("hex"),
            size: Buffer.byteLength(text),
        })),
        pocketApi: 1,
        minPocket: "0.14.0",
        declares: {
            extensions: ["test-clock"],
            tools: ["test_clock"],
            readOnlyTools: [],
            hooks: [],
            sections: [],
            wraps: [],
            routes: [],
            client: null,
            access: "owner",
        },
        ...extra,
    };
}

/** Serve an index of these entries, and have the gallery read it. */
async function index(...entries: unknown[]) {
    served.set(INDEX, JSON.stringify({ format: 1, extensions: entries }));

    return app.gallery.listing(true);
}

/** What the owner approves for an entry the gallery lists: its pin. */
const pin = async (name: string) =>
    (await app.gallery.listing(false)).entries.find((each) => each.name === name)?.pin;

/** Open the app on the gallery's data folder (again, for a restart), with the stand-in for the network. */
async function open() {
    app = await openApp(scriptedModel(), dataDir);
    app.gallery.fetch = async (url) =>
        served.has(url) ? new Response(served.get(url)) : new Response("", { status: 404 });
}

before(open);

after(async () => {
    await app?.close();
    cleanUp();
});

test("an entry whose file would leave the extensions folder is not listed, and writes nothing", async () => {
    const listing = await index(
        entry("escape", { "escape.ts": clock, "../escape.ts": clock }, "1".repeat(40)),
    );

    assert.deepEqual(listing.entries, []);
    assert.match(listing.hidden.invalid[0]?.problem ?? "", /files\[1\]\.name/);
    await assert.rejects(app.gallery.install("escape", "any"), { status: 404 });
    assert.ok(!existsSync(join(dataDir, "escape.ts")));
    assert.ok(!existsSync(join(dropIns, "escape.ts")));
});

test("a file that does not match its pinned SHA-256 installs nothing", async () => {
    const commit = "2".repeat(40);

    await index(entry("tampered", { "tampered.ts": clock }, commit));
    // The file at the pinned commit is not the one the index pinned, though it is as long.
    served.set(
        `https://raw.githubusercontent.com/someone/pocket-tampered/${commit}/tampered.ts`,
        clock.replace("now", "new"),
    );

    await assert.rejects(app.gallery.install("tampered", await pin("tampered")), (error: Error) => {
        assert.match(error.message, /SHA-256/);

        return true;
    });
    assert.deepEqual(
        readdirSync(dropIns).filter(
            (file) => file.startsWith("tampered") || file.includes(".part"),
        ),
        [],
    );
});

test("a code file the source view could not show as it runs installs nothing", async () => {
    // Node runs it, NUL and all, which the gallery would show only as "binary"; text in the other direction shows
    // reordered.
    for (const [name, end] of [
        ["hidden", "// \0\n"],
        ["turned", "// \u202e }\n"],
    ]) {
        await index(entry(name!, { [`${name}.ts`]: `${clock}${end}` }, "4".repeat(40)));
        await assert.rejects(app.gallery.install(name!, await pin(name!)), { status: 502 });
        assert.ok(!existsSync(join(dropIns, `${name}.ts`)));
    }
});

test("an installed extension arrives off, even under a name that was turned on before", async () => {
    const commit = "3".repeat(40);

    // A drop-in of this name was on once, and its file was removed by hand: the choice stayed.
    app.config.setExtensionEnabled("stale.ts", true);
    await index(entry("stale", { "stale.ts": clock }, commit));

    const installed = await app.gallery.install("stale", await pin("stale"));

    assert.ok(existsSync(join(dropIns, "stale.ts")));
    assert.equal((installed as Installed).enabled, false);
    assert.equal(app.loader.enabled("stale.ts"), false);
    assert.ok(!app.loader.extensionNames().includes("test-clock"));
});

test("an install goes ahead only as the owner saw it, not as the index changed it since", async () => {
    const commit = "6".repeat(40);

    await index(entry("seen", { "seen.ts": clock }, commit));
    const seen = await pin("seen");

    // Same commit, other files: the commit alone is no approval of what gets written.
    await index(entry("seen", { "seen.ts": clock.replace("now", "new") }, commit));

    await assert.rejects(app.gallery.install("seen", seen), { status: 409 });
    assert.ok(!existsSync(join(dropIns, "seen.ts")));
});

test("updates and removal never reach past an extension's own files: not through a link, nor to others", async () => {
    await index(
        entry(
            "linked",
            { "linked.ts": clock, "linked/util.ts": "export const one = 1;\n" },
            "7".repeat(40),
        ),
    );
    await app.gallery.install("linked", await pin("linked"));
    // The owner's own file in its folder; then the folder moved elsewhere, with a link to it in its place.
    writeFileSync(join(dropIns, "linked", "mine.txt"), "mine");
    const outside = join(root, "outside");

    renameSync(join(dropIns, "linked"), outside);
    symlinkSync(outside, join(dropIns, "linked"));

    await index(
        entry(
            "linked",
            { "linked.ts": clock, "linked/util.ts": "export const two = 2;\n" },
            "8".repeat(40),
        ),
    );
    await assert.rejects(app.gallery.update("linked", await pin("linked"), false), { status: 409 });
    assert.equal(readFileSync(join(outside, "util.ts"), "utf8"), "export const one = 1;\n");

    await app.gallery.uninstall(owner(app), "linked");
    assert.ok(!existsSync(join(dropIns, "linked.ts")));
    assert.ok(existsSync(join(outside, "util.ts")) && existsSync(join(outside, "mine.txt")));
});

test("an update's preview names a file of the owner's that the new version would replace", async () => {
    await index(entry("owned", { "owned.ts": clock }, "9".repeat(40)));
    await app.gallery.install("owned", await pin("owned"));
    mkdirSync(join(dropIns, "owned"));
    writeFileSync(join(dropIns, "owned", "settings.json"), "{}\n");
    await index(
        entry("owned", { "owned.ts": clock, "owned/settings.json": "[]\n" }, "a".repeat(40)),
    );

    assert.deepEqual((await app.gallery.updatePreview("owned")).edited, ["owned/settings.json"]);
});

test("an update the server stopped in the middle of goes back to the version before", async () => {
    const at = (file: string) => join(dropIns, file);

    mkdirSync(at("halted"));
    writeFileSync(at("halted.ts"), "old module");
    writeFileSync(at("halted/util.ts"), "old helper");
    writeFileSync(at(".halted.ts.1.part"), "new module");
    writeFileSync(at("halted/.util.ts.2.part"), "new helper");
    // Its journal, as the update wrote it; then the helper moved in, and the module moved aside, when the server stopped.
    const steps = [
        {
            to: at("halted/util.ts"),
            from: at("halted/.util.ts.2.part"),
            old: at("halted/.util.ts.2.old"),
        },
        { to: at("halted.ts"), from: at(".halted.ts.1.part"), old: at(".halted.ts.1.old") },
    ];

    writeFileSync(at(".halted.gallery-undo.json"), JSON.stringify(steps));
    renameSync(steps[0]!.to, steps[0]!.old);
    renameSync(steps[0]!.from, steps[0]!.to);
    renameSync(steps[1]!.to, steps[1]!.old);
    // Another stopped while it wrote its journal: nothing moved, and the next change to it must not be refused.
    writeFileSync(at(".torn.gallery-undo.json"), '[{"to": "');

    await app.gallery.recover();

    assert.ok(!existsSync(at(".torn.gallery-undo.json")));
    assert.equal(readFileSync(at("halted.ts"), "utf8"), "old module");
    assert.equal(readFileSync(at("halted/util.ts"), "utf8"), "old helper");
    assert.deepEqual(
        [...readdirSync(dropIns), ...readdirSync(at("halted"))].filter(
            (file) => file.includes("halted.") || file.startsWith(".util"),
        ),
        ["halted.ts"],
    );
});

test("a revoked version is flagged where it is installed, and is never installed again", async () => {
    const first = "4".repeat(40);

    await index(entry("revoked", { "revoked.ts": clock }, first));
    await app.gallery.install("revoked", await pin("revoked"));
    await app.setExtensionEnabled(owner(app), "revoked.ts", true);

    // The index revokes it, with a fix only a newer Pi Pocket can use, and a reason its strict reading refuses (an
    // emoji's variation selector); and, in another entry, the only version there is.
    await index(
        entry("revoked", { "revoked.ts": clock.replace("now", "later") }, "5".repeat(40), {
            minPocket: "99.0.0",
            revoked: [{ commit: first, reason: "\u26a0\ufe0f It sends your config away." }],
        }),
        entry("withdrawn", { "withdrawn.ts": clock }, first, {
            revoked: [{ commit: first, reason: "Withdrawn." }],
        }),
    );

    const [state] = (await app.gallery.installed()).items.filter((each) => each.name === "revoked");

    assert.equal(state?.revoked, "\u26a0 It sends your config away.");
    assert.equal(state?.enabled, true);
    await assert.rejects(app.gallery.install("withdrawn", await pin("withdrawn")), {
        status: 409,
    });
});

test("a theme installs into the themes folder only as pinned, and only when its CSS passes the theme check", async () => {
    const themes = join(dataDir, "themes");

    const theme = (name: string, css: string, commit: string) => {
        const files = {
            [`${name}/theme.json`]: '{ "themeApi": 1, "name": "Test theme" }\n',
            [`${name}/theme.css`]: css,
            // A light palette beside the theme: part of the format, so part of an entry.
            [`${name}/colors-light.toml`]: 'background = "#fafafa"\nforeground = "#222222"\n',
        };
        const { pocketApi: _api, declares: _declares, ...rest } = entry(name, files, commit);

        return { ...rest, kind: "theme", themeApi: 1 };
    };

    const good = ":root { --accent: #c2410c; }\n";

    await index(
        theme("paper", good, "a".repeat(40)),
        // It would load the app's own address with the person's cookie: the check refuses it.
        theme("leaky", ':root { --wallpaper: url("/api/state"); }\n', "b".repeat(40)),
        theme("swapped", good, "c".repeat(40)),
    );
    served.set(
        `https://raw.githubusercontent.com/someone/pocket-swapped/${"c".repeat(40)}/swapped/theme.css`,
        good.replace("c2410c", "000000"),
    );

    await assert.rejects(app.gallery.install("leaky", await pin("leaky")), { status: 422 });
    await assert.rejects(app.gallery.install("swapped", await pin("swapped")), /SHA-256/);
    await app.gallery.install("paper", await pin("paper"));

    assert.deepEqual(readdirSync(themes), ["paper"]);
    assert.equal(readFileSync(join(themes, "paper", "theme.css"), "utf8"), good);
    assert.equal(app.themes.list().find((each) => each.id === "paper")?.usable, true);

    // The owner's default, and a restart while an update had the theme out of its folder: it stays the default.
    app.config.themeDefault = { look: "paper", colors: "desktop" };
    await app.close();
    renameSync(join(themes, "paper"), join(themes, `.gallery-paper-${randomUUID()}.part`));
    await open();
    assert.deepEqual(app.config.themeDefault, { look: "paper", colors: "desktop" });
});
