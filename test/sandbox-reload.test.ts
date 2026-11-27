// A module that serves the sandbox is revoked and proved gone before it is replaced, turned off, or removed
// (design 2.4: module disable, manual reload, auto reload, removal). The replacement is awaited and serialised after the
// old teardown, so a new version never registers while the old one's VMs may still run.
import { cleanUp, root } from "./helpers.ts";
import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, test } from "node:test";
import { createRegistry } from "@earendil-works/pi-durable";
import { ExtensionWebs } from "../src/server/extension-web.ts";
import type { PocketHost } from "../src/server/host.ts";
import { ExtensionLoader } from "../src/server/reload.ts";
import { gate } from "./sandbox-fake.ts";

after(cleanUp);

const shared = globalThis as unknown as { order?: string[] };

shared.order = [];
let folders = 0;

function setUp(suspend: (file: string, leave: boolean) => Promise<void>, on: { value: boolean }) {
    const directory = join(root, `sandbox-reload-${++folders}`);
    const builtIn = join(directory, "built-in");
    const dropIn = join(directory, "drop-ins");

    mkdirSync(builtIn, { recursive: true });
    mkdirSync(dropIn, { recursive: true });
    const notices: string[] = [];
    const loader = new ExtensionLoader(
        createRegistry(),
        { notice: () => {} } as unknown as PocketHost,
        { builtIn, dropIn },
        () => on.value,
        {
            webs: new ExtensionWebs({}),
            notify: (_level, message) => notices.push(message),
            suspend,
        },
    );

    return { builtIn, dropIn, loader, notices };
}

const module = (version: number) => `/** Sandbox module, version ${version}. */
export default () => {
	globalThis.order.push("register v${version}");
	return { name: "t-sandbox" };
};
`;

test("a replacement registers only after the old module's sandbox is revoked and proved gone", async () => {
    const hold = gate();
    const on = { value: true };
    let armed = false;
    const { dropIn, loader } = setUp(async (file, leave) => {
        shared.order!.push(`suspend ${file} leave=${leave}`);

        if (armed) {
            await hold.wait();
        }

        shared.order!.push("proved gone");
    }, on);

    shared.order!.length = 0;
    writeFileSync(join(dropIn, "sandbox.ts"), module(1));
    await loader.loadAll();
    shared.order!.length = 0;
    armed = true;
    writeFileSync(join(dropIn, "sandbox.ts"), module(2));
    const reloading = loader.reload("sandbox.ts");

    await hold.reached;
    assert.deepEqual(shared.order, ["suspend sandbox.ts leave=false"], "v2 has not registered");
    hold.open();
    await reloading;
    assert.deepEqual(shared.order, [
        "suspend sandbox.ts leave=false",
        "proved gone",
        "register v2",
    ]);
});

test("a module whose sandbox cannot be proved gone does not install", async () => {
    const on = { value: true };
    const { dropIn, loader, notices } = setUp(
        () => Promise.reject(new Error("a VM would not stop")),
        on,
    );

    shared.order!.length = 0;
    writeFileSync(join(dropIn, "sandbox.ts"), module(1));
    await loader.loadAll().catch(() => {});
    // The first load also suspends nothing and registers nothing when its suspend fails: it never installs.
    assert.deepEqual(shared.order, []);
    assert.ok(notices.some((message) => /a VM would not stop/.test(message)));
});

test("turning a module off waits for the proof before it takes the module away", async () => {
    const hold = gate();
    const on = { value: true };
    const calls: string[] = [];
    let armed = false;
    const { dropIn, loader } = setUp(async (file, leave) => {
        calls.push(`${file} leave=${leave}`);

        if (armed) {
            await hold.wait();
        }
    }, on);

    writeFileSync(join(dropIn, "sandbox.ts"), module(1));
    await loader.loadAll();
    calls.length = 0;
    armed = true;
    on.value = false;
    const off = loader.apply("sandbox.ts");

    await hold.reached;
    assert.equal(loader.list().find((each) => each.file === "sandbox.ts")?.enabled, false);
    assert.ok(loader.extensionNames().includes("t-sandbox"), "still installed until the proof");
    hold.open();
    await off;
    assert.ok(!loader.extensionNames().includes("t-sandbox"));
    assert.deepEqual(calls, ["sandbox.ts leave=true"]);
    assert.equal(loader.list().find((each) => each.file === "sandbox.ts")?.enabled, false);
    rmSync(join(dropIn, "sandbox.ts"));
});
