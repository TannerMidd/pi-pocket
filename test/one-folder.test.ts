// One folder, all in the sandbox or none: while any session is sandboxed, no session without a sandbox uses an
// overlapping folder. Every way a session gets a folder or changes its sandbox is held to it, in one place in core.
import assert from "node:assert/strict";
import { mkdirSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { after, test } from "node:test";
import type { ConversationId } from "@earendil-works/pi-durable";
import type { User } from "../src/server/config.ts";
import { SandboxDoc } from "../src/server/docs.ts";
import { FakeDriver, sandboxOptions, useDriver } from "./gondolin-fake.ts";
import {
    cleanUp,
    context,
    fakeTab,
    newSession,
    openApp,
    owner,
    root,
    say,
    scriptedModel,
    type App,
} from "./helpers.ts";

after(cleanUp);

let opened = 0;
let driver: FakeDriver;

async function app(data?: string) {
    driver = new FakeDriver();
    useDriver(driver);
    const fresh = await openApp(
        scriptedModel(),
        data ?? join(root, `data-one-folder-${++opened}`),
        undefined,
        undefined,
        sandboxOptions(),
    );

    await fresh.setExtensionEnabled(owner(fresh), "gondolin.ts", true);

    return fresh;
}

function folder(name: string): string {
    const path = join(root, name);

    mkdirSync(path, { recursive: true });

    return path;
}

const on = async (running: App, id: ConversationId) => (await running.sandboxes.get(id)).on;

/** A person who steers and may not choose the sandbox. */
function guest(running: App): User {
    return running.config.addUser(`Gale-${++opened}`, "guest").user;
}

/** A sandboxed session in a new folder `name`, and the folder. */
async function sandboxedIn(running: App, name: string) {
    const path = folder(name);
    const id = await newSession(running, path);

    await running.sandboxes.set(id, owner(running), true);

    return { path, id };
}

test("turning the sandbox on is refused while a session without one uses the folder, and names up to three", async () => {
    const running = await app();

    try {
        const path = folder("one-on");
        const first = await newSession(running, path);
        const others = [] as ConversationId[];

        for (let index = 0; index < 4; index++) {
            others.push(await newSession(running, path));
        }

        await assert.rejects(
            running.sandboxes.set(first, owner(running), true),
            (error: Error) =>
                /4 other sessions use this folder/.test(error.message) &&
                /and 1 more/.test(error.message),
        );

        for (const other of others) {
            await running.commands.updateSession(other, owner(running), { archived: true });
        }

        // Archived sessions do not count.
        await running.sandboxes.set(first, owner(running), true);
        assert.equal(await on(running, first), true);
    } finally {
        useDriver(undefined);
        await running.close();
    }
});

test("turning the sandbox off is refused while another sandboxed session uses the folder", async () => {
    const running = await app();

    try {
        const { path, id } = await sandboxedIn(running, "one-off");
        const second = await newSession(running, join(path));

        assert.equal(await on(running, second), true, "it started in the sandbox");
        await assert.rejects(
            running.sandboxes.set(id, owner(running), false),
            /is in a sandbox and uses this folder/,
        );
        await running.commands.updateSession(second, owner(running), { archived: true });
        await running.sandboxes.set(id, owner(running), false);
        assert.equal(await on(running, id), false);
    } finally {
        useDriver(undefined);
        await running.close();
    }
});

test("a new session in the folder of a sandboxed one, inside it, around it, or by an alias, starts in the sandbox; a person who cannot choose is refused", async () => {
    const running = await app();

    try {
        const { path } = await sandboxedIn(running, "one-create");
        const inside = join(path, "sub");
        const alias = join(root, "one-create-alias");

        mkdirSync(inside);
        symlinkSync(path, alias);

        for (const where of [path, inside, alias]) {
            const id = await newSession(running, where);

            assert.equal(await on(running, id), true, where);
        }

        // A folder around it: the parent of the project holds it.
        const parent = folder("one-around");
        const child = join(parent, "child");

        mkdirSync(child);
        const inChild = await newSession(running, child);

        await running.sandboxes.set(inChild, owner(running), true);
        const around = await newSession(running, parent);

        assert.equal(await on(running, around), true, "a folder around a sandboxed one");

        const person = guest(running);

        await assert.rejects(
            running.commands.createSession(person, { cwd: path }),
            /must run in a sandbox too, and you cannot choose the sandbox/,
        );
        await assert.rejects(
            running.commands.createSession(person, { cwd: alias }),
            /cannot choose the sandbox/,
        );
        // Elsewhere, no sandbox is needed.
        const free = await running.commands.createSession(person, { cwd: folder("one-free") });

        assert.equal(await on(running, free.id), false);
    } finally {
        useDriver(undefined);
        await running.close();
    }
});

test("a fork, a linked session, a move, and a return from the archive join the sandbox of the folder, or are refused", async () => {
    const running = await app();

    try {
        const { path, id } = await sandboxedIn(running, "one-paths");
        const person = guest(running);
        const elsewhere = folder("one-paths-elsewhere");

        // A fork of a sandboxed session stays in its sandbox: before its first answer, and after.
        const early = await running.commands.fork(id, owner(running), {});

        assert.equal(await on(running, early.id), true, "a fork before the first answer");
        await say(running, id, "hi");
        const fork = await running.commands.fork(id, owner(running), {});

        assert.equal(await on(running, fork.id), true, "a fork after it");

        // A linked session that a session without a sandbox starts in that folder.
        const plain = await newSession(running, elsewhere);

        await say(running, plain, "hi");
        const linked = await running.linkedSessions.start(
            plain,
            { message: "go", cwd: path },
            "k1",
        );

        assert.equal(await on(running, linked.session), true, "a linked session");

        // A move into the folder.
        const mover = await newSession(running, folder("one-paths-mover"));

        await running.commands.configure(mover, owner(running), { cwd: path });
        assert.equal(await on(running, mover), true, "a move");

        const theirs = (
            await running.commands.createSession(person, { cwd: folder("one-paths-theirs") })
        ).id;

        await assert.rejects(
            running.commands.configure(theirs, person, { cwd: path }),
            /cannot choose the sandbox/,
        );
        assert.equal(running.cwdOf(theirs), folder("one-paths-theirs"), "it did not move");

        // A return from the archive, into a folder that has a sandbox now.
        const away = await newSession(running, folder("one-paths-away"));

        await running.commands.updateSession(away, owner(running), { archived: true });
        await running.commands
            .configure(away, owner(running), { cwd: path })
            .catch(() => undefined);
        await running.commands.updateSession(away, owner(running), { archived: false });
        assert.equal(await on(running, away), true, "brought back");

        // Her session is archived, and the folder has a sandbox when she brings it back: she cannot choose it.
        const hersPath = folder("one-paths-hers");
        const hers = (await running.commands.createSession(person, { cwd: hersPath })).id;

        await running.commands.updateSession(hers, person, { archived: true });
        const boxed = await newSession(running, hersPath);

        await running.sandboxes.set(boxed, owner(running), true);
        await assert.rejects(
            running.commands.updateSession(hers, person, { archived: false }),
            /cannot choose the sandbox/,
        );
        await running.commands.updateSession(hers, owner(running), { archived: false });
        assert.equal(await on(running, hers), true, "the owner brings it back, in the sandbox");
    } finally {
        useDriver(undefined);
        await running.close();
    }
});

test("sessions that were mixed before the rule start no VM, and the owner is told which", async () => {
    const data = join(root, "data-one-folder-mixed");
    const first = await app(data);
    const path = folder("one-mixed");
    let boxed: ConversationId;
    let plain: ConversationId;

    try {
        boxed = await newSession(first, path);
        plain = await newSession(first, path);
        // As an older Pi Pocket stored it: the sandbox is on for one, and the other has none.
        await first.harness.commit(async (tx) => {
            Object.assign(await tx.doc(SandboxDoc, boxed), { on: true });
        }, context);
    } finally {
        useDriver(undefined);
        await first.close();
    }

    const running = await app(data);

    try {
        const note = running.sandboxes.mixedNotice();

        assert.match(note ?? "", new RegExp(`#${Number(plain)} `));
        await running.sandboxes.settled(boxed);
        const result = await running.sandboxes.env(boxed, path).exec("true", {}, context);

        assert.equal(result.ok, false);
        assert.match(
            String(result.ok ? "" : result.error.message),
            /Sessions without a sandbox share this folder/,
        );
        assert.equal(driver.log.started.length, 0);

        const tab = fakeTab(undefined, owner(running));

        await running.attach(tab.client);
        assert.match(
            String(tab.last("notice")?.message),
            /share a folder with sessions in a sandbox/,
        );

        // Mended: the other is archived, and the sandbox may start again.
        await running.commands.updateSession(plain, owner(running), { archived: true });
        assert.equal(running.sandboxes.mixedNotice(), undefined);
    } finally {
        useDriver(undefined);
        await running.close();
    }
});
