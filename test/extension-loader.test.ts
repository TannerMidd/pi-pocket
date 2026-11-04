// The extension loader on its own, with a real registry: a version that fails part way through installing, a load that
// never finishes, and who hears about it all.
import {
    cleanUp,
    fakeTab,
    lastText,
    modelTexts,
    newSession,
    openApp,
    owner as appOwner,
    root,
    say,
    scriptedModel,
    until,
} from "./helpers.ts";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, test } from "node:test";
import { createRegistry, UsageDoc } from "@earendil-works/pi-durable";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { ExtensionWebs } from "../src/server/extension-web.ts";
import type { PocketHost } from "../src/server/host.ts";
import { ExtensionLoader } from "../src/server/reload.ts";

after(cleanUp);

/** What the test modules reach on `globalThis`: gates to hold their import, and counts of their cleanups. */
const shared = globalThis as unknown as {
    gates?: Record<string, Promise<void>>;
    cleaned?: Record<string, number>;
    checkpointIdentity?: unknown;
    localeStarted?: number;
};

shared.gates = {};
shared.cleaned = {};

let folders = 0;

/** A loader on fresh folders, with every drop-in on. */
function setUp(loadLimitMs?: number, changed?: () => void) {
    const directory = join(root, `loader-${++folders}`);
    const builtIn = join(directory, "built-in");
    const dropIn = join(directory, "drop-ins");

    mkdirSync(builtIn, { recursive: true });
    mkdirSync(dropIn, { recursive: true });

    const registry = createRegistry();
    const notices: { to: string; level: string; message: string }[] = [];
    const disabled = new Set<string>();
    const host = {
        notice: (level: string, message: string) =>
            notices.push({ to: "everyone", level, message }),
    } as unknown as PocketHost;
    const webs = new ExtensionWebs(changed === undefined ? {} : { changed });
    const loader = new ExtensionLoader(
        registry,
        host,
        { builtIn, dropIn },
        (file) => !disabled.has(file),
        {
            webs,
            notify: (level, message) => notices.push({ to: "owner", level, message }),
            ...(loadLimitMs === undefined ? {} : { loadLimitMs }),
        },
    );
    const installed = () =>
        registry
            .snapshot()
            .installed()
            .filter((extension) => extension.name.startsWith("t-"))
            .map((extension) => `${extension.name}@${(extension as { v?: number }).v}`);

    return { builtIn, dropIn, disabled, notices, webs, loader, installed };
}

/** A module that adds a route answering its version, and one extension. */
const gated = (name: string, version: number) => `/** ${name}, version ${version}. */
export default (_host, web) => {
	web.route("GET", "v", () => ({ v: ${version} }));
	return { name: "t-${name}", v: ${version} };
};
`;

/** A gate the test opens by hand. */
function gate(name: string): () => void {
    let open!: () => void;

    shared.gates![name] = new Promise<void>((resolve) => (open = resolve));

    return open;
}

const owner = { role: "owner" as const };

/** Read a real, committed layer from the loader's catalog. */
const localeOf = (webs: ExtensionWebs, id = "fr") =>
    webs.locales.snapshot().locales.find((each) => each.id === id);

const answer = (webs: ExtensionWebs, module: string) => {
    const found = webs.match(module, "GET", ["v"], owner);

    return found !== undefined && "route" in found
        ? (found.route.handle({} as never) as { v?: unknown })
        : undefined;
};

test("R08: a locale-only module can return void without installing an extension", async () => {
    const { dropIn, loader, webs, installed } = setUp();

    writeFileSync(
        join(dropIn, "locale-only.ts"),
        `/** Locale-only module. */
export default (_host, web) => {
    web.uiLocales([{ id: "fr", label: "Français", messages: { "ui.close": "Fermer" } }]);
};
`,
    );

    try {
        await assert.doesNotReject(
            async () => assert.deepEqual(await loader.reload("locale-only.ts"), []),
            "a valid locale-only module installs without a synthetic extension",
        );
        assert.equal(localeOf(webs)?.messages["ui.close"], "Fermer");
        assert.deepEqual(installed(), []);
        const info = loader.list().find((each) => each.file === "locale-only.ts");

        assert.equal(info?.enabled, true);
        assert.equal(info?.error, undefined);
        assert.ok(info?.web, "the module's locale declaration counts as web content");
    } finally {
        await loader.close();
    }
});

test("R10: invalid and throwing locale updates leave the previous module version installed", async () => {
    const { dropIn, loader, webs, installed } = setUp();
    const file = join(dropIn, "locale-atomic.ts");
    const source = (version: number, value: string, extra = "") => `/** Atomic locale update. */
export default (_host, web) => {
    web.uiLocales([{ id: "fr", label: "Français", messages: { "ui.close": ${value} } }]);
    web.route("GET", "v", () => ({ v: ${version} }));
    ${extra}
    return { name: "t-locale-atomic", v: ${version} };
};
`;

    try {
        writeFileSync(file, source(1, JSON.stringify("one")));
        await loader.reload("locale-atomic.ts");
        assert.deepEqual(installed(), ["t-locale-atomic@1"]);
        const prior = webs.locales.snapshot();

        assert.equal(localeOf(webs)?.messages["ui.close"], "one");
        writeFileSync(file, source(2, "42"));
        await assert.rejects(loader.reload("locale-atomic.ts"));
        assert.deepEqual(
            installed(),
            ["t-locale-atomic@1"],
            "a rejected package keeps the old extension",
        );
        assert.deepEqual(
            answer(webs, "locale-atomic"),
            { v: 1 },
            "a rejected package keeps the old route",
        );
        assert.deepEqual(
            webs.locales.snapshot(),
            prior,
            "a rejected package retains the old catalog and revision",
        );
        assert.ok(loader.list().find((each) => each.file === "locale-atomic.ts")?.error);

        writeFileSync(
            file,
            source(
                3,
                JSON.stringify("three"),
                'throw new Error("failure after locale registration");',
            ),
        );
        await assert.rejects(
            loader.reload("locale-atomic.ts"),
            /failure after locale registration/,
        );
        assert.deepEqual(installed(), ["t-locale-atomic@1"]);
        assert.deepEqual(answer(webs, "locale-atomic"), { v: 1 });
        assert.deepEqual(
            webs.locales.snapshot(),
            prior,
            "a thrown update cannot publish locale text",
        );
    } finally {
        await loader.close();
    }
});

test("R10: a timed-out or overtaken locale update cannot install later", async () => {
    const { dropIn, disabled, loader, webs, installed } = setUp(400);
    const file = join(dropIn, "locale-race.ts");
    const source = (version: number, wait = false) => `/** Locale race. */
export default async (_host, web) => {
    web.uiLocales([{ id: "fr", label: "Français", messages: { "ui.close": "version ${version}" } }]);
    web.route("GET", "v", () => ({ v: ${version} }));
    globalThis.localeStarted = ${version};
    ${wait ? "await globalThis.gates.localeRace;" : ""}
    return { name: "t-locale-race", v: ${version} };
};
`;
    let open = gate("localeRace");

    try {
        writeFileSync(file, source(1));
        await loader.reload("locale-race.ts");
        writeFileSync(file, source(2, true));
        await assert.rejects(loader.reload("locale-race.ts"), /did not finish loading in time/);
        assert.deepEqual(installed(), ["t-locale-race@1"]);
        open();
        await new Promise((resolve) => setTimeout(resolve, 20));
        assert.deepEqual(answer(webs, "locale-race"), { v: 1 }, "a late timeout cannot publish");
        assert.equal(localeOf(webs)?.messages["ui.close"], "version 1");

        open = gate("localeRace");
        writeFileSync(file, source(3, true));
        const stale = loader.reload("locale-race.ts");

        await until(() => shared.localeStarted === 3, "the old locale load is staged");
        writeFileSync(file, source(4));
        await loader.reload("locale-race.ts");
        open();
        await stale;
        assert.deepEqual(installed(), ["t-locale-race@4"]);
        assert.deepEqual(answer(webs, "locale-race"), { v: 4 }, "an overtaken load cannot publish");
        assert.equal(localeOf(webs)?.messages["ui.close"], "version 4");

        open = gate("localeRace");
        writeFileSync(file, source(5, true));
        const disabledLoad = loader.reload("locale-race.ts");

        await until(() => shared.localeStarted === 5, "the disabled locale load is staged");
        disabled.add("locale-race.ts");
        await loader.apply("locale-race.ts");
        open();
        await disabledLoad;
        assert.deepEqual(installed(), []);
        assert.equal(answer(webs, "locale-race"), undefined, "a disabled load cannot return later");
        assert.equal(localeOf(webs), undefined);
    } finally {
        open();
        await loader.close();
    }
});

test("R10: loader failures name the module to the owner", async () => {
    const { dropIn, loader, notices } = setUp();

    writeFileSync(
        join(dropIn, "broken-locale.ts"),
        `/** Broken locale. */
export default (_host, web) => web.uiLocales([{ id: "fr", label: "Français", messages: {} }]);
`,
    );

    try {
        await loader.loadAll();
        const warning = notices.find((each) => each.level === "error");

        assert.ok(warning, "the failed module is reported");
        assert.equal(warning.to, "owner");
        assert.match(warning.message, /broken-locale\.ts/);
    } finally {
        await loader.close();
    }
});

test("R09 and R17: real loader order survives reload and removing an overlay reveals its predecessor", async () => {
    const { builtIn, dropIn, disabled, loader, webs } = setUp();
    const source = (label: string, close: string, back?: string) => `/** Locale layer. */
export default (_host, web) => web.uiLocales([${JSON.stringify({
        id: "fr-ca",
        label,
        messages: { "ui.close": close, ...(back === undefined ? {} : { "ui.back": back }) },
    })}]);
`;

    writeFileSync(
        join(builtIn, "browser.ts"),
        source("Builtin browser", "builtin browser", "back from browser"),
    );
    writeFileSync(join(builtIn, "prompt.ts"), source("Builtin prompt", "builtin prompt"));
    writeFileSync(join(builtIn, "z-built.ts"), source("Other builtin", "other builtin"));
    writeFileSync(join(dropIn, "a-drop.ts"), source("Drop A", "drop A"));
    writeFileSync(join(dropIn, "z-drop.ts"), source("Drop Z", "drop Z"));

    try {
        assert.deepEqual(loader.files(), [
            "prompt.ts",
            "browser.ts",
            "z-built.ts",
            "a-drop.ts",
            "z-drop.ts",
        ]);
        await loader.loadAll();
        assert.equal(localeOf(webs, "fr-CA")?.label, "Drop Z");
        assert.equal(localeOf(webs, "fr-CA")?.messages["ui.close"], "drop Z");
        assert.equal(localeOf(webs, "fr-CA")?.messages["ui.back"], "back from browser");
        writeFileSync(join(dropIn, "a-drop.ts"), source("Drop A revised", "drop A revised"));
        await loader.reload("a-drop.ts");
        assert.equal(localeOf(webs, "fr-CA")?.messages["ui.close"], "drop Z");
        disabled.add("z-drop.ts");
        await loader.apply("z-drop.ts");
        assert.equal(localeOf(webs, "fr-CA")?.label, "Drop A revised");
        assert.equal(localeOf(webs, "fr-CA")?.messages["ui.close"], "drop A revised");
        disabled.add("a-drop.ts");
        await loader.apply("a-drop.ts");
        assert.equal(localeOf(webs, "fr-CA")?.messages["ui.close"], "other builtin");
        disabled.add("z-built.ts");
        await loader.apply("z-built.ts");
        assert.equal(localeOf(webs, "fr-CA")?.messages["ui.close"], "builtin browser");
        disabled.add("browser.ts");
        await loader.apply("browser.ts");
        assert.equal(localeOf(webs, "fr-CA")?.messages["ui.close"], "builtin prompt");
        assert.equal(localeOf(webs, "fr-CA")?.messages["ui.back"], undefined);
        assert.equal(localeOf(webs, "fr"), undefined, "a parent tag is not substituted for fr-CA");
        assert.equal(
            localeOf(webs, "fr-FR"),
            undefined,
            "a different regional variant is not substituted",
        );
    } finally {
        await loader.close();
    }
});

test("R09: loader layers do not follow the order in which asynchronous modules finish", async () => {
    const { dropIn, loader, webs } = setUp(2000);
    const open = gate("localeOrder");

    writeFileSync(
        join(dropIn, "a-order.ts"),
        `/** Lower layer. */
export default async (_host, web) => {
    web.uiLocales([{ id: "fr", label: "Lower", messages: { "ui.close": "lower" } }]);
    globalThis.localeStarted = 10;
    await globalThis.gates.localeOrder;
};
`,
    );
    writeFileSync(
        join(dropIn, "z-order.ts"),
        `/** Upper layer. */
export default (_host, web) => web.uiLocales([{ id: "fr", label: "Upper", messages: { "ui.close": "upper" } }]);
`,
    );

    try {
        const lower = loader.reload("a-order.ts");

        await until(() => shared.localeStarted === 10, "the lower layer waits after registration");
        assert.equal(localeOf(webs), undefined, "a staged locale is not visible");
        await loader.reload("z-order.ts");
        assert.equal(localeOf(webs)?.messages["ui.close"], "upper");
        open();
        await lower;
        assert.equal(localeOf(webs)?.label, "Upper");
        assert.equal(
            localeOf(webs)?.messages["ui.close"],
            "upper",
            "the later completion stays below the upper layer",
        );
    } finally {
        open();
        await loader.close();
    }
});

test("legacy drop-in documents write through frozen helper definitions, reload, and restart", async () => {
    const data = join(root, "legacy-documents");
    const dropIn = join(data, "extensions");
    const file = join(dropIn, "legacy.ts");
    const source = (amount: number) => `/** Legacy documents. */
import { defineExtension, UsageDoc } from "@earendil-works/pi-durable";
import { Legacy, Family, Explicit } from "./legacy/docs.ts";
if (UsageDoc !== globalThis.checkpointIdentity) throw new Error("Durable identity changed");
export default () => defineExtension({ name: "legacy-documents", tools: [{
    name: "legacy_documents", description: "Count", parameters: { type: "object", properties: { read: { type: "boolean" } } },
    execute: async (args, api, context) => {
        if (!args.read) await api.commit(async tx => {
            (await tx.doc(Legacy, api.conversationId)).count += ${amount};
            (await tx.doc(Family, api.conversationId, "one", null)).count += ${amount};
            (await tx.doc(Explicit, api.conversationId)).count += ${amount};
        }, context);
        const a = await api.snapshot(Legacy, api.conversationId, context);
        const b = await api.snapshot(Family, api.conversationId, "one", context);
        const c = await api.snapshot(Explicit, api.conversationId, context);
        return { output: [{ type: "text", text: a.count + "/" + b.count + "/" + c.count }] };
    }
}] });`;

    mkdirSync(join(dropIn, "legacy"), { recursive: true });
    writeFileSync(
        join(dropIn, "legacy", "docs.ts"),
        `
import { defineDoc, defineDocFamily } from "@earendil-works/pi-durable";
const definition = Object.freeze({ kind: "x.legacy.count", version: 1, scope: "conversation", history: "latest", fork: "current", initial: () => ({ count: 0 }) });
export const Legacy = defineDoc(definition);
export const Family = defineDocFamily(Object.freeze({ ...definition, kind: "x.legacy.family", family: true }));
const checkpointWhen = () => true;
export const Explicit = defineDoc({ ...definition, kind: "x.legacy.explicit", checkpointWhen });
if ("checkpointWhen" in definition || Explicit.definition.checkpointWhen !== checkpointWhen) throw new Error("Definition changed");
`,
    );
    writeFileSync(file, source(1));
    shared.checkpointIdentity = UsageDoc;

    const model = () =>
        scriptedModel((input) => {
            const { role, text } = lastText(input as never);

            return role === "toolResult"
                ? fauxAssistantMessage([fauxText(text)])
                : fauxAssistantMessage(
                      [fauxToolCall("legacy_documents", { read: text.includes("read") })],
                      { stopReason: "toolUse" },
                  );
        });
    let app = await openApp(model(), data);

    try {
        const tab = fakeTab(undefined, appOwner(app));

        app.attach(tab.client);
        await app.setExtensionEnabled(appOwner(app), "legacy.ts", true);
        const warnings = tab.events.filter(
            (event) =>
                event.event === "notice" &&
                String(event.data.message).includes("has no checkpointWhen"),
        );

        assert.equal(warnings.length, 2);
        assert.ok(
            warnings.every((event) =>
                String(event.data.message).startsWith("legacy: document x.legacy."),
            ),
        );
        const id = await newSession(app);

        await say(app, id, "count");
        assert.match((await modelTexts(app, id)).at(-1)!, /1\/1\/1/);
        writeFileSync(file, source(2));
        await app.loader.reload("legacy.ts");
        await say(app, id, "count again");
        assert.match((await modelTexts(app, id)).at(-1)!, /3\/3\/3/);
        await app.close();
        app = await openApp(model(), data);
        await say(app, id, "read");
        assert.match((await modelTexts(app, id)).at(-1)!, /3\/3\/3/);
    } finally {
        await app.close();
    }
});

test("a version that fails part way through installing leaves the version before whole", async () => {
    const { dropIn, loader, webs, installed } = setUp();
    const module = (version: number, extra: string) => `/** Halves, version ${version}. */
export default (_host, web) => {
	web.route("GET", "v", () => ({ v: ${version} }));
	web.onDispose(() => { globalThis.cleaned.halves = (globalThis.cleaned.halves ?? 0) + 1; });
	return [{ name: "t-halves-a", v: ${version} }, ${extra}];
};
`;

    writeFileSync(join(dropIn, "halves.ts"), module(1, `{ name: "t-halves-b", v: 1 }`));
    await loader.reload("halves.ts");
    assert.deepEqual(installed(), ["t-halves-a@1", "t-halves-b@1"]);

    // The second extension of version 2 is refused by the registry (a bad section key), after the first installed.
    writeFileSync(
        join(dropIn, "halves.ts"),
        module(2, `{ name: "t-halves-c", v: 2, sections: [{ key: "BAD" }] }`),
    );
    await assert.rejects(loader.reload("halves.ts"), /Section key "BAD"/);
    assert.deepEqual(installed(), ["t-halves-a@1", "t-halves-b@1"]);
    assert.deepEqual(answer(webs, "halves"), { v: 1 });
    // Version 2's own cleanup ran; version 1's did not.
    assert.equal(shared.cleaned!.halves, 1);
});

test("what the loader says about modules goes to the owner alone", async () => {
    const { dropIn, loader, notices } = setUp();

    writeFileSync(join(dropIn, "tell.ts"), gated("tell", 1));
    await loader.reload("tell.ts");
    loader.watch();

    try {
        // An edit that fails to load names what failed: words for the owner, as they can quote a secret.
        writeFileSync(
            join(dropIn, "tell.ts"),
            `/** Tell. */\nexport default () => { throw new Error("provider said sk-not-for-guests"); };\n`,
        );
        await until(
            () => notices.some((each) => /sk-not-for-guests/.test(each.message)),
            "the failure is told",
        );
        assert.ok(notices.every((each) => each.to === "owner"));
    } finally {
        await loader.close();
    }
});

test("a load that never finishes fails after the limit, and installs nothing if it finishes later", async () => {
    const { dropIn, loader, webs } = setUp(200);

    writeFileSync(
        join(dropIn, "stuck.ts"),
        `/** Stuck: waits for ever while it sets up. */
export default async (_host, web) => {
	web.route("GET", "v", () => ({ v: "stuck" }));
	await globalThis.gates.stuck;
};
`,
    );
    const open = gate("stuck");

    await assert.rejects(
        loader.reload("stuck.ts"),
        /did not finish loading in time \(0\.2 s at most/,
    );
    open();
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(answer(webs, "stuck"), undefined);
});

test("a new version with other tools tells the tabs, though its browser module stayed the same", async () => {
    let told = 0;
    const { dropIn, loader } = setUp(undefined, () => told++);
    const module = (tool: string) => `/** Tooled. */
export default (_host, web) => {
	web.client("tooled.js", { access: "view" });
	return { name: "t-tooled", tools: [{ name: "${tool}", description: "", parameters: { type: "object" }, execute: () => {} }] };
};
`;

    writeFileSync(join(dropIn, "tooled.js"), "export default () => {};\n");
    writeFileSync(join(dropIn, "tooled.ts"), module("tooled_a"));
    await loader.reload("tooled.ts");
    // Its browser module may now describe the new tool's calls, and no longer the old one's.
    writeFileSync(join(dropIn, "tooled.ts"), module("tooled_b"));
    await loader.reload("tooled.ts");
    assert.equal(told, 2);
});

test("while paused for an update, an edited module loads nothing; after the pause, edits load again", async () => {
    const { dropIn, loader, installed } = setUp();

    writeFileSync(join(dropIn, "paused.ts"), gated("paused", 1));
    await loader.reload("paused.ts");
    loader.watch();

    try {
        loader.pause(true);
        writeFileSync(join(dropIn, "paused.ts"), gated("paused", 2));
        await new Promise((resolve) => setTimeout(resolve, 800));
        assert.deepEqual(installed(), ["t-paused@1"], "the new version does not load");

        loader.pause(false);
        writeFileSync(join(dropIn, "paused.ts"), gated("paused", 3));
        await until(() => installed().includes("t-paused@3"), "the edit after the pause loads");
    } finally {
        await loader.close();
    }
});
