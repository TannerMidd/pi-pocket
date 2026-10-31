import { cleanUp, newSession, openApp, owner, root, scriptedModel } from "./helpers.ts";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { ConversationId } from "@earendil-works/pi-durable";
import type { CheckReport } from "../src/server/design/system-types.ts";
import { ArtifactAssetDoc, ArtifactBodyDoc, ArtifactsDoc } from "../src/server/docs.ts";
import { createHandler } from "../src/server/http.ts";
import {
    cleanChange,
    cleanReport,
    DOCS_ID,
    LIMITS,
    revisionOf,
} from "../src/server/extensions/design/system-routes.ts";
import { loadDesignSystem } from "../src/server/extensions/design/system-api.ts";
import { publishAll, publishDesign } from "./design-fixtures.ts";
import { ferryPage, writeSystemFixture } from "./design-system-fixtures.ts";

let app: Awaited<ReturnType<typeof openApp>>;
let server: Server;
let base = "";
let session: ConversationId;
let bare: ConversationId;
let legacy: ConversationId;
let folder = "";
const people: Record<string, { token: string; id: string }> = {};

before(async () => {
    app = await openApp(scriptedModel(), join(root, "data"));
    server = createServer(
        createHandler({ app, listen: { host: "127.0.0.1", port: 0 }, restart: () => {} }),
    );
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;

    folder = join(root, "with-system");
    mkdirSync(folder, { recursive: true });
    writeSystemFixture(folder);

    const none = join(root, "no-system");
    const old = join(root, "old-system");

    mkdirSync(join(old, ".pi"), { recursive: true });
    mkdirSync(none, { recursive: true });
    writeFileSync(join(old, ".pi", "design-system.md"), "# Old\n\nAccent #3b6cf6.\n");

    session = await newSession(app, folder);
    bare = await newSession(app, none);
    legacy = await newSession(app, old);
    await publishAll(app, session);
    await publishDesign(app, session, {
        id: "ferry",
        title: "Ferry booking",
        content: ferryPage(loadDesignSystem(folder)!.compiled.css),
    });

    for (const [name, role, sessions] of [
        ["Gale", "guest", undefined],
        ["Vic", "viewer", undefined],
        ["Sid", "guest", [String(session)]],
    ] as const) {
        const added = app.config.addUser(name, role, sessions ? [...sessions] : undefined);

        people[name] = { token: added.token, id: added.user.id };
    }

    people.owner = { token: app.config.ownerToken, id: owner(app).id };
});

after(async () => {
    server.closeAllConnections();
    server.close();
    await app.close();
    cleanUp();
});

async function call(who: string, path: string, body?: unknown, id: ConversationId = session) {
    const response = await fetch(`${base}/api/x/design/c/${id}/${path}`, {
        method: body === undefined ? "GET" : "POST",
        headers: {
            authorization: `Bearer ${people[who]!.token}`,
            "x-pocket": "1",
            ...(body === undefined ? {} : { "content-type": "application/json" }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });

    return { status: response.status, data: (await response.json()) as Record<string, any> };
}

const read = async (who = "owner", id = session) => (await call(who, "system", undefined, id)).data;
const file = (...parts: string[]) => join(folder, ".pi", "design", ...parts);
const tokenOf = (data: Record<string, any>, name: string) =>
    data.system.tokens.find((each: { name: string }) => each.name === name);

test("everyone who sees the session reads the system, and a person invited to one session does not", async () => {
    const data = await read();

    assert.equal(data.system.name, "Harbor");
    assert.deepEqual(data.system.modes, ["light", "dark"]);
    assert.deepEqual(data.system.schemes, { light: "light", dark: "dark" });
    assert.ok(data.system.tokens.length > 50);
    assert.deepEqual(data.system.components.map((each: { slug: string }) => each.slug).sort(), [
        "badge",
        "button",
        "input",
    ]);
    assert.match(data.system.guidelines, /^# Harbor/);
    assert.deepEqual(data.system.problems, []);
    assert.match(data.system.revision, /^[0-9a-f]{16}$/);
    assert.ok(data.system.dist["tokens.css"] > 0);
    assert.equal(data.system.compiled, undefined);
    assert.equal(typeof data.system.componentsCss, "string");

    assert.deepEqual(await read("Vic"), data);
    assert.deepEqual(await read("Gale"), data);
    // Invited to one session: a module's web part is for the whole app, so there is none for them.
    assert.equal((await call("Sid", "system")).status, 404);
    assert.equal((await call("owner", "system", undefined, 99999 as ConversationId)).status, 404);
});

test("the revision answers `unchanged`, and a project with no system says what it has instead", async () => {
    const data = await read();
    const same = (await call("owner", `system?revision=${data.system.revision}`)).data;

    assert.deepEqual(same, { unchanged: true, revision: data.system.revision });
    assert.equal((await call("owner", "system?revision=nope")).data.system.name, "Harbor");
    assert.deepEqual(await read("owner", bare), { system: null, legacy: null });

    const old = await read("owner", legacy);

    assert.equal(old.system, null);
    assert.ok(old.legacy > 10);
    const hidden = join(root, "linked");

    mkdirSync(join(hidden, ".pi"), { recursive: true });
    symlinkSync(join(folder, ".pi", "design"), join(hidden, ".pi", "design"));

    const linked = await newSession(app, hidden);

    const refused = await call("owner", "system", undefined, linked);

    assert.equal(refused.status, 400);
    assert.match(refused.data.error, /symlink/);
});

test("a save changes tokens in a mode, writes the files, and answers with the system", async () => {
    const before = await read();
    const saved = await call("owner", "system", {
        set: [
            { mode: "light", token: "color.accent.default", value: "#e8590c" },
            { mode: "dark", token: "color.accent.default", value: "{color.red.400}" },
        ],
        baseRevision: before.system.revision,
    });

    assert.equal(saved.status, 200);
    assert.equal(saved.data.ok, true);
    assert.equal(tokenOf(saved.data, "color.accent.default").modes.light.value, "#e8590c");
    assert.equal(tokenOf(saved.data, "color.accent.default").modes.dark.alias, "color.red.400");
    assert.notEqual(saved.data.system.revision, before.system.revision);
    assert.equal(
        JSON.parse(readFileSync(file("tokens.json"), "utf8")).color.accent.default.$value,
        "#e8590c",
    );
    assert.equal(
        JSON.parse(readFileSync(file("tokens.dark.json"), "utf8")).color.accent.default.$value,
        "{color.red.400}",
    );
    assert.match(
        readFileSync(file("dist", "tokens.css"), "utf8"),
        /--color-accent-default: #e8590c/,
    );
    assert.deepEqual((await read()).system.revision, saved.data.system.revision);

    // A viewer cannot save (the route is for those who steer: the path answers a viewer as one that only reads); someone who steers can.
    assert.ok([404, 405].includes((await call("Vic", "system", { guidelines: "x" })).status));
    assert.equal(
        (
            await call("Gale", "system", {
                set: [{ mode: "light", token: "color.accent.default", value: "#3b6cf6" }],
            })
        ).data.ok,
        true,
    );
});

test("a mode gives a token back to the default mode with a removal, and a shadow is saved by its parts with their links", async () => {
    const before = await read();

    assert.ok(before.system.overrides.dark.includes("color.border.strong"));
    assert.equal(before.system.overrides.light, undefined, "the default mode sets every token");

    for (const remove of [
        [{ mode: "light", token: "color.border.strong" }],
        [{ mode: "dark", token: "color.border.focus" }],
        [{ mode: "dark", token: "color.nothing" }],
        [{ mode: "sepia", token: "color.border.strong" }],
        [{ mode: 5, token: "color.border.strong" }],
        [{ mode: "dark" }],
    ]) {
        const refused = await call("owner", "system", { remove });

        assert.equal(refused.status, 400, JSON.stringify(remove));
    }

    assert.equal(
        JSON.parse(readFileSync(file("tokens.dark.json"), "utf8")).color.border.strong !==
            undefined,
        true,
    );

    const light = tokenOf(before, "color.border.strong").modes.light;
    const saved = await call("owner", "system", {
        remove: [{ mode: "dark", token: "color.border.strong" }],
        baseRevision: before.system.revision,
    });

    assert.equal(saved.status, 200);
    assert.equal(saved.data.ok, true);
    assert.equal(
        JSON.parse(readFileSync(file("tokens.dark.json"), "utf8")).color?.border?.strong,
        undefined,
    );
    assert.equal(saved.data.system.overrides.dark.includes("color.border.strong"), false);
    assert.deepEqual(tokenOf(saved.data, "color.border.strong").modes.dark.value, light.value);

    const result = await call("owner", "system", {
        set: [
            {
                mode: "light",
                token: "shadow.lg",
                value: {
                    color: "{color.scrim.40}",
                    offsetX: { value: 0, unit: "px" },
                    offsetY: "{space.6}",
                    blur: "{space.12}",
                    spread: { value: -12, unit: "px" },
                },
            },
        ],
    });

    assert.equal(result.data.ok, true);

    const lg = JSON.parse(readFileSync(file("tokens.json"), "utf8")).shadow.lg.$value;

    assert.equal(lg.offsetY, "{space.6}");
    assert.equal(lg.color, "{color.scrim.40}");

    const parts = tokenOf(result.data, "shadow.lg").modes.light.parts;

    assert.equal(parts["offset-y"], "var(--space-6)");
    assert.equal(parts.color, "var(--color-scrim-40)");
    assert.match(
        readFileSync(file("dist", "tokens.css"), "utf8"),
        /--shadow-lg: 0px var\(--space-6\)/,
    );
});

test("a save that the engine refuses answers in words and changes nothing", async () => {
    const before = await read();
    const refused = await call("owner", "system", {
        set: [{ mode: "light", token: "color.accent.hover", value: "{color.nope.at.all}" }],
    });

    assert.equal(refused.status, 200);
    assert.equal(refused.data.ok, false);
    assert.equal(typeof refused.data.error, "string");
    assert.ok(refused.data.error.length > 0);
    assert.ok(Array.isArray(refused.data.problems));
    assert.equal((await read()).system.revision, before.system.revision);

    // The words are for a person: the engine's own are written for Pi ("call again").
    assert.doesNotMatch(refused.data.error, /call again/i);
    assert.match(refused.data.error, /^Not saved: /);
    assert.ok(refused.data.problems.length > 0);
    assert.ok(
        refused.data.problems.every(
            (each: { message: string; level: string }) => typeof each.message === "string",
        ),
    );

    // A mode that is not there, and a token that is not there: the engine would make a file and a token of them, and the
    // view only changes what is there.
    for (const entry of [
        { mode: "neon", token: "color.accent.default", value: "#fff" },
        { mode: "light", token: "no.such.token", value: "#fff" },
        { mode: "light", token: "color.accent", value: "#fff" },
    ]) {
        assert.equal(
            (await call("owner", "system", { set: [entry] })).status,
            400,
            JSON.stringify(entry),
        );
    }

    assert.ok(!existsSync(file("tokens.neon.json")));
    assert.equal((await read()).system.revision, before.system.revision);
});

test("a save made on an older revision is refused, and the one made on the newest goes through", async () => {
    const first = await read();

    await call("owner", "system", {
        set: [{ mode: "light", token: "space.4", value: { value: 20, unit: "px" } }],
    });

    const stale = await call("owner", "system", {
        set: [{ mode: "light", token: "space.4", value: { value: 24, unit: "px" } }],
        baseRevision: first.system.revision,
    });

    assert.equal(stale.status, 409);
    assert.match(stale.data.error, /changed since/);
    assert.deepEqual(tokenOf(await read(), "space.4").modes.light.value, { value: 20, unit: "px" });

    const now = await read();
    const fresh = await call("owner", "system", {
        set: [{ mode: "light", token: "space.4", value: { value: 16, unit: "px" } }],
        baseRevision: now.system.revision,
    });

    assert.equal(fresh.data.ok, true);
});

test("a save is shape-checked: what it carries, its sizes, and what a person may not write", async () => {
    const send = (body: unknown) => call("owner", "system", body);
    const good = { mode: "light", token: "color.accent.default", value: "#3b6cf6" };

    for (const [name, body] of Object.entries({
        "nothing to save": {},
        "a field it has not got": { tokens: { color: {} } },
        "components are Pi's": { components: { button: "<x>" } },
        "set that is no list": { set: "x" },
        "set that is an object": { set: { mode: "light" } },
        "an entry that is no object": { set: [1] },
        "no mode": { set: [{ token: "a.b", value: 1 }] },
        "a mode that is no slug": { set: [{ ...good, mode: "Light Mode" }] },
        "a token with a path out": { set: [{ ...good, token: "../etc.passwd" }] },
        "a token with braces": { set: [{ ...good, token: "a.{b}" }] },
        "a token that is a place on every object": { set: [{ ...good, token: "a.__proto__.b" }] },
        "a token called constructor": { set: [{ ...good, token: "constructor" }] },
        "a token that is not text": { set: [{ ...good, token: 5 }] },
        "no value": { set: [{ mode: "light", token: "a.b" }] },
        "a null value": { set: [{ ...good, value: null }] },
        "a value that is too deep": {
            set: [{ ...good, value: { a: { b: { c: { d: { e: { f: 1 } } } } } } }],
        },
        "a value with a list that is too long": {
            set: [{ ...good, value: Array.from({ length: 33 }, () => 1) }],
        },
        "a value with a key that is no name": { set: [{ ...good, value: { "a b": 1 } }] },
        "too many changes": { set: Array.from({ length: LIMITS.set + 1 }, () => good) },
        "guidelines that are not text": { guidelines: 5 },
        "guidelines that are too long": { guidelines: "x".repeat(LIMITS.guidelines + 1) },
        "modes that are a list": { modes: ["dark"] },
        "a mode with a bad name": { modes: { "Dark!": {} } },
        "a mode with a body": { modes: { fresh: { color: {} } } },
        "too many modes": {
            modes: Object.fromEntries(Array.from({ length: 9 }, (_, at) => [`m${at}x`, {}])),
        },
        "a revision that is not text": { guidelines: "x", baseRevision: 5 },
        "a revision that is too long": { guidelines: "x", baseRevision: "r".repeat(65) },
    })) {
        const answer = await send(body);

        assert.equal(answer.status, 400, name);
    }

    // Nothing was written through a name that is a place on every object.
    assert.equal(({} as Record<string, unknown>).polluted, undefined);
});

test("guidelines are saved as text, with no control characters, and modes are added and removed", async () => {
    const saved = await call("owner", "system", { guidelines: "# New\r\n\u0007Rules\n" });

    assert.equal(saved.data.ok, true);
    assert.equal(saved.data.system.guidelines, "# New\nRules\n");
    assert.equal(readFileSync(file("guidelines.md"), "utf8"), "# New\nRules\n");

    const added = await call("owner", "system", { modes: { "high-contrast": {} } });

    assert.equal(added.data.ok, true);
    assert.deepEqual(added.data.system.modes, ["light", "dark", "high-contrast"]);
    assert.deepEqual(
        tokenOf(added.data, "color.bg.canvas").modes["high-contrast"].value,
        tokenOf(added.data, "color.bg.canvas").modes.light.value,
    );
    assert.ok(existsSync(file("tokens.high-contrast.json")));

    const before = readFileSync(file("tokens.dark.json"), "utf8");

    assert.equal((await call("owner", "system", { modes: { dark: {} } })).status, 400);
    assert.equal((await call("owner", "system", { modes: { light: null } })).status, 400);
    assert.equal((await call("owner", "system", { modes: { nothere: null } })).status, 400);
    assert.equal(readFileSync(file("tokens.dark.json"), "utf8"), before);
    assert.ok(existsSync(file("tokens.json")));

    const removed = await call("owner", "system", { modes: { "high-contrast": null } });

    assert.equal(removed.data.ok, true);
    assert.deepEqual(removed.data.system.modes, ["light", "dark"]);
    assert.ok(!existsSync(file("tokens.high-contrast.json")));
});

test("what a browser sends is cut to a change before it goes to the engine", () => {
    const web = {
        error: (status: number, message: string) => Object.assign(new Error(message), { status }),
    };
    const { change, baseRevision } = cleanChange(web, {
        set: [
            { mode: "dark", token: "color.bg.canvas", value: "x".repeat(900), extra: "left out" },
        ],
        guidelines: "a\r\nb\u0000c",
        modes: { fresh: {}, gone: null },
        baseRevision: "abc",
    });

    assert.deepEqual(change.set, [
        { mode: "dark", token: "color.bg.canvas", value: "x".repeat(500) },
    ]);
    assert.equal(change.guidelines, "a\nbc");
    assert.deepEqual(change.modes, { fresh: {}, gone: null });
    assert.equal(baseRevision, "abc");

    assert.deepEqual(
        cleanChange(web, {
            remove: [{ mode: "dark", token: "color.bg.canvas", extra: "left out" }],
        }).change.remove,
        [{ mode: "dark", token: "color.bg.canvas" }],
    );
    assert.throws(() => cleanChange(web, { remove: [{ mode: "dark", token: "__proto__.x" }] }));
    assert.throws(() => cleanChange(web, { remove: "all" }));
    assert.throws(() =>
        cleanChange(web, { remove: Array(LIMITS.set + 1).fill({ mode: "dark", token: "a" }) }),
    );
});

test("a check of a design answers with a report that has a fixed shape, for those who steer", async () => {
    const checked = await call("owner", "system/check", {
        id: "ferry",
        colorScheme: "light",
        viewport: "mobile",
    });

    assert.equal(checked.status, 200);
    assert.equal(checked.data.id, "ferry");
    assert.equal(checked.data.version, 1);

    const report = checked.data.report as CheckReport;

    assert.equal(report.colorScheme, "light");
    assert.deepEqual(report.viewport, { width: 390, height: 844 });
    assert.equal(report.withoutSystem, false);
    assert.equal(report.summary.errors + report.summary.warnings, report.findings.length);
    assert.ok(
        report.findings.every(
            (each) => typeof each.message === "string" && ["error", "warning"].includes(each.level),
        ),
    );

    const inDark = await call("owner", "system/check", {
        id: "ferry",
        mode: "dark",
        viewport: "mobile",
    });

    assert.equal(inDark.status, 200);
    assert.equal((inDark.data.report as CheckReport).colorScheme, "dark");
    const noMode = await call("owner", "system/check", { id: "ferry", mode: "sepia" });

    assert.equal(noMode.status, 400);
    assert.match(String(noMode.data.error), /no mode "sepia"/);
    assert.equal((await call("owner", "system/check", { id: "ferry", mode: 5 })).status, 400);
    assert.equal((await call("owner", "system/check", { id: "ferry", mode: "" })).status, 400);

    // Nobody who cannot steer runs one (it draws the page on the server), and the body is checked.
    assert.equal((await call("Vic", "system/check", { id: "ferry" })).status, 404);
    assert.equal((await call("owner", "system/check", { id: "nope" })).status, 400);
    assert.equal((await call("owner", "system/check", {})).status, 400);
    assert.equal((await call("owner", "system/check", { id: "ferry", version: "1" })).status, 400);
    assert.equal((await call("owner", "system/check", { id: "ferry", version: 9 })).status, 400);
    assert.equal(
        (await call("owner", "system/check", { id: "ferry", colorScheme: "sepia" })).status,
        400,
    );
    assert.equal(
        (await call("owner", "system/check", { id: "ferry", viewport: "watch" })).status,
        400,
    );
    assert.equal((await call("owner", "system/check", { id: "../ferry" })).status, 400);
});

test("one tap fixes the exact matches: a new version with var() for each literal that is a token's, once for each key", async () => {
    const system = loadDesignSystem(folder)!;
    const hexOf = (name: string) =>
        system.tokens.find((each) => each.name === name)!.modes.light!.hex as string;
    // The page writes the text color and a border as the tokens' own values: exact matches. The blue is off the system.
    const page = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Exact</title>
<style>${system.compiled.css}
body { margin: 0; padding: 24px; background: ${hexOf("color.bg.canvas")}; font: 16px/1.5 var(--font-family-sans); }
.card { padding: 16px; background: ${hexOf("color.bg.surface")}; color: ${hexOf("color.text.primary")}; border: 1px solid ${hexOf("color.border.default")}; }
.note { color: #7ba3f8; }
</style></head><body><div class="card" data-pid="card"><h1 data-pid="title" style="margin:0;color:${hexOf("color.text.primary")}">Exact</h1><p class="note" data-pid="note">Off the system on purpose.</p></div><script>var s = "${hexOf("color.text.primary")}";</script></body></html>`;

    await publishDesign(app, session, { id: "exact", title: "Exact", content: page });

    const body = { id: "exact", mode: "light", viewport: "mobile" };
    const checked = await call("owner", "system/check", body);

    assert.equal(checked.status, 200);

    const fixable = (checked.data.report as { findings: { fixable?: boolean }[] }).findings.filter(
        (each) => each.fixable === true,
    );

    assert.ok(fixable.length >= 1, "an exact match is marked as one that a tap can fix");

    const key = "fix-key-0001";
    const fixed = await call("owner", "system/fix", { ...body, key });

    assert.equal(fixed.status, 200);
    assert.equal(fixed.data.version, 2);
    assert.ok(fixed.data.fixed >= 2, JSON.stringify(fixed.data));

    const bodyOf = async (version: number) =>
        (
            await app.harness.snapshot(
                ArtifactBodyDoc,
                session,
                `exact@${version}`,
                BACKGROUND_CONTEXT,
            )
        )?.content ?? "";
    const next = await bodyOf(2);

    // The role token is another color in dark, so the fix puts in the palette step that is this color in every mode.
    assert.match(next, /style="margin:0;color:var\(--color-gray-900\)"/);
    assert.ok(
        next.includes(".note { color: #7ba3f8; }"),
        "a value that is only close to a token is not guessed at",
    );
    assert.ok(
        next.includes(`var s = "${hexOf("color.text.primary")}";`),
        "scripts are not touched",
    );
    assert.equal(await bodyOf(1), page, "the version it came from is as it was");

    assert.equal((await call("owner", "system/fix", { ...body, key })).data.version, 2);

    const index = await app.harness.snapshot(ArtifactsDoc, session, BACKGROUND_CONTEXT);

    assert.equal(index?.items.exact!.versions.length, 2);
    assert.equal(index?.items.exact!.versions.at(-1)!.callId, `design-fix:${key}`);

    assert.equal((await call("owner", "system/fix", { ...body, key: "fix-key-0002" })).status, 409);
    assert.equal((await call("owner", "system/fix", body)).status, 400);
    assert.equal((await call("owner", "system/fix", { ...body, key: "no" })).status, 400);
    assert.equal(
        (await call("owner", "system/fix", { ...body, key: "fix-key-0003", mode: "sepia" })).status,
        400,
    );
    assert.equal(
        (await call("owner", "system/fix", { ...body, key: "fix-key-0004", id: "nope" })).status,
        400,
    );
    assert.equal((await call("Vic", "system/fix", { ...body, key: "fix-key-0005" })).status, 404);
});

test("a fix gives the new version the system's ds/ files as they are now, not the snapshot it was published with", async () => {
    const system = loadDesignSystem(folder)!;
    const hex = system.tokens.find((each) => each.name === "color.text.primary")!.modes.light!.hex;
    const page = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Stale</title><link rel="stylesheet" href="ds/tokens.css"><style>h1 { color: ${hex}; }</style></head><body><main data-pid="m"><h1 data-pid="t">Stale</h1></main></body></html>`;
    // Published when the system had none of its tokens yet: its ds/tokens.css is an empty snapshot.
    const stale = Buffer.from(":root {}\n");
    const hash = "0".repeat(64);

    await publishDesign(app, session, { id: "stale", title: "Stale", content: page });
    await app.harness.commit(async (tx) => {
        await tx.doc(ArtifactAssetDoc, hash, { base64: stale.toString("base64") });
        (await tx.doc(ArtifactsDoc, session)).items.stale!.versions[0]!.assets = {
            "ds/tokens.css": { hash, size: stale.length, type: "text/css" },
        };
    }, BACKGROUND_CONTEXT);

    const body = { id: "stale", mode: "light", viewport: "mobile", key: "fix-key-stale" };
    const fixed = await call("owner", "system/fix", body);

    assert.equal(fixed.status, 200, JSON.stringify(fixed.data));

    const index = await app.harness.snapshot(ArtifactsDoc, session, BACKGROUND_CONTEXT);
    const asset = index!.items.stale!.versions.at(-1)!.assets!["ds/tokens.css"]!;
    const stored = await app.harness.snapshot(ArtifactAssetDoc, asset.hash, BACKGROUND_CONTEXT);

    assert.equal(Buffer.from(stored!.base64, "base64").toString(), system.compiled.css);
});

test("a report from the check is cut to its fixed shape: the page's words are data", () => {
    const hostile = {
        viewport: { width: Number.NaN, height: 1e12 },
        colorScheme: "pink",
        withoutSystem: "yes",
        summary: { errors: 9999, warnings: -1, elements: "many", byRule: { x: 1 } },
        findings: [
            {
                rule: "contrast",
                level: "fatal",
                selector: "x".repeat(900),
                message: "m".repeat(900),
                value: 5,
                suggestion: "s".repeat(900),
                pid: "p\u0000q",
                rect: { x: Number.NaN, y: 1e12, width: 3.14159, height: "9" },
            },
            { rule: "made-up", level: "error", selector: "a", message: "dropped" },
            null,
            "x",
            ...Array.from({ length: 400 }, () => ({
                rule: "tap-target",
                level: "warning",
                selector: "b",
                message: "small",
            })),
        ],
    } as unknown as CheckReport;
    const clean = cleanReport(hostile);

    assert.equal(clean.colorScheme, "light");
    assert.equal(clean.withoutSystem, false);
    assert.equal(clean.viewport.width, 0);
    assert.equal(clean.findings.length, LIMITS.findings);
    assert.equal(clean.findings[0]!.level, "warning");
    assert.equal(clean.findings[0]!.selector.length, 500);
    assert.equal(clean.findings[0]!.message.length, 400);
    assert.equal(clean.findings[0]!.suggestion!.length, 300);
    assert.equal(clean.findings[0]!.value, undefined);
    assert.equal(clean.findings[0]!.pid, "p q");
    assert.deepEqual(clean.findings[0]!.rect, { x: 0, y: 1e7, width: 3.1, height: 0 });
    assert.ok(clean.findings.every((each) => each.rule !== ("made-up" as never)));
    assert.equal(clean.summary.errors, 0);
    assert.equal(clean.summary.warnings, LIMITS.findings);
    assert.equal(clean.summary.elements, 0);
    assert.deepEqual(clean.summary.byRule, { contrast: 1, "tap-target": LIMITS.findings - 1 });
    assert.deepEqual(cleanReport({} as CheckReport).findings, []);
});

test("the documentation page is published as a design, a version each time, once for each key", async () => {
    assert.equal((await call("Vic", "system/docs", { key: "key-docs-0001" })).status, 404);
    assert.equal((await call("owner", "system/docs", {})).status, 400);
    assert.equal((await call("owner", "system/docs", { key: "x" })).status, 400);
    assert.equal((await call("owner", "system/docs", { key: "has spaces here" })).status, 400);
    assert.equal((await call("owner", "system/docs", { key: "key-docs-0001" }, bare)).status, 404);

    const first = await call("owner", "system/docs", { key: "key-docs-0001" });

    assert.equal(first.status, 200);
    assert.deepEqual(first.data, { id: DOCS_ID, version: 1 });
    assert.equal((await call("owner", "system/docs", { key: "key-docs-0001" })).data.version, 1);
    assert.equal((await call("Gale", "system/docs", { key: "key-docs-0002" })).data.version, 2);

    const index = await app.harness.snapshot(
        ArtifactsDoc,
        session,
        (await import("@earendil-works/chord/context")).BACKGROUND_CONTEXT,
    );
    const meta = index!.items[DOCS_ID]!;

    assert.equal(meta.type, "html");
    assert.equal(meta.versions.length, 2);
    assert.match(meta.title, /Harbor/);

    const context = (await import("@earendil-works/chord/context")).BACKGROUND_CONTEXT;
    const body = await app.harness.snapshot(ArtifactBodyDoc, session, `${DOCS_ID}@2`, context);

    assert.match(body!.content, /^<!doctype html>/i);

    for (const [name, asset] of Object.entries(meta.versions.at(-1)!.assets ?? {})) {
        const stored = await app.harness.snapshot(ArtifactAssetDoc, asset.hash, context);

        assert.ok(
            stored !== undefined && Buffer.from(stored.base64, "base64").length === asset.size,
            name,
        );
    }

    const list = (await call("owner", "artifacts")).data.artifacts as { id: string }[];

    assert.ok(list.some((each) => each.id === DOCS_ID));
});

test("the generated files are exported as a zip in the session's folder", async () => {
    assert.equal((await call("Vic", "system/export", {})).status, 404);
    assert.equal((await call("owner", "system/export", {}, bare)).status, 404);

    const made = await call("owner", "system/export", {});

    assert.equal(made.status, 200);
    assert.equal(made.data.name, "harbor-tokens.zip");
    assert.equal(made.data.relative, "exports/harbor-tokens.zip");
    assert.equal(made.data.path, join(folder, "exports", "harbor-tokens.zip"));

    const bytes = readFileSync(made.data.path);

    assert.equal(bytes.subarray(0, 2).toString(), "PK");
    assert.equal(bytes.length, made.data.size);

    for (const name of ["tokens.css", "tailwind.css", "tokens.resolved.json", "components.css"]) {
        assert.ok(bytes.includes(Buffer.from(name)), name);
    }

    const download = await fetch(
        `${base}/api/c/${session}/download?path=${encodeURIComponent(made.data.relative)}`,
        {
            headers: { authorization: `Bearer ${people.owner!.token}`, "x-pocket": "1" },
        },
    );

    assert.equal(download.status, 200);
    assert.equal(Buffer.from(await download.arrayBuffer()).length, bytes.length);
});

test("a system with an error is not published or exported, and a revision is a short fingerprint", async () => {
    const broken = join(root, "broken");

    mkdirSync(broken, { recursive: true });
    writeSystemFixture(broken);
    writeFileSync(
        join(broken, ".pi", "design", "tokens.dark.json"),
        JSON.stringify({ color: { accent: { hover: { $value: "{color.missing}" } } } }),
    );

    const id = await newSession(app, broken);
    const data = await read("owner", id);

    assert.ok(data.system.problems.some((each: { level: string }) => each.level === "error"));
    assert.equal((await call("owner", "system/docs", { key: "key-broken-01" }, id)).status, 409);
    assert.equal((await call("owner", "system/export", {}, id)).status, 409);

    const system = loadDesignSystem(folder)!;
    const hex = system.tokens.find((each) => each.name === "color.text.primary")!.modes.light!.hex;
    const content = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>K</title><style>h1 { color: ${hex}; }</style></head><body><main data-pid="m"><h1 data-pid="t">K</h1></main></body></html>`;
    const fix = { id: "k", mode: "light", viewport: "mobile", key: "fix-key-broken" };

    await publishDesign(app, id, { id: "k", title: "K", content });
    assert.equal((await call("owner", "system/fix", fix, id)).status, 409);
    assert.equal(revisionOf(system), revisionOf(loadDesignSystem(folder)!));
    assert.match(revisionOf(system), /^[0-9a-f]{16}$/);
});

test("the check marks a finding as fixable only when the fix would change it", async () => {
    // Two rules set the color for one element: no place is certain to be its own, so the fix skips it.
    const content = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Two</title><style>.a p, .b p { color: #1c1e26; } .b p { color: #1c1e26; }</style></head><body><main><div class="a"><p>One</p></div></main></body></html>`;

    await publishDesign(app, session, { id: "two", title: "Two", content });
    const found = (
        await call("owner", "system/check", { id: "two", mode: "light", viewport: "mobile" })
    ).data.report.findings;

    assert.deepEqual(
        found.filter((each: { fixable?: boolean }) => each.fixable),
        [],
    );
});
