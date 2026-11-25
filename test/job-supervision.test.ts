import {
    type App,
    cleanUp,
    context,
    newSession,
    openApp,
    owner,
    say,
    scriptedModel,
} from "./helpers.ts";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { after, before, test } from "node:test";
import type { ConversationId } from "@earendil-works/pi-durable";
import { BackgroundDoc, LinkedSessionPeersDoc, SessionsDoc } from "../src/server/docs.ts";
import { createHandler } from "../src/server/http.ts";
import { type JobSupervision, readJobSupervision } from "../src/server/job-supervision.ts";

const model = scriptedModel();
const secret = "never-share-this-command-or-directory";
let app: App;
let server: Server;
let base: string;

before(async () => {
    app = await openApp(model);
    await app.setExtensionEnabled(owner(app), "agent-teams.ts", false);
    server = createServer(
        createHandler({ app, listen: { host: "127.0.0.1", port: 0 }, restart: () => {} }),
    );
    await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}/api/c`;
});

after(async () => {
    if (server !== undefined) {
        server.closeAllConnections();
        await new Promise<void>((done) => server.close(() => done()));
    }

    await app?.close();
    cleanUp();
});

function page(id: ConversationId, token: string, after?: string) {
    return fetch(`${base}/${id}/background/jobs${after === undefined ? "" : `?after=${after}`}`, {
        headers: { authorization: `Bearer ${token}`, "x-pocket": "1" },
    });
}

async function seed(id: ConversationId): Promise<void> {
    await app.harness.commit(async (tx) => {
        const doc = await tx.doc(BackgroundDoc, id);

        doc.items.bbbbbb = {
            id: "bbbbbb",
            jobId: "aaaaaa",
            attempt: 2,
            resumedFrom: "aaaaaa",
            cwd: secret,
            command: secret,
            pid: 123456,
            status: "exited",
            code: 0,
            startedAt: 4,
            endedAt: 5,
            notify: false,
            read: 0,
            taskId: 1 as never,
        };
        doc.adverse = [
            {
                jobId: "aaaaaa",
                attemptId: "aaaaaa",
                attempt: 1,
                startedAt: 1,
                endedAt: 2,
                outcome: "timeout",
                status: "stopped",
            },
        ];
    }, context);
}

async function worker(lead: ConversationId) {
    const id = await newSession(app);
    const address = `session-${crypto.randomUUID()}`;

    await app.harness.commit(async (tx) => {
        (await tx.doc(SessionsDoc)).items[String(id)]!.linkedFrom = { id: Number(lead) };
        (await tx.doc(LinkedSessionPeersDoc, lead)).peers[address] = Number(id);
    }, context);
    await seed(id);

    return { id, address };
}

test("an explicit read sees archived workers with reports and notify off; a peer address alone grants nothing", async () => {
    const lead = await newSession(app);
    const child = await worker(lead);
    const grandchild = await worker(child.id);
    const unrelated = await newSession(app);

    await say(app, lead, "hello");
    await seed(lead);
    await seed(unrelated);
    await app.harness.commit(async (tx) => {
        const sessions = await tx.doc(SessionsDoc);
        const peers = await tx.doc(LinkedSessionPeersDoc, lead);

        sessions.items[String(lead)]!.linkedReports = false;
        sessions.items[String(child.id)]!.archived = true;
        peers.peers[`session-${crypto.randomUUID()}`] = Number(grandchild.id);
        peers.peers[`session-${crypto.randomUUID()}`] = Number(unrelated);
    }, context);
    const calls = model.state.callCount;
    const data = await readJobSupervision(app, lead);

    assert.deepEqual(data.current.map((r) => r.worker).sort(), ["self", child.address].sort());
    assert.deepEqual(data.failures.map((r) => r.worker).sort(), ["self", child.address].sort());
    assert.ok(
        data.current.every(
            (r) => r.attempt === 2 && r.resumedFrom === "aaaaaa" && r.outcome === "exited",
        ),
    );
    assert.ok(data.failures.every((r) => r.attempt === 1 && r.outcome === "timeout"));
    assert.doesNotMatch(JSON.stringify(data), /never-share|taskId|conversationId|command|123456/);
    assert.equal(data.truncated, false);
    assert.equal(model.state.callCount, calls);
});

test("human reads follow the signed-in viewer; tool results require a live requester and the entire lead audience", async () => {
    const lead = await newSession(app);
    const child = await worker(lead);
    const viewer = app.config.addUser("lead only", "viewer", [String(lead)]);

    try {
        await assert.rejects(readJobSupervision(app, lead), { status: 403 });
        await say(app, lead, "hello");
        assert.deepEqual((await readJobSupervision(app, lead)).current, []);
        const hidden = await page(lead, viewer.token);

        assert.equal(hidden.status, 200);
        assert.doesNotMatch(await hidden.text(), new RegExp(child.address));
        const authorized = await page(lead, app.config.ownerToken);

        assert.equal(authorized.status, 200);
        assert.equal(
            ((await authorized.json()) as JobSupervision).current[0]?.worker,
            child.address,
        );
        app.config.updateUser(viewer.user.id, { sessions: [String(lead), String(child.id)] });
        assert.equal((await readJobSupervision(app, lead)).current[0]?.worker, child.address);
        app.config.updateUser(viewer.user.id, { sessions: [String(child.id)] });
        assert.equal((await page(lead, viewer.token)).status, 404);
        app.config.removeUser(viewer.user.id);
        await assert.rejects(readJobSupervision(app, lead, viewer.user), { status: 404 });
    } finally {
        app.config.removeUser(viewer.user.id);
    }
});

test("running status does not confirm a live process without fresh evidence", async (t) => {
    const lead = await newSession(app);
    const at = app.now();
    const base = {
        status: "running",
        startedAt: 0,
        attempt: 1,
        jobId: "aaaaaa",
        attemptId: "aaaaaa",
    } as const;

    t.mock.method(app.background, "jobs", async () => ({
        jobs: [
            { ...base, processAlive: true },
            { ...base, processAlive: true, processObservedAt: at - 60_000 },
            { ...base, processAlive: true, processObservedAt: at },
            { ...base, processAlive: false, processObservedAt: at },
            { ...base, processAlive: true, processObservedAt: at + 60_000 },
        ],
        recentAdverse: [],
        truncated: true,
    }));
    const { current, truncated, next } = await readJobSupervision(app, lead, owner(app));

    assert.equal(truncated, true, "a truncated session is still marked on the last worker page");
    assert.equal(next, undefined);

    assert.deepEqual(
        current.map((r) => [r.processFreshness, r.processAlive]),
        [
            ["unknown", undefined],
            ["stale", true],
            ["fresh", true],
            ["fresh", false],
            ["unknown", undefined],
        ],
    );
});

test("a stale requester cannot finish a read after losing steering rights", async (t) => {
    const lead = await newSession(app);
    const guest = app.config.addUser("requester", "guest", [String(lead)]).user;

    try {
        const { submissionId } = await app.commands.submit(lead, guest, {
            text: "hello",
            requestId: crypto.randomUUID(),
        });

        await (await app.harness.submission(submissionId, context))!.wait(context);
        const jobs = app.background.jobs.bind(app.background);

        t.mock.method(app.background, "jobs", async (id: ConversationId) => {
            const data = await jobs(id);

            app.config.updateUser(guest.id, { role: "viewer" });

            return data;
        });
        await assert.rejects(readJobSupervision(app, lead), { status: 403 });
    } finally {
        app.config.removeUser(guest.id);
    }
});

test("discard worker results when the audience changes during a read", async (t) => {
    const lead = await newSession(app);
    const child = await worker(lead);
    const viewer = app.config.addUser("limited", "viewer", [String(lead), String(child.id)]).user;

    try {
        await say(app, lead, "hello");
        const jobs = app.background.jobs.bind(app.background);

        t.mock.method(app.background, "jobs", async (id: ConversationId) => {
            const result = await jobs(id);

            if (id === child.id) {
                app.config.updateUser(viewer.id, { sessions: [String(lead)] });
            }

            return result;
        });
        const data = await readJobSupervision(app, lead);

        assert.deepEqual(data.current, []);
        assert.deepEqual(data.failures, []);
        assert.equal(data.truncated, false);
    } finally {
        app.config.removeUser(viewer.id);
    }
});

test("page every authorized direct worker, including its retained failures, without scanning worker documents beyond the page", async (t) => {
    const lead = await newSession(app);
    const addresses: string[] = [];

    await seed(lead);

    for (let i = 0; i < 10; i++) {
        addresses.push((await worker(lead)).address);
    }

    const reads = t.mock.method(app.background, "jobs");
    const seen: string[] = [];
    const failed: string[] = [];
    let cursor: string | undefined;

    do {
        const first = cursor === undefined;
        const before = reads.mock.callCount();
        const response = await page(lead, app.config.ownerToken, cursor);

        assert.equal(response.status, 200);
        const data = (await response.json()) as JobSupervision;

        assert.ok(reads.mock.callCount() - before <= (first ? 4 : 3));
        assert.equal(data.truncated, data.next !== undefined);
        assert.equal(
            data.current.some((r) => r.worker === "self"),
            first,
        );
        assert.ok(data.next === undefined || addresses.includes(data.next));
        seen.push(...data.current.map((r) => r.worker));
        failed.push(...data.failures.map((r) => r.worker));
        assert.ok(seen.length <= addresses.length + 1, "the cursor must advance");
        cursor = data.next;
    } while (cursor !== undefined);

    assert.deepEqual(seen.sort(), ["self", ...addresses].sort());
    assert.deepEqual(failed.sort(), seen);
    assert.equal((await page(lead, app.config.ownerToken, "123")).status, 400);
});
