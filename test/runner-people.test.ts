// Per-person access to linked computers: a real App, a real WebSocket, and a real runner with its pi-env daemon.
import {
    type App,
    cleanUp,
    context,
    fakeTab,
    openApp,
    owner,
    root,
    scriptedModel,
    until,
} from "./helpers.ts";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import type { ConversationId } from "@earendil-works/pi-durable";
import { Runner, type RunnerSettings, type SessionQuestion } from "../src/runner/runner.ts";
import { base32, STEP_MS, totp } from "../src/runner/totp.ts";
import { ConfigStore, type User } from "../src/server/config.ts";
import { HttpError } from "../src/server/errors.ts";
import { createHandler } from "../src/server/http.ts";
import type { RunnerView } from "../src/server/runners.ts";

const there = join(root, "there");
// Pi can read a parent context file outside its approved folder. Other outside paths remain runner-restricted.
const outside = join(root, "AGENTS.md");
const settings: RunnerSettings = {};
const asked: SessionQuestion[] = [];
let app: App;
let server: Server;
let runner: Runner;
let address: string;
let runnerId: string;
let otherRunnerId: string;
let guest: User;
let stranger: User;
let id: ConversationId;
let tab: ReturnType<typeof fakeTab>;
let waiting = false;
const tokens = new Map<string, string>();

function person(name: string, role: User["role"], sessions?: string[]): User {
    const { user, token } = app.config.addUser(name, role, sessions);

    tokens.set(user.id, token);

    return user;
}

async function request<T = Record<string, unknown>>(
    user: User,
    path: string,
    body?: unknown,
    method = body === undefined ? "GET" : "POST",
    signal: AbortSignal = AbortSignal.timeout(20_000),
): Promise<{ status: number; body: T }> {
    const response = await fetch(`${address}/api/${path}`, {
        method,
        signal,
        headers: {
            authorization: `Bearer ${tokens.get(user.id) ?? app.config.ownerToken}`,
            "X-Pocket": "1",
            "content-type": "application/json",
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });

    return { status: response.status, body: (await response.json()) as T };
}

before(async () => {
    mkdirSync(join(there, "inner"), { recursive: true });
    writeFileSync(outside, "A context file above the session folder.\n");
    writeFileSync(join(there, "inside.txt"), "Inside the session.\n");
    app = await openApp(scriptedModel());
    app.config.lastModel = { provider: "faux", modelId: "faux-1", thinkingLevel: "off" };
    guest = person("Guest", "guest");
    stranger = person("Other guest", "guest");
    server = createServer(
        createHandler({ app, listen: { host: "127.0.0.1", port: 0 }, restart: () => {} }),
    );
    server.on("upgrade", (request, socket, head) => {
        if (!app.runners.upgrade(request, socket, head)) {
            socket.destroy();
        }
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    address = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const { code } = app.runners.makeCode("Laptop", owner(app).id);
    const linked = app.runners.redeem(code);

    runnerId = linked.id;
    otherRunnerId = app.config.addRunner("Another computer", owner(app).id).runner.id;
    runner = new Runner({
        link: { server: address, ...linked },
        version: "test",
        cwd: there,
        log: () => {},
        retryMs: [50, 100, 200],
        settings: () => settings,
        saveSettings: (change) => {
            Object.assign(settings, change);
        },
        ask: (question) => {
            asked.push(question);

            if (!waiting) {
                return Promise.resolve({ allow: true });
            }

            return new Promise((resolve) => {
                question.signal.addEventListener("abort", () => resolve({ allow: false }), {
                    once: true,
                });
            });
        },
    });
    runner.start();
    await until(() => app.runners.link(runnerId).state !== undefined, "the runner's state");
    // This computer already saved the owner's folder before another person starts a session there.
    await app.commands.createSession(owner(app), { runner: runnerId, cwd: there });
    assert.ok(settings.folders?.includes(there));
    // Saved folders skip questions only with the computer's existing Stop asking setting.
    settings.confirm = false;
});

after(async () => {
    await runner?.stop();
    await app?.close();
    server?.closeAllConnections();
    await new Promise((resolve) => server?.close(resolve));
    cleanUp();
});

describe("people granted a computer", () => {
    it("refuses an ungranted guest's sessions, list, folders, and approval requests", async () => {
        for (const response of [
            await request(guest, "sessions", { runner: runnerId, cwd: there }),
            await request(guest, "runners"),
            await request(guest, `runners/${runnerId}/fs`),
            await request(guest, `runners/${runnerId}/approval`, {
                id: "question",
                code: "123456",
            }),
            await request(guest, `runners/${runnerId}/approval`, {
                id: "question",
                withdraw: true,
            }),
        ]) {
            assert.equal(response.status, 403);
        }

        assert.equal(app.runners.mayUse(runnerId, guest), false);
        assert.equal(app.runners.mayUse("missing", owner(app)), false);
        assert.equal((await app.hello(guest)).runners, undefined);
        tab = fakeTab(undefined, guest);
        await app.attach(tab.client);
        assert.equal(tab.last("hello")?.runners, undefined);
    });

    it("lets only the linker grant people, validates the body, and saves unique existing ids", async () => {
        const otherOwner = person("Another owner", "owner");

        assert.equal(
            (await request(otherOwner, `runners/${runnerId}/users`, { users: [guest.id] })).status,
            403,
        );

        for (const body of [{}, { users: "guest" }, { users: [7] }, null, []]) {
            assert.equal(
                (await request(owner(app), `runners/${runnerId}/users`, body)).status,
                400,
            );
        }

        const granted = await request<RunnerView>(owner(app), `runners/${runnerId}/users`, {
            users: [guest.id, guest.id, "missing", owner(app).id, otherOwner.id],
        });

        assert.equal(granted.status, 200);
        assert.deepEqual(granted.body.users, [{ id: guest.id, name: guest.name }]);
        assert.deepEqual(app.config.runnerById(runnerId)?.users, [guest.id]);
        assert.deepEqual(new ConfigStore(app.dataDir).runnerById(runnerId)?.users, [guest.id]);
        assert.equal(app.runners.mayUse(runnerId, guest), true);
        assert.equal(app.runners.mayUse(runnerId, otherOwner), false);
        assert.deepEqual(
            (tab.last("runners") as unknown as RunnerView[]).map((runner) => runner.id),
            [runnerId],
        );
        assert.equal((tab.last("runners") as unknown as RunnerView[])[0]?.users, undefined);
    });

    it("starts in the computer's saved folder without asking the person at the runner", async () => {
        const before = asked.length;
        const created = await request<{ id: ConversationId }>(guest, "sessions", {
            runner: runnerId,
            cwd: there,
        });

        assert.equal(created.status, 200);
        id = created.body.id;
        assert.equal(app.runnerOf(id), runnerId);
        assert.equal(app.sessionMeta(id)?.createdBy, guest.id);
        assert.equal(asked.length, before, "saved folders belong to the computer, not the person");
        assert.equal(
            settings.sessions?.find((entry) => entry.id === app.runnerScope(id)?.id)?.person,
            guest.name,
        );
        // Grants do not change session visibility, even for other owners.
        assert.equal(app.canSee(guest, id), true);
        assert.equal(app.canSee(stranger, id), false);
        assert.equal(app.canSee(owner(app), id), false);
    });

    it("forks to the same computer and suggests its folder for copies", async () => {
        const { submissionId } = await app.commands.submit(id, guest, {
            text: "Hello from the guest",
            requestId: crypto.randomUUID(),
        });

        await (await app.harness.submission(submissionId, context))!.wait(context);
        const entries = (await (await app.conversation(id)).entries({}, 10, undefined, context))
            .items;
        const entryId = Number(entries.find((entry) => entry.kind === "pi.assistant")!.id);
        const before = asked.length;
        const copy = await request<{ id: ConversationId }>(guest, `c/${id}/fork`, {
            entryId,
            place: { runner: runnerId, cwd: there },
        });

        assert.equal(copy.status, 200);
        assert.equal(app.runnerOf(copy.body.id), runnerId);
        assert.equal(app.sessionMeta(copy.body.id)?.createdBy, guest.id);
        assert.equal(asked.length, before);
        assert.equal((await request(guest, `c/${id}/copy-place?runner=${runnerId}`)).status, 200);
        assert.equal(
            (await request(guest, `c/${id}/copy-place?runner=${otherRunnerId}`)).status,
            403,
        );
    });

    it("browses folders, keeps favorites, and gets only the granted computer in lists and hello", async () => {
        const folders = await request<{ dirs: { name: string }[] }>(
            guest,
            `runners/${runnerId}/fs?path=${encodeURIComponent(there)}`,
        );

        assert.equal(folders.status, 200);
        assert.ok(folders.body.dirs.some((entry) => entry.name === "inner"));
        assert.equal((await request(guest, `runners/${otherRunnerId}/fs`)).status, 403);
        const list = await request<RunnerView[]>(guest, "runners");

        assert.equal(list.status, 200);
        assert.deepEqual(
            list.body.map((runner) => runner.id),
            [runnerId],
        );
        assert.equal(list.body[0]?.users, undefined);
        // The computer's approvals list (every session's folder and person) stays the linker's and the owner's.
        await until(
            () => app.runners.list(owner(app)).some((runner) => runner.approvals !== undefined),
            "the computer's approvals state",
        );
        assert.equal(list.body[0]?.approvals, undefined);
        assert.ok(app.runners.list(guest).every((runner) => runner.approvals === undefined));
        const hello = await app.hello(guest);

        assert.deepEqual(
            hello.runners?.map((runner) => runner.id),
            [runnerId],
        );
        const fresh = fakeTab(undefined, guest);

        await app.attach(fresh.client);
        assert.deepEqual(
            (fresh.last("hello")?.runners as RunnerView[]).map((runner) => runner.id),
            [runnerId],
        );
        app.detach(fresh.client);
        const all = await request<RunnerView[]>(owner(app), "runners");

        assert.equal(all.body.length, 2);
        assert.deepEqual(all.body.find((runner) => runner.id === runnerId)?.users, [
            { id: guest.id, name: guest.name },
        ]);
        await app.folderFavorites.set(guest, { runner: runnerId, path: there, starred: true });
        assert.deepEqual((await app.folderFavorites.runners(guest))[runnerId], [there]);
    });

    it("approves a waiting session with a code and withdraws another waiting session", async () => {
        const secret = base32(Buffer.from("12345678901234567890"));
        const folder = join(root, "needs-code");
        const next = join(root, "withdrawn");

        mkdirSync(folder);
        mkdirSync(next);
        settings.totp = { secret };
        waiting = true;
        const creating = request<{ id: ConversationId }>(guest, "sessions", {
            runner: runnerId,
            cwd: folder,
        });
        const link = app.runners.link(runnerId);

        await until(() => link.questions.size === 1, "the question for an authenticator code");
        const question = [...link.questions.values()][0]!;

        assert.equal(question.totp, true);
        assert.equal(
            (
                await request(guest, `runners/${runnerId}/approval`, {
                    id: question.id,
                    code: totp(secret, Math.floor(Date.now() / STEP_MS)),
                })
            ).status,
            200,
        );
        assert.equal((await creating).status, 200);
        const controller = new AbortController();
        const withdrawing = request(
            guest,
            "sessions",
            { runner: runnerId, cwd: next },
            "POST",
            controller.signal,
        );

        await until(() => link.questions.size === 1, "the question to withdraw");
        assert.equal(
            (
                await request(guest, `runners/${runnerId}/approval`, {
                    id: [...link.questions.values()][0]!.id,
                    withdraw: true,
                })
            ).status,
            200,
        );
        await until(() => link.questions.size === 0, "the withdrawn question to end");
        // A new-session sheet also cancels its HTTP request, as waitOnComputer does.
        controller.abort();
        await assert.rejects(withdrawing, { name: "AbortError" });
        waiting = false;
        delete settings.totp;
    });

    it("does not let a granted guest change settings, approvals, access, name, or remove a computer", async () => {
        for (const action of [
            { action: "settings", code: "123456", change: { stopAsking: true } },
            { action: "settings", code: "123456", change: { name: "Renamed" } },
            { action: "revoke", session: "all" },
            { action: "remove-folder", folder: there },
        ]) {
            assert.equal(
                (await request(guest, `runners/${runnerId}/permissions`, { request: action }))
                    .status,
                403,
            );
        }

        assert.equal(
            (await request(guest, `runners/${runnerId}/users`, { users: [stranger.id] })).status,
            403,
        );
        assert.equal(
            (await request(guest, `runners/${runnerId}`, undefined, "DELETE")).status,
            403,
        );
        assert.equal((await request(guest, "runners/code", { name: "New name" })).status, 403);
        assert.equal((await request(guest, "runners/locks")).status, 403);
        assert.equal(
            (await request(guest, "runners/bans?address=127.0.0.1", undefined, "DELETE")).status,
            403,
        );
        assert.equal(
            (await request(guest, "settings", { sharedRunnerSessions: true })).status,
            403,
        );
        assert.equal(app.runners.stored(runnerId)?.name, "Laptop");
    });

    it("lets a granted guest read outside the session folder, but not an ungranted shared-session guest", async () => {
        await app.setSharedRunnerSessions(owner(app), true);
        assert.equal(app.canSee(stranger, id), true);
        const file = await app.workspace.viewFile(id, guest, outside);

        assert.equal(file.kind, "text");
        assert.equal(
            file.kind === "text" && file.text,
            "A context file above the session folder.\n",
        );
        const allowed = await request(guest, `c/${id}/view?path=${encodeURIComponent(outside)}`);

        assert.equal(allowed.status, 200);
        assert.equal(
            (await request(stranger, `c/${id}/view?path=${encodeURIComponent(outside)}`)).status,
            404,
        );
        assert.equal((await request(stranger, `c/${id}/view?path=inside.txt`)).status, 200);
        await app.setSharedRunnerSessions(owner(app), false);
    });

    it("does not grant people invited to one session, even with an empty session limit", async () => {
        const scoped = person("One session", "guest", [String(id)]);
        const empty = person("No sessions", "guest", []);

        app.config.setRunnerUsers(runnerId, [guest.id, scoped.id, empty.id]);
        assert.deepEqual(app.runners.stored(runnerId)?.users, [guest.id]);
        assert.equal(app.runners.mayUse(runnerId, scoped), false);
        assert.equal(app.runners.mayUse(runnerId, empty), false);
    });

    it("ends access when the guest becomes a viewer, without cleaning the saved grant", async () => {
        app.setAccess(owner(app), guest.id, { role: "viewer" });
        assert.deepEqual(app.runners.stored(runnerId)?.users, [guest.id]);
        assert.equal(app.runners.mayUse(runnerId, guest), false, "even a stale guest object fails");
        assert.deepEqual(tab.last("runners"), []);
        assert.deepEqual(await app.folderFavorites.runners(guest), {});

        for (const response of [
            await request(guest, "sessions", { runner: runnerId, cwd: there }),
            await request(guest, "runners"),
            await request(guest, `runners/${runnerId}/fs`),
        ]) {
            assert.equal(response.status, 403);
        }

        const viewer = app.config.userById(guest.id)!;

        assert.equal((await app.hello(viewer)).runners, undefined);
        // The session the guest started there no longer runs there at all, so no file of the computer is read.
        await assert.rejects(
            app.workspace.remoteFile(viewer, id, outside),
            (error: unknown) =>
                error instanceof HttpError &&
                error.status === 403 &&
                /can no longer use/.test(error.message),
        );
        app.setAccess(owner(app), guest.id, { role: "guest" });
        assert.equal(app.runners.mayUse(runnerId, guest), true);
    });

    it("stops a session the person already started, when their grant is withdrawn, and runs it again after", async () => {
        const shell = async () => app.envFor(id).exec("echo still-here", {}, context);

        assert.ok((await shell()).ok, "runs while granted");
        await request(owner(app), `runners/${runnerId}/users`, { users: [] });
        await assert.rejects(shell(), /can no longer use Laptop/);
        assert.equal((await request(guest, `c/${id}/shell`, { command: "echo no" })).status, 403);
        await request(owner(app), `runners/${runnerId}/users`, { users: [guest.id] });
        assert.ok((await shell()).ok, "runs again once chosen again");
    });

    it("shows and lets answer only the questions of sessions the person started", async () => {
        const link = app.runners.link(runnerId);
        const ownSession = app.runnerScope(id).id;
        const question = (session: string, id: string) => ({
            type: "approval-needed" as const,
            id,
            session,
            folder: there,
            permission: "session" as const,
            expired: true,
            broad: false,
            totp: true,
        });

        link.questions.set("theirs", question(ownSession, "theirs"));
        link.questions.set("others", question("not-their-session", "others"));

        try {
            type Listed = { questions?: { id: string }[] }[];
            const seen = (await request<Listed>(guest, "runners")).body;

            assert.deepEqual(
                seen[0]?.questions?.map((each) => each.id),
                ["theirs"],
            );

            const owners = (await request<Listed>(owner(app), "runners")).body;

            assert.deepEqual(owners[0]?.questions?.map((each) => each.id).sort(), [
                "others",
                "theirs",
            ]);
            assert.equal(
                (
                    await request(guest, `runners/${runnerId}/approval`, {
                        id: "others",
                        withdraw: true,
                    })
                ).status,
                404,
            );
            assert.equal(
                (
                    await request(guest, `runners/${runnerId}/approval`, {
                        id: "unknown",
                        withdraw: true,
                    })
                ).status,
                404,
            );
        } finally {
            link.questions.delete("theirs");
            link.questions.delete("others");
        }
    });

    it("reads only the folder of another person's session shared with them, not Pi's whole access", async () => {
        const ownerSession = await app.commands.createSession(owner(app), {
            runner: runnerId,
            cwd: there,
        });

        app.config.sharedRunnerSessions = true;

        try {
            await assert.rejects(
                app.workspace.remoteFile(guest, ownerSession.id, outside),
                (error: unknown) => error instanceof HttpError && error.status === 404,
            );
            // Their own session there still reads outside its folder, as Pi does.
            assert.equal((await app.workspace.remoteFile(guest, id, outside)).file, outside);
        } finally {
            app.config.sharedRunnerSessions = false;
        }
    });

    it("ends access when a grant is withdrawn or the person is removed", async () => {
        await request(owner(app), `runners/${runnerId}/users`, { users: [] });
        assert.equal(app.runners.mayUse(runnerId, guest), false);
        assert.deepEqual(tab.last("runners"), []);
        assert.equal((await request(guest, `runners/${runnerId}/fs`)).status, 403);
        await request(owner(app), `runners/${runnerId}/users`, { users: [guest.id] });
        app.removeUser(owner(app), guest.id);
        assert.equal(app.runners.mayUse(runnerId, guest), false);
        assert.deepEqual(app.runners.stored(runnerId)?.users, [guest.id]);
        assert.equal((await request(guest, "runners")).status, 401);
        await assert.rejects(
            app.commands.createSession(guest, { runner: runnerId, cwd: there }),
            (error: unknown) => error instanceof HttpError && error.status === 403,
        );
    });
    it("keeps the server up when a computer is removed while its session is open, and still archives it", async () => {
        const linked = app.runners.redeem(app.runners.makeCode("Spare", owner(app).id).code);
        const spare = new Runner({
            link: { server: address, ...linked },
            version: "test",
            cwd: there,
            log: () => {},
            retryMs: [50, 100],
            settings: () => ({ confirm: false, folders: [there] }),
            ask: () => Promise.resolve({ allow: true }),
        });
        const thrown: unknown[] = [];
        const record = (error: unknown) => thrown.push(error);

        process.on("uncaughtException", record);
        spare.start();
        spare.finished.catch(() => {});

        try {
            await until(() => app.runners.link(linked.id).online, "the spare computer online");

            const { id: spareSession } = await app.commands.createSession(owner(app), {
                cwd: there,
                runner: linked.id,
            });
            const open = fakeTab(spareSession, owner(app));

            await app.attach(open.client);
            await until(() => open.events.some((event) => event.event === "view"), "the view");
            app.runners.remove(linked.id);
            // The view is pushed again on a timer (\`room.ts\`): give it time to run.
            await new Promise((resolve) => setTimeout(resolve, 500));
            await app.commands.updateSession(spareSession, owner(app), { archived: true });
            assert.deepEqual(thrown, []);
            await assert.rejects(
                Promise.resolve().then(() => app.runnerScope(spareSession)),
                (error: unknown) =>
                    error instanceof HttpError &&
                    error.status === 403 &&
                    /was removed/.test(error.message),
            );
        } finally {
            process.off("uncaughtException", record);
            // It ended itself when the server removed it: stopping it again says so.
            await spare.stop().catch(() => {});
        }
    });
});
