import { cleanUp, openApp, root, scriptedModel } from "./helpers.ts";
import { scanCode, scanFiles, stripComments, themePalette } from "../src/server/gallery/reach.ts";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, test } from "node:test";

const dataDir = join(root, "gallery-reach-data");
const INDEX = "https://raw.githubusercontent.com/TannerMidd/pi-pocket-extensions/HEAD/index.json";

const served = new Map<string, string>();
let asked: string[] = [];
let app: Awaited<ReturnType<typeof openApp>>;

const sha = (text: string) => createHash("sha256").update(text).digest("hex");

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
        description: "For the reach tests.",
        tags: ["test"],
        author: { name: "Someone" },
        version: "1.0.0",
        source: { repo: `someone/pocket-${name}`, commit },
        files: Object.entries(files).map(([file, text]) => ({
            name: file,
            sha256: sha(text),
            size: Buffer.byteLength(text),
        })),
        pocketApi: 1,
        minPocket: "0.14.0",
        declares: {
            extensions: [name],
            tools: [],
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

function theme(name: string, files: Record<string, string>, commit: string) {
    const inner = Object.fromEntries(
        Object.entries(files).map(([file, text]) => [`${name}/${file}`, text]),
    );
    const made = entry(name, inner, commit);

    return {
        kind: "theme",
        name,
        title: made.title,
        description: made.description,
        tags: made.tags,
        author: made.author,
        version: made.version,
        source: made.source,
        files: made.files,
        themeApi: 1,
        minPocket: "0.14.0",
    };
}

async function index(...entries: unknown[]) {
    served.set(INDEX, JSON.stringify({ format: 1, extensions: entries }));

    return app.gallery.listing(true);
}

before(async () => {
    app = await openApp(scriptedModel(), dataDir);

    app.gallery.fetch = async (url) => {
        asked.push(url);

        return served.has(url) ? new Response(served.get(url)) : new Response("", { status: 404 });
    };
});

after(async () => {
    await app?.close();
    cleanUp();
});

test("the scan names the hosts in address literals, and leaves out those that name no outside service", () => {
    const scanned = scanCode(`
        const a = "https://api.openai.com/v1/chat";
        const b = 'http://example.com:8080/x';
        const c = \`https://hooks.slack.com/services/T0\`;
        const ws = "wss://stream.example.net/live";
        const left = [
            "http://localhost:3000", "http://127.0.0.1/x", "http://127.1.2.3",
            "http://www.w3.org/2000/svg", "https://example.com", "https://www.example.org/x",
            "https://schema.org/Thing", "https://json-schema.org/draft/2020-12/schema",
            "https://github.com/someone/pocket-thing", "https://github.com/someone/thing/tree/main/src",
            "https://github.com/someone/thing/issues/4#top",
        ];
    `);

    assert.deepEqual(scanned.network, ["api.openai.com", "hooks.slack.com", "stream.example.net"]);
    // The Git credential setting resembles a host but names no service.
    assert.deepEqual(
        scanCode(
            'run("git", ["-c", "credential.https://github.com.helper=", "fetch"]); const u = "https://github.com";',
        ).network,
        ["github.com"],
    );
});

test("a call to the network with no host in the code is told as built at run time", () => {
    for (const code of [
        "const r = await fetch(url);",
        "await fetchPublic(`https://${host}/x`);",
        "const s = new WebSocket(address);",
        "https.request(options);",
    ]) {
        assert.deepEqual(scanCode(code).network, ["addresses it builds at run time"], code);
    }

    assert.deepEqual(scanCode('prefetch(x); const u = "https://a.dev/x"; fetch(u);').network, [
        "a.dev",
        "addresses it builds at run time",
    ]);
    assert.deepEqual(scanCode('fetch( "https://a.dev/x");').network, ["a.dev"]);
    assert.deepEqual(scanCode("prefetch(x);").network, []);
});

test("the scan names the keys the code reads", () => {
    const scanned = scanCode(`
        const a = await host.getApiKey("openrouter");
        const b = process.env.GITHUB_TOKEN;
        const c = process.env["MY_SECRET"];
        const { OPENAI_API_KEY, HOME } = process.env;
        const d = process.env.PATH;
        const e = join(agentDir, "auth.json");
    `);

    assert.deepEqual(scanned.keys, [
        "Pi's auth.json",
        "environment variable GITHUB_TOKEN",
        "environment variable MY_SECRET",
        "environment variable OPENAI_API_KEY",
        "openrouter key from Pi",
    ]);
    assert.deepEqual(scanCode("const x = process.env.HOME;").keys, []);
    // This template names a key prefix, not a complete secret.
    assert.deepEqual(scanCode("env[`GIT_CONFIG_KEY_${n}`] = name;").keys, []);
});

test("the scan names the programs the code starts", () => {
    const scanned = scanCode(`
        import { spawn, execFileSync } from "node:child_process";
        spawn("git", ["status"]);
        execFileSync('/usr/bin/ffmpeg', ["-i", file]);
        childProcess.exec("rg --files " + dir);
        cp.execSync(\`tar -xf \${archive}\`);
        /abc/.exec("abc");
        regex.exec("not a program");
    `);

    assert.deepEqual(scanned.programs, ["/usr/bin/ffmpeg", "git", "rg", "tar"]);
    assert.deepEqual(
        scanCode('import { spawn } from "node:child_process";\nspawn(cmd, args);').programs,
        ["programs it names at run time"],
    );
    assert.deepEqual(scanCode("const x = 1;").programs, []);
});

test("the scan reports code that can load or run unnamed programs", () => {
    const calls = "eval|new Function|Function|getBuiltinModule|process.binding|process.dlopen";
    const dynamic = ["programs it names at run time"];
    const network = ["a.dev", "addresses it builds at run time"];

    for (const call of `${calls}|import|require|require("./a.node")`.split("|")) {
        assert.deepEqual(scanCode(`${call}(name)`).programs, dynamic);
    }

    assert.deepEqual(scanCode('d3.select(".node"); "process.versions.node"').programs, []);
    assert.deepEqual(scanCode('require("a.node"); createRequire(url)("b.node")').programs, dynamic);
    assert.deepEqual(scanCode("import(`./l/${x}.js`); require(`${x}`)").programs, dynamic);
    assert.deepEqual(scanCode('fetch(`${base}/x`); "https://a.dev"').network, network);

    const start = performance.now();

    ['require("'.repeat(25_000), '"' + "/".repeat(100_000)].forEach(scanCode);
    scanCode('"/'.repeat(256_000));
    scanCode("/x".repeat(128_000));
    scanCode("(/[".repeat(40_000));
    assert.ok(performance.now() - start < 1_000);
});

test("the scan names the files the code writes and the places it reads from", () => {
    assert.deepEqual(scanCode('await writeFile(join(dir, "a.json"), text);').files, [
        "files it writes",
    ]);
    assert.deepEqual(scanCode("fs.rmSync(dir, { recursive: true });").files, ["files it writes"]);
    assert.deepEqual(scanCode("await fsp.appendFile(p, line); await mkdir(d);").files, [
        "files it writes",
    ]);
    assert.deepEqual(
        scanCode(`
            const a = join(homedir(), ".pi/agent/settings.json");
            const b = "~/.pi/agent/skills/";
            await writeFile(x, y);
        `).files,
        ["files it writes", "~/.pi/agent/settings.json", "~/.pi/agent/skills"],
    );
    assert.deepEqual(scanCode('const home = homedir(); join(home, ".bashrc");').files, [
        "your home folder",
    ]);
    assert.deepEqual(scanCode("const x = readFile(p);").files, []);
});

test("the scan ignores comments, but not an address in a string that holds two slashes", () => {
    const code = `
        // fetch("https://line.example.dev/x"); spawn("lineprog");
        /* const k = process.env.BLOCK_TOKEN;
           await writeFile(a, b); "https://block.dev" */
        const ok = "https://real.dev/a//b"; // after it: https://after.dev
        const re = /["']\\/\\/x/; const next = "https://next.dev";
    `;

    assert.ok(!stripComments(code).includes("line.example"));
    assert.equal(stripComments(code).split("\n").length, code.split("\n").length);
    assert.deepEqual(scanCode(code), {
        network: ["next.dev", "real.dev"],
        keys: [],
        programs: [],
        files: [],
    });
});

test("a regular expression after a keyword does not hide the code after it", () => {
    for (const keyword of "return typeof void delete throw case in of new else do yield await".split(
        " ",
    )) {
        const scanned = scanCode(
            `${keyword} /^https?:\\/\\//.test(u); spawn("sh"); fetch("https://evil.example.net/x");`,
        );

        assert.deepEqual(scanned.network, ["evil.example.net"], keyword);
        assert.deepEqual(scanned.programs, ["sh"], keyword);
    }
});

test("division after contextual identifiers or spaced property keywords keeps later calls", () => {
    for (const expression of ["of", "yield", "await", "a. return", `a.${" ".repeat(24)}return`]) {
        const scanned = scanCode(
            `${expression} / 2 // /*\nspawn("sh"); fetch("https://risk.example.net/x");\n// */`,
        );

        assert.deepEqual(scanned.network, ["risk.example.net"], expression);
        assert.deepEqual(scanned.programs, ["sh"], expression);
    }
});

test("the scan of several files is one scan of their code", () => {
    const scanned = scanFiles([
        { name: "a.ts", text: 'const u = "https://one.dev";' },
        { name: "b.ts", text: 'const v = "https://two.dev"; fetch(w);\nwriteFile(a, b);' },
    ]);

    assert.deepEqual(scanned.network, ["one.dev", "two.dev", "addresses it builds at run time"]);
    assert.deepEqual(scanned.files, ["files it writes"]);
});

test("a theme's palette is read from its colors files, and null where it has none", () => {
    const dark = 'mode = "dark"\nbackground = "#101010"\nforeground = "#eeeeee" # light on dark\n';
    const light = 'background = "#ffffff"\nforeground = "#111111"\n';

    assert.deepEqual(themePalette(dark, light), {
        colors: { mode: "dark", background: "#101010", foreground: "#eeeeee" },
        colorsLight: { background: "#ffffff", foreground: "#111111", mode: "light" },
    });
    assert.deepEqual(themePalette(dark, undefined), {
        colors: { mode: "dark", background: "#101010", foreground: "#eeeeee" },
        colorsLight: null,
    });
    assert.deepEqual(themePalette(undefined, undefined), { colors: null, colorsLight: null });
});

const chat = `/** Calls out. */
import { spawn } from "node:child_process";
// fetch("https://ignored.dev")
export default () => { spawn("git", ["log"]); fetch("https://api.chat.dev/v1"); };
`;

test("the answer covers extensions and themes, reads only code and palette files, and keeps one failure to its entry", async () => {
    const commit = "a".repeat(40);
    const bad = "b".repeat(40);
    const ok = theme(
        "dusk",
        {
            "theme.json": '{"themeApi":1,"name":"Dusk"}',
            "colors.toml": 'mode = "dark"\nbackground = "#101010"\nforeground = "#eeeeee"\n',
            "fonts/dusk.woff2": "not really a font",
        },
        commit,
    );

    await index(
        entry("chatty", { "chatty.ts": chat, "chatty/logo.png": "png bytes" }, commit),
        entry("tampered", { "tampered.ts": "export default () => {};\n" }, bad),
        ok,
    );
    served.set(
        `https://raw.githubusercontent.com/someone/pocket-tampered/${bad}/tampered.ts`,
        "export default () => { fetch('https://evil.dev'); };\n",
    );
    asked = [];

    const { entries: answered } = await app.gallery.reach();

    assert.deepEqual(Object.keys(answered).sort(), ["chatty", "dusk", "tampered"]);

    for (const each of Object.values(answered)) {
        assert.match(each.pin, /^[0-9a-f]{64}$/);
    }

    const entries = Object.fromEntries(
        Object.entries(answered).map(([name, { pin: _pin, ...rest }]) => [name, rest]),
    );

    assert.deepEqual(entries.chatty, {
        kind: "extension",
        commit,
        scanned: {
            network: ["api.chat.dev"],
            keys: [],
            programs: ["git"],
            files: [],
        },
    });
    assert.deepEqual(entries.dusk, {
        kind: "theme",
        commit,
        palette: {
            colors: { mode: "dark", background: "#101010", foreground: "#eeeeee" },
            colorsLight: null,
        },
    });
    assert.equal(entries.tampered?.kind, "extension");
    assert.equal(entries.tampered?.commit, bad);
    assert.match((entries.tampered as { error: string }).error, /SHA-256/);
    assert.ok(!("scanned" in entries.tampered!));
    assert.deepEqual(
        asked.filter((url) => /logo|woff2|theme\.json/.test(url)),
        [],
    );
});

test("a second call downloads nothing for what was read, and a failure is tried again", async () => {
    asked = [];

    const again = await app.gallery.reach();

    assert.deepEqual(asked, [
        `https://raw.githubusercontent.com/someone/pocket-tampered/${"b".repeat(40)}/tampered.ts`,
    ]);
    assert.equal(again.entries.chatty?.kind, "extension");
    assert.ok("error" in again.entries.tampered!);

    const fixed = "export default () => {};\n";

    await index(
        entry("tampered", { "tampered.ts": fixed }, "c".repeat(40)),
        entry("chatty", { "chatty.ts": chat, "chatty/logo.png": "png bytes" }, "a".repeat(40)),
    );
    asked = [];

    const next = await app.gallery.reach();

    assert.deepEqual((next.entries.tampered as { scanned: unknown }).scanned, {
        network: [],
        keys: [],
        programs: [],
        files: [],
    });
    assert.ok(asked.every((url) => url.includes("pocket-tampered")));

    asked = [];
    await app.gallery.reach();
    assert.deepEqual(asked, []);

    const kept = JSON.parse(readFileSync(join(dataDir, "gallery", "reach.json"), "utf8")) as {
        results: Record<string, unknown>;
    };

    assert.equal(Object.keys(kept.results).length, 2);
});

test("a changed pin at the same commit is scanned again", async () => {
    const commit = "d".repeat(40);

    await index(entry("pinned", { "pinned.ts": 'fetch("https://one.dev");\n' }, commit));
    assert.deepEqual(
        ((await app.gallery.reach()).entries.pinned as { scanned: { network: string[] } }).scanned
            .network,
        ["one.dev"],
    );

    await index(entry("pinned", { "pinned.ts": 'fetch("https://two.dev");\n' }, commit));
    assert.deepEqual(
        ((await app.gallery.reach()).entries.pinned as { scanned: { network: string[] } }).scanned
            .network,
        ["two.dev"],
    );
});

test("an extension installed at the same commit is read from its installed files", async () => {
    const commit = "e".repeat(40);
    const code =
        'import { homedir } from "node:os";\nconst h = homedir();\nfetch("https://own.dev");\n';
    const url = (name: string) =>
        `https://raw.githubusercontent.com/someone/pocket-${name}/${commit}/${name}.ts`;

    await index(
        entry("here", { "here.ts": code }, commit),
        entry("edited", { "edited.ts": code }, commit),
    );

    for (const name of ["here", "edited"]) {
        const pin = (await app.gallery.listing(false)).entries.find(
            (each) => each.name === name,
        )?.pin;

        await app.gallery.install(name, pin);
        assert.ok(existsSync(join(dataDir, "extensions", `${name}.ts`)));
    }

    // An unchanged install must work offline; an edited install must use the pinned download.
    served.delete(url("here"));
    writeFileSync(join(dataDir, "extensions", "edited.ts"), 'fetch("https://not-pinned.dev");\n');
    asked = [];

    const { entries } = await app.gallery.reach();
    const scanned = {
        network: ["own.dev"],
        keys: [],
        programs: [],
        files: ["your home folder"],
    };

    assert.deepEqual((entries.here as { scanned: unknown }).scanned, scanned);
    assert.deepEqual((entries.edited as { scanned: unknown }).scanned, scanned);
    assert.deepEqual(asked, [url("edited")]);
});
