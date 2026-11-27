// Review round 12: a tool lease is keyed by its task and its call, so a nested call that ends does not release another;
// `memory` is host work except for a session-scope add, and a sandboxed tree's project is looked up without the host; every
// lease grant is followed directly by its `try`.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { after, test } from "node:test";
import { cleanUp, newSession, openApp, owner, root, scriptedModel, type App } from "./helpers.ts";
import { FakeProvider, sandboxOptions } from "./sandbox-fake.ts";

let app: App | undefined;

after(async () => {
    await app?.close();
    cleanUp();
});

async function boot(name: string) {
    app = await openApp(
        scriptedModel(),
        join(root, `data-round12-${name}`),
        undefined,
        undefined,
        sandboxOptions(),
    );
    await app.sandboxes.register(new FakeProvider(), "fake.ts");

    return app;
}

const server = join(import.meta.dirname, "..", "src", "server");

test("two nested calls of one task hold leases of their own: the first to end releases only its own", async () => {
    const { toolKey } = (await import("../src/server/sandbox.ts")) as {
        toolKey: (task: unknown, call: unknown) => string;
    };
    const a = await boot("keys");
    const dir = join(root, "round12-keys");

    mkdirSync(dir);
    const id = await newSession(a, dir);
    const slow = toolKey(7, "call-slow");
    const quick = toolKey(7, "call-quick");

    assert.notEqual(slow, quick, "one task, two calls, two keys");
    // The slow call names a host path; the quick one is a host tool that ends first.
    assert.equal(
        await a.sandboxes.beforeTool(id, slow, "artifact", { path: "page.html" }),
        undefined,
    );
    assert.equal(await a.sandboxes.beforeTool(id, quick, "watch_pr", {}), undefined);
    assert.equal(a.sandboxes.leasesOf(id).length, 2);
    a.sandboxes.toolEnded(quick);
    assert.equal(a.sandboxes.leasesOf(id).length, 1);
    await assert.rejects(a.sandboxes.turnOn(id, owner(a)), /artifact call that is running/);
    a.sandboxes.toolEnded(slow);
    await a.sandboxes.turnOn(id, owner(a));
});

test("both hooks key the lease by the task and the call", () => {
    const text = readFileSync(join(server, "app.ts"), "utf8");

    assert.match(text, /beforeTool\(\s*api\.conversationId,\s*toolKey\(api\.taskId, call\.id\)/);
    assert.match(text, /toolEnded\(toolKey\(api\.taskId, _call\.id\)\)/);
    assert.doesNotMatch(text, /String\(api\.taskId\)/);
});

test("memory is host work, except for a session-scope add; a sandboxed tree looks up no project on this machine", async () => {
    const a = await boot("memory");
    const repo = join(root, "round12-repo");
    const git = (...args: string[]) => execFileSync("git", args, { cwd: repo, encoding: "utf8" });

    mkdirSync(join(repo, "app"), { recursive: true });
    git("init", "-q");
    writeFileSync(join(repo, "app", "x.txt"), "x");
    const plain = await newSession(a, join(repo, "app"));

    assert.equal(
        await a.sandboxes.beforeTool(plain, "m0", "memory", {
            action: "add",
            scope: "session",
            text: "x",
        }),
        undefined,
    );
    assert.equal(a.sandboxes.leasesOf(plain).length, 0, "a session lesson looks up nothing");
    assert.equal(
        await a.sandboxes.beforeTool(plain, "m1", "memory", { action: "list" }),
        undefined,
    );
    assert.equal(a.sandboxes.leasesOf(plain).length, 1, "a list resolves the folder and asks Git");
    await assert.rejects(a.sandboxes.turnOn(plain, owner(a)), /memory call that is running/);
    a.sandboxes.toolEnded("m1");
    await a.sandboxes.turnOn(plain, owner(a));
    // Sandboxed: the project is the folder as stated, not what Git on this machine says about the guest's folder.
    const project = await a.memory.project(plain, undefined);

    assert.equal(project?.key, join(repo, "app"));
});

test("every lease grant is followed directly by its `try`, and the list of grant sites is closed", () => {
    const sites: string[] = [];

    for (const file of walk(server)) {
        const text = readFileSync(file, "utf8");

        for (const match of text.matchAll(/(?:sandboxes\s*\.lease\(|this\.lease\(|#grant\()/g)) {
            sites.push(`${relative(server, file)}@${match[0].replace(/\s+/g, "")}`);
        }
    }

    assert.deepEqual(
        sites.sort(),
        [
            "extension-commands.ts@sandboxes.lease(",
            // The definition and its two calls (the lease and the tool call), and the environment handle's grant.
            "sandbox.ts@#grant(",
            "sandbox.ts@#grant(",
            "sandbox.ts@#grant(",
            "sandbox.ts@this.lease(",
        ].sort(),
        "a new grant site must be looked at",
    );
    const commands = readFileSync(join(server, "extension-commands.ts"), "utf8");

    // After the grant, the first step is a `try` whose `finally` ends the lease; the memo that can throw is inside it.
    assert.match(commands, /try \{\s*await runtime\.memo\("started", true, context\);/);
    assert.match(
        commands,
        /\} finally \{\s*this\.#running\.delete\(String\(task\.id\)\);\s*lease\.end\(\);/,
    );
});

function walk(dir: string): string[] {
    return readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
        entry.isDirectory()
            ? walk(join(dir, entry.name))
            : entry.name.endsWith(".ts")
              ? [join(dir, entry.name)]
              : [],
    );
}
