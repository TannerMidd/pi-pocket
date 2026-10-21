// Drop-in extensions: the owner's own modules in the data folder load like built-in ones, but only once turned on.
import {
    type App,
    cleanUp,
    fakeTab,
    lastText,
    modelTexts,
    newSession,
    openApp,
    owner,
    root,
    say,
    scriptedModel,
    until,
} from "./helpers.ts";
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, test } from "node:test";
import type { FauxResponseStep } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";

const dataDir = join(root, "data");
const dropIns = join(dataDir, "extensions");

/** A drop-in that imports Pi Durable and pi-ai by name, offers a tool (with the old `content` result, which Pi Pocket still reads), and blocks bash with a hook. It returns a frozen list. */
const shout = (suffix: string) => `/** Shout offers a tool that shouts${suffix}. */
import { Type } from "@earendil-works/pi-ai";
import { defineExtension, defineTool, hook, ToolTask } from "@earendil-works/pi-durable";

export default () =>
	Object.freeze([defineExtension({
		name: "shout",
		tools: [
			defineTool({
				name: "shout",
				description: "Shout",
				parameters: Type.Object({ text: Type.String() }),
				execute: async (args) => ({ content: [{ type: "text", text: args.text.toUpperCase() + "${suffix}" }] }),
			}),
		],
		hooks: [hook(ToolTask, { beforeTool: (call) => (call.name === "bash" ? { block: "no shell while shouting" } : undefined) })],
	})]);
`;

const route: FauxResponseStep = (request) => {
    const { role, text } = lastText(request as never);
    const call = (name: string, args: Parameters<typeof fauxToolCall>[1]) =>
        fauxAssistantMessage([fauxToolCall(name, args)], { stopReason: "toolUse" });

    if (role === "toolResult") {
        return fauxAssistantMessage([fauxText(`tool said: ${text}`)]);
    }

    if (text.endsWith("shout hello")) {
        return call("shout", { text: "hello" });
    }

    if (text.endsWith("list files")) {
        return call("bash", { command: "ls" });
    }

    return fauxAssistantMessage([fauxText(`echo: ${text}`)]);
};

const model = scriptedModel(route);

let app: App;

before(async () => {
    mkdirSync(dropIns, { recursive: true });
    writeFileSync(join(dropIns, "shout.ts"), shout("!"));
    // The name of a built-in module: never loaded in its place.
    writeFileSync(
        join(dropIns, "plan.ts"),
        "export default () => { throw new Error('a drop-in must not replace a built-in'); };",
    );
    app = await openApp(model, dataDir);
});

after(async () => {
    await app?.close();
    cleanUp();
});

const module = (file: string) => app.loader.list().filter((each) => each.file === file);

test("drop-ins are off until the owner turns them on, and cannot replace a built-in module", async () => {
    const [listed] = module("shout.ts");

    assert.equal(listed?.source, "drop-in");
    assert.equal(listed?.enabled, false);
    assert.deepEqual(
        module("plan.ts").map((each) => each.source),
        ["built-in"],
    );
    // Where the server keeps files is the owner's to know.
    const scoped = app.config.addUser("Sid", "guest", ["1"]).user;
    const seen = await app.extensions(scoped);

    assert.equal(seen.dropIns, undefined);
    assert.equal(seen.modules.find((each) => each.file === "shout.ts")?.path, undefined);
    assert.equal((await app.extensions(owner(app))).dropIns, dropIns);
    // Pi Pocket's types beside the drop-ins: a link to them, never a module.
    assert.equal(
        realpathSync(join(dropIns, "_pocket.d.ts")),
        realpathSync(new URL("../types/pocket.d.ts", import.meta.url)),
    );
    assert.deepEqual(module("_pocket.d.ts"), []);
});

test("_pocket.d.ts: a link the owner pointed elsewhere stays, and only Pi Pocket's own copy is refreshed", async () => {
    const { linkTypes } = await import("../src/server/reload.ts");
    const types = realpathSync(new URL("../types/pocket.d.ts", import.meta.url));
    const folder = join(root, "types-link");
    const elsewhere = join(root, "their-pocket.d.ts");
    const link = join(folder, "_pocket.d.ts");

    mkdirSync(folder, { recursive: true });
    writeFileSync(elsewhere, "export {};\n");
    symlinkSync(elsewhere, link, "file");
    linkTypes(folder, types);
    assert.equal(realpathSync(link), elsewhere);

    // Where links cannot be made, Pi Pocket keeps a copy: a stale one is refreshed, a file of the owner's is not.
    rmSync(link);
    const mark =
        "// A copy of Pi Pocket's types/pocket.d.ts: Pi Pocket refreshes it at each start. Edits here are lost.\n";

    writeFileSync(link, `${mark}export type Old = 1;\n`);
    linkTypes(folder, types);
    assert.equal(readFileSync(link, "utf8"), mark + readFileSync(types, "utf8"));
    writeFileSync(link, "export type Mine = 1;\n");
    linkTypes(folder, types);
    assert.equal(readFileSync(link, "utf8"), "export type Mine = 1;\n");
});

test("a drop-in that is on gives Pi its tools and hooks, reloads when edited, and goes away when deleted", async () => {
    await app.setExtensionEnabled(owner(app), "shout.ts", true);
    assert.deepEqual(module("shout.ts")[0]?.extensions, [
        {
            name: "shout",
            tools: ["shout"],
            readOnlyTools: [],
            hooks: ["beforeTool"],
            sections: [],
            wraps: [],
        },
    ]);
    const id = await newSession(app);

    await say(app, id, "shout hello");
    await say(app, id, "list files");
    const said = (await modelTexts(app, id)).join("\n");

    assert.match(said, /tool said: HELLO!/);
    assert.match(said, /no shell while shouting/, "its hook runs on the built-in bash tool");

    // The owner's tab hears when the edited file is reloaded.
    const tab = fakeTab(undefined, owner(app));

    await app.attach(tab.client);
    app.loader.watch();

    try {
        writeFileSync(join(dropIns, "shout.ts"), shout("!!"));
        const notices = () =>
            tab.events
                .filter((each) => each.event === "notice")
                .map((each) => String(each.data.message));

        await until(
            () => notices().includes("Reloaded shout.ts: shout"),
            "the edited file to be reloaded",
        );
        await say(app, id, "shout hello");
        assert.match((await modelTexts(app, id)).join("\n"), /tool said: HELLO!!/);

        rmSync(join(dropIns, "shout.ts"));
        await until(
            () => notices().includes("Removed the drop-in extension shout.ts."),
            "the deleted drop-in to be uninstalled",
        );
        assert.equal(app.loader.extensionNames().includes("shout"), false);
        assert.deepEqual(module("shout.ts"), []);
    } finally {
        app.detach(tab.client);
    }
});

/** A drop-in with one extension, and one tool in it when `tool` is given. */
const named = (extension: string, tool?: string) => `/** ${extension}, for the names test. */
import { Type } from "@earendil-works/pi-ai";
import { defineExtension, defineTool } from "@earendil-works/pi-durable";

export default () =>
	defineExtension({
		name: "${extension}",
		tools: [${
            tool === undefined
                ? ""
                : `defineTool({ name: "${tool}", description: "x", parameters: Type.Object({}), execute: async () => ({ output: [{ type: "text", text: "${extension}" }] }) })`
        }],
	});
`;

test("a drop-in cannot take a name Pi Pocket keeps: it is refused", async () => {
    const refused = async (file: string, source: string, why: RegExp) => {
        writeFileSync(join(dropIns, file), source);
        await assert.rejects(app.setExtensionEnabled(owner(app), file, true), why);
        assert.deepEqual(module(file)[0]?.extensions, [], `${file} installed nothing`);
    };

    // Lancet Guard's name, while the guard is off: turning it on later would replace the drop-in, and the drop-in
    // turned off would remove the guard.
    await refused("guard-twin.ts", named("pocket-guard"), /pocket-guard is Pi Pocket's own/);
    await refused("my-bash.ts", named("my-bash", "bash"), /bash is a built-in tool's/);
});

/** A drop-in that says which version of the extension API it was written for, with a tool that returns `output`. */
const versioned = (name: string, api: string) => `/** Versioned ${name}. */
import { Type } from "@earendil-works/pi-ai";
import { defineExtension, defineTool } from "@earendil-works/pi-durable";

${api}

export default () =>
	defineExtension({
		name: "${name}",
		tools: [defineTool({ name: "${name}_tool", description: "x", parameters: Type.Object({}), execute: async () => ({ output: [{ type: "text", text: "ok" }] }) })],
	});
`;

test("a drop-in for API 2, 1, or none loads; one for a newer API is refused with a clear error", async () => {
    for (const [file, api] of [
        ["api-two.ts", "export const pocketApi = 2;"],
        ["api-one.ts", "export const pocketApi = 1;"],
        ["api-none.ts", ""],
    ] as const) {
        writeFileSync(
            join(dropIns, file),
            versioned(file.replace(/\W/g, "_").replace(/_ts$/, ""), api),
        );
        await app.setExtensionEnabled(owner(app), file, true);
        assert.equal(module(file)[0]?.error, undefined, `${file} loads`);
        assert.equal(module(file)[0]?.extensions.length, 1, `${file} installed its extension`);
    }

    writeFileSync(
        join(dropIns, "api-three.ts"),
        versioned("api_three", "export const pocketApi = 3;"),
    );
    await assert.rejects(
        app.setExtensionEnabled(owner(app), "api-three.ts", true),
        /needs version 3 of Pi Pocket's extension API, and this Pi Pocket has 2: update Pi Pocket/,
    );
    assert.deepEqual(module("api-three.ts")[0]?.extensions, [], "api-three.ts installed nothing");

    // Older than the oldest supported version (1), or not a version at all.
    writeFileSync(
        join(dropIns, "api-zero.ts"),
        versioned("api_zero", "export const pocketApi = 0;"),
    );
    await assert.rejects(
        app.setExtensionEnabled(owner(app), "api-zero.ts", true),
        /written for version 0 of Pi Pocket's extension API, and this Pi Pocket loads 1 to 2: update the module/,
    );
    writeFileSync(
        join(dropIns, "api-half.ts"),
        versioned("api_half", "export const pocketApi = 1.5;"),
    );
    await assert.rejects(
        app.setExtensionEnabled(owner(app), "api-half.ts", true),
        /needs version 1\.5 of Pi Pocket's extension API/,
    );

    // A draft for the gallery says the version that the module was written for, not this Pi Pocket's.
    assert.equal((await app.gallery.share("api-none.ts")).entry.pocketApi, 1);
    assert.equal((await app.gallery.share("api-one.ts")).entry.pocketApi, 1);
    assert.equal((await app.gallery.share("api-two.ts")).entry.pocketApi, 2);
});
