// The extension loader on its own, with a real registry: a version that fails part way through installing, a load that
// never finishes, and who hears about it all.
import { cleanUp, root, until } from "./helpers.ts";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, test } from "node:test";
import { createRegistry } from "@earendil-works/pi-durable";
import { ExtensionWebs } from "../src/server/extension-web.ts";
import type { PocketHost } from "../src/server/host.ts";
import { ExtensionLoader } from "../src/server/reload.ts";

after(cleanUp);

/** What the test modules reach on `globalThis`: gates to hold their import, and counts of their cleanups. */
const shared = globalThis as unknown as {
    gates?: Record<string, Promise<void>>;
    cleaned?: Record<string, number>;
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
    const host = {
        notice: (level: string, message: string) =>
            notices.push({ to: "everyone", level, message }),
    } as unknown as PocketHost;
    const webs = new ExtensionWebs(changed === undefined ? {} : { changed });
    const loader = new ExtensionLoader(registry, host, { builtIn, dropIn }, () => true, {
        webs,
        notify: (level, message) => notices.push({ to: "owner", level, message }),
        ...(loadLimitMs === undefined ? {} : { loadLimitMs }),
    });
    const installed = () =>
        registry
            .snapshot()
            .installed()
            .filter((extension) => extension.name.startsWith("t-"))
            .map((extension) => `${extension.name}@${(extension as { v?: number }).v}`);

    return { dropIn, notices, webs, loader, installed };
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

const answer = (webs: ExtensionWebs, module: string) => {
    const found = webs.match(module, "GET", ["v"], owner);

    return found !== undefined && "route" in found
        ? (found.route.handle({} as never) as { v?: unknown })
        : undefined;
};

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
