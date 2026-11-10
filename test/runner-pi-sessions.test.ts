// A real Pocket server, runner, and pi-env. Pi files stay outside every approved project folder.
import {
    type App,
    cleanUp,
    context,
    openApp,
    owner,
    root,
    scriptedModel,
    until,
} from "./helpers.ts";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { fauxAssistantMessage } from "@earendil-works/pi-ai/providers/faux";
import type { ConversationId } from "@earendil-works/pi-durable";
import { parseControl, type RunnerPiSession } from "../src/runner/protocol.ts";
import { Runner, type RunnerSettings, type SessionQuestion } from "../src/runner/runner.ts";
import { base32, STEP_MS, totp } from "../src/runner/totp.ts";
import { createHandler } from "../src/server/http.ts";
import type { User } from "../src/server/config.ts";
import type { PiSessionSummary } from "../src/server/pi-sessions.ts";
import { readPiSession } from "../src/server/pi-session-files.ts";

const project = join(root, "checkout-project");
const otherProject = join(root, "other-project");
const sessions = join(root, "computer-pi-files");
const asked: SessionQuestion[] = [];
const logs: string[] = [];
const settings: RunnerSettings = {};
const files = new Map<string, { path: string; id: string }>();
let app: App;
let server: Server;
let runner: Runner;
let runnerId: string;
let address: string;
let answer: boolean | undefined = true;

function save(name: string, cwd = project): { path: string; id: string } {
    const manager = SessionManager.inMemory(cwd);

    manager.appendSessionInfo(name);
    manager.appendModelChange("faux", "faux-1");
    manager.appendMessage({
        role: "user",
        content: "private-body-needle: check the cart",
        timestamp: 1,
    });
    manager.appendMessage(fauxAssistantMessage("private-reply-needle: use integer cents"));
    const path = join(sessions, `${name}.jsonl`);

    mkdirSync(sessions, { recursive: true });
    writeFileSync(
        path,
        [manager.getHeader(), ...manager.getEntries()]
            .map((entry) => JSON.stringify(entry))
            .join("\n") + "\n",
    );

    return { path, id: manager.getHeader()!.id };
}

function file(name: string): { path: string; id: string } {
    return files.get(name)!;
}

async function request<T = Record<string, unknown>>(
    route: string,
    body?: unknown,
    signal: AbortSignal = AbortSignal.timeout(20_000),
    token?: string,
): Promise<{ status: number; body: T }> {
    const response = await fetch(`${address}/api/pi-sessions${route}`, {
        method: body === undefined ? "GET" : "POST",
        signal,
        headers: {
            authorization: `Bearer ${token ?? app.config.ownerToken}`,
            "X-Pocket": "1",
            "content-type": "application/json",
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });

    return { status: response.status, body: (await response.json()) as T };
}

const preview = (name: string, signal?: AbortSignal) =>
    request<{
        last: { role: string; text: string }[];
        model: string;
        cwdExists: boolean;
        modelHere: boolean;
        error?: string;
    }>(
        `/preview?${new URLSearchParams({ path: file(name).path, runner: runnerId })}`,
        undefined,
        signal,
    );
const list = (q = "") =>
    request<{ sessions: (PiSessionSummary & { id: string })[] }>(
        `?${new URLSearchParams({ runner: runnerId, q })}`,
    );

before(async () => {
    mkdirSync(project);
    mkdirSync(otherProject);

    for (const name of [
        "Checkout total",
        "Deny preview",
        "Code preview",
        "Withdraw preview",
        "Continue history",
        "Expiry history",
    ]) {
        files.set(name, save(name));
    }

    app = await openApp(scriptedModel());
    app.config.lastModel = { provider: "faux", modelId: "faux-1", thinkingLevel: "off" };
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
    const { code } = app.runners.makeCode("Test laptop", owner(app).id);
    const linked = app.runners.redeem(code);

    runnerId = linked.id;
    runner = new Runner({
        link: { server: address, ...linked },
        version: "test",
        cwd: project,
        piSessionDir: sessions,
        settings: () => settings,
        saveSettings: (change) => {
            Object.assign(settings, change);
        },
        log: (line) => logs.push(line),
        retryMs: [50, 100],
        ask: async (question) => {
            asked.push(question);

            if (answer !== undefined) {
                return { allow: answer };
            }

            return new Promise((resolve) =>
                question.signal.addEventListener("abort", () => resolve({ allow: false }), {
                    once: true,
                }),
            );
        },
    });
    runner.start();
    await until(() => app.runners.link(runnerId).state !== undefined, "runner state");
});

after(async () => {
    await runner?.stop();
    await app?.close();
    server?.closeAllConnections();
    await new Promise((resolve) => server?.close(resolve));
    cleanUp();
});

test("the list sends only metadata, newest first; search does not read message bodies", async () => {
    const result = await list();

    assert.equal(result.status, 200);
    assert.equal(result.body.sessions.length, files.size);
    assert.equal(asked.length, 0);
    const item = result.body.sessions.find((each) => each.path === file("Checkout total").path)!;

    assert.deepEqual(Object.keys(item).sort(), [
        "cwd",
        "id",
        "messages",
        "modified",
        "path",
        "title",
    ]);
    assert.equal(item.id, file("Checkout total").id);
    assert.equal(item.title, "Checkout total");
    assert.equal(item.cwd, project);
    assert.equal(item.messages, 2);
    assert.equal(typeof item.modified, "number");
    assert.ok(
        result.body.sessions.every(
            (each, index, all) => index === 0 || all[index - 1]!.modified >= each.modified,
        ),
    );
    assert.doesNotMatch(JSON.stringify(result.body), /private-body-needle|private-reply-needle/);
    assert.equal((await list("private-body-needle")).body.sessions.length, 0);
    assert.equal((await list("Checkout total")).body.sessions.length, 1);
    assert.equal((await list("checkout-project")).body.sessions.length, files.size);
});

test("a denied preview asks a preview-only question, returns its reason, and grants no permission", async () => {
    answer = false;
    const result = await preview("Deny preview");

    assert.equal(result.status, 403);
    assert.match(result.body.error!, /did not allow/);
    const question = asked.at(-1)!;

    assert.equal(question.kind, "pi-preview");
    assert.equal(question.title, "Deny preview");
    assert.equal(question.folder, project);
    assert.equal(question.permission, "session");
    assert.equal(question.broad, false);
    assert.match(question.session, /^pi-preview:/);
    assert.equal(settings.folders, undefined);
    assert.equal(settings.sessions?.length ?? 0, 0);
    assert.ok(
        logs.some((line) => line.includes('Denied Owner to see the Pi session "Deny preview".')),
    );
});

test("Allow returns only the preview; the exact path's 10-minute grant skips a second question", async () => {
    answer = true;
    const before = asked.length;
    const result = await preview("Checkout total");

    assert.equal(result.status, 200);
    assert.equal(result.body.last.length, 2);
    assert.match(result.body.last[1]!.text, /private-reply-needle/);
    assert.equal(result.body.model, "faux/faux-1");
    assert.equal(result.body.modelHere, true);
    assert.equal(result.body.cwdExists, true);
    assert.equal((await preview("Checkout total")).status, 200);
    assert.equal(asked.length, before + 1);
    assert.equal(settings.folders, undefined);
    assert.equal(settings.sessions?.length ?? 0, 0);
});

test("a preview grant expires after 10 minutes and does not apply to another path", async () => {
    const now = Date.now;
    const before = asked.length;

    answer = false;

    try {
        Date.now = () => now() + 10 * 60_000 + 1;
        assert.equal((await preview("Checkout total")).status, 403);
        assert.equal(asked.length, before + 1);
        assert.equal((await preview("Deny preview")).status, 403);
        assert.equal(asked.length, before + 2);
    } finally {
        Date.now = now;
        answer = true;
    }
});

test("an authenticator code approves a preview without saving a folder or session permission", async () => {
    answer = undefined;
    settings.totp = { secret: base32(Buffer.from("12345678901234567890")) };
    const pending = preview("Code preview");
    const link = app.runners.link(runnerId);

    await until(
        () => [...link.questions.values()].some((each) => each.title === "Code preview"),
        "preview notice",
    );
    const question = [...link.questions.values()].find((each) => each.title === "Code preview")!;

    assert.equal(question.kind, "pi-preview");
    assert.equal(question.totp, true);
    await link.approveCode(
        question.id,
        totp(settings.totp.secret, Math.floor(Date.now() / STEP_MS)),
    );
    assert.equal((await pending).status, 200);
    assert.equal(settings.folders, undefined);
    assert.equal(settings.sessions?.length ?? 0, 0);
    assert.equal(link.questions.size, 0);
    delete settings.totp;
});

test("closing the HTTP request withdraws the computer's preview question", async () => {
    answer = undefined;
    const controller = new AbortController();
    const pending = preview("Withdraw preview", controller.signal);
    const caught = assert.rejects(pending, { name: "AbortError" });
    const link = app.runners.link(runnerId);

    await until(
        () => [...link.questions.values()].some((each) => each.title === "Withdraw preview"),
        "withdraw notice",
    );
    const question = asked.at(-1)!;

    controller.abort();
    await caught;
    await until(() => link.questions.size === 0 && question.signal.aborted, "withdrawn preview");
    assert.equal(settings.sessions?.length ?? 0, 0);
    answer = true;
});

test("preview and open refuse a file Pi does not list, even with a valid session permission", async () => {
    const link = app.runners.link(runnerId);
    const path = join(root, "unlisted.jsonl");

    writeFileSync(path, readFileSync(file("Checkout total").path));
    const session = randomUUID();

    await link.confirm({ kind: "new", session, folder: project, person: "Owner" });
    const before = asked.length;

    for (const request of [
        { op: "preview" as const, path, person: "Owner" },
        { op: "open" as const, path, session, person: "Owner" },
        { op: "preview" as const, path: "/etc/passwd", person: "Owner" },
    ]) {
        await assert.rejects(link.piSessions(request), /Pi has no such session on Test laptop/);
    }

    assert.equal(asked.length, before);
});

test("continue asks the new-session question, imports history on the runner, and scopes the one readable file", async () => {
    const source = file("Continue history");
    const whole = readFileSync(source.path, "utf8");
    const local = join(process.env.PI_CODING_AGENT_DIR!, "sessions", "--project--");

    mkdirSync(local, { recursive: true });
    writeFileSync(join(local, "same-id.jsonl"), whole);
    await app.commands.continuePiSession(owner(app), join(local, "same-id.jsonl"));
    assert.equal(
        (await list()).body.sessions.find((each) => each.path === source.path)!.pocket,
        undefined,
        "a local continuation does not mark a session on this computer as continued",
    );
    const before = asked.length;
    const result = await request<{ id: ConversationId }>("/continue", {
        path: source.path,
        runner: runnerId,
    });

    assert.equal(result.status, 200, JSON.stringify(result.body));
    assert.equal(asked.length, before + 1);
    assert.equal(asked.at(-1)!.kind, "new");
    const id = result.body.id;
    const meta = app.sessionMeta(id)!;

    assert.equal(meta.runner, runnerId);
    assert.deepEqual(meta.fromPi, { session: source.id, count: 2 });
    assert.ok(meta.runnerPermission);
    const conversation = (await app.harness.conversation(id, context))!;
    const entries = await conversation.entries({}, 500, undefined, context);

    assert.equal(
        entries.items.filter((entry) => ["pi.user", "pi.assistant"].includes(entry.kind)).length,
        readPiSession(whole).entries.length,
    );
    assert.match(JSON.stringify(entries.items), /private-reply-needle/);
    assert.equal((await conversation.agent(context)).cwd, project);
    assert.equal(readFileSync(source.path, "utf8"), whole);
    assert.deepEqual(
        (await list()).body.sessions.find((each) => each.path === source.path)!.pocket,
        { id, behind: false },
    );
    const scope = { id: meta.runnerPermission!, folder: project, person: "Owner" };
    const env = app.runners.env(runnerId, project, scope);

    assert.equal((await env.readTextFile(source.path, context)).ok, true);
    assert.equal((await env.readTextFile(file("Checkout total").path, context)).ok, false);
    assert.equal((await env.writeFile(source.path, "changed", context)).ok, false);
    const stranger = randomUUID();

    await app.runners
        .link(runnerId)
        .confirm({ kind: "new", session: stranger, folder: project, person: "Owner" });
    const other = app.runners.env(runnerId, project, { ...scope, id: stranger });

    assert.equal((await other.readTextFile(source.path, context)).ok, false);
    await app.runners.link(runnerId).action({ action: "revoke", session: scope.id });
    answer = false;
    assert.equal((await env.readTextFile(source.path, context)).ok, false);
    answer = true;
    await app.runners
        .link(runnerId)
        .confirm({ kind: "new", session: scope.id, folder: project, person: "Owner" });
    assert.equal(
        (await env.readTextFile(source.path, context)).ok,
        false,
        "a replacement permission does not inherit the extra file",
    );
    assert.equal(readFileSync(source.path, "utf8"), whole);
});

test("open refuses an unapproved session and a session whose real folder does not contain the Pi cwd", async () => {
    const link = app.runners.link(runnerId);
    const path = file("Checkout total").path;

    await assert.rejects(
        link.piSessions({ op: "open", path, session: "not-approved", person: "Owner" }),
        /no valid permission/,
    );
    const session = randomUUID();

    await link.confirm({ kind: "new", session, folder: otherProject, person: "Owner" });
    await assert.rejects(
        link.piSessions({ op: "open", path, session, person: "Owner" }),
        /outside.*approved folder/,
    );
});

test("open also allows the companion files Pocket names beside the Pi file, and no other", async () => {
    const link = app.runners.link(runnerId);
    const session = randomUUID();
    const { path } = save("Companion history");
    const beside = `${path}.acp.json`;
    const other = `${path}.unregistered.json`;

    writeFileSync(beside, '{"blocks":[]}');
    writeFileSync(other, "not asked for");

    await link.confirm({ kind: "new", session, folder: project, person: "Owner" });
    const result = await link.piSessions({
        op: "open",
        path,
        session,
        person: "Owner",
        companions: [".acp.json", ".missing.json"],
    });
    const env = app.runners.env(runnerId, project, {
        id: session,
        folder: project,
        person: "Owner",
    });

    assert.deepEqual(result.companions, [`${result.path}.acp.json`], "only the one that exists");
    assert.equal((await env.readTextFile(`${result.path}.acp.json`, context)).ok, true);
    assert.equal(
        (await env.readTextFile(other, context)).ok,
        false,
        "one nobody named stays closed",
    );
    assert.equal(
        parseControl(
            JSON.stringify({
                type: "pi-sessions",
                id: "x",
                op: "open",
                path,
                session,
                person: "Owner",
                companions: ["/../../etc/passwd"],
            }),
        ),
        undefined,
        "a suffix that is a path is refused",
    );
});

test("the extra readable file expires after 5 minutes while the session permission remains valid", async () => {
    const link = app.runners.link(runnerId);
    const session = randomUUID();

    await link.confirm({ kind: "new", session, folder: project, person: "Owner" });
    const result = await link.piSessions({
        op: "open",
        path: file("Expiry history").path,
        session,
        person: "Owner",
    });
    const env = app.runners.env(runnerId, project, {
        id: session,
        folder: project,
        person: "Owner",
    });

    assert.equal((await env.readTextFile(result.path!, context)).ok, true);
    const now = Date.now;
    const before = asked.length;

    try {
        Date.now = () => now() + 5 * 60_000 + 1;
        assert.equal((await env.readTextFile(result.path!, context)).ok, false);
        assert.equal(asked.length, before, "the session permission did not expire");
    } finally {
        Date.now = now;
    }
});

test("only a person who may use the computer can list, preview, or continue its Pi sessions", async () => {
    const { user, token } = app.config.addUser("Invited", "guest");
    const other: User = app.config.addUser("Other owner", "owner").user;

    for (const route of ["", `/preview?path=${encodeURIComponent(file("Checkout total").path)}`]) {
        assert.equal(
            (
                await request(
                    `${route}${route.includes("?") ? "&" : "?"}runner=${runnerId}`,
                    undefined,
                    undefined,
                    token,
                )
            ).status,
            403,
        );
    }

    assert.equal(
        (
            await request(
                "/continue",
                { path: file("Checkout total").path, runner: runnerId },
                undefined,
                token,
            )
        ).status,
        403,
    );
    assert.equal(app.runners.mayUse(runnerId, other), false);
    app.config.setRunnerUsers(runnerId, [user.id]);
    assert.equal((await request(`?runner=${runnerId}`, undefined, undefined, token)).status, 200);
    assert.equal(
        (
            await request(
                `/preview?${new URLSearchParams({ runner: runnerId, path: file("Checkout total").path })}`,
                undefined,
                undefined,
                token,
            )
        ).status,
        200,
    );
});

test("Pi session control messages reject oversized lists, invalid operations, and non-finite metadata", () => {
    const session: RunnerPiSession = {
        path: "/pi/a.jsonl",
        id: "id",
        title: "Title",
        cwd: "/work",
        modified: 1,
        messages: 2,
    };
    const message = { type: "pi-sessions-result", id: "a", ok: true, sessions: [session] };

    assert.ok(parseControl(JSON.stringify(message)));
    assert.equal(
        parseControl(JSON.stringify({ ...message, sessions: Array(301).fill(session) })),
        undefined,
    );
    assert.equal(
        parseControl(JSON.stringify({ ...message, sessions: [{ ...session, messages: -1 }] })),
        undefined,
    );
    assert.equal(
        parseControl(
            JSON.stringify({ ...message, sessions: [{ ...session, title: "x".repeat(81) }] }),
        ),
        undefined,
    );
    assert.equal(
        parseControl(
            JSON.stringify({
                type: "pi-sessions",
                id: "a",
                person: "Owner",
                op: "delete",
                path: session.path,
            }),
        ),
        undefined,
    );
    assert.equal(
        parseControl(
            JSON.stringify({
                ...message,
                preview: { model: null, last: [{ role: "toolResult", text: "x" }] },
            }),
        ),
        undefined,
    );
});

test("a Pi session request fails immediately when the computer is offline", async () => {
    await runner.stop();
    await until(() => !app.runners.link(runnerId).online, "server to see the offline computer");
    const started = Date.now();
    const result = await list();

    assert.equal(result.status, 409);
    assert.ok(Date.now() - started < 2000);
});
