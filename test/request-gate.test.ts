// Runner-side request authorization (`src/runner/request-gate.ts`), using real frames and folders.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it, type TestContext } from "node:test";
import { Approvals, type SessionScope } from "../src/runner/approvals.ts";
import { FRAME, frame, readFrame, SESSION_FIELD } from "../src/runner/protocol.ts";
import { RequestGate } from "../src/runner/request-gate.ts";
import type { RunnerSettings } from "../src/runner/runner.ts";

const root = mkdtempSync(join(tmpdir(), "pi-pocket-request-gate-"));

after(() => rmSync(root, { recursive: true, force: true }));

type Outcome = ReturnType<typeof readFrame> & { route: "send" | "reply" };

async function fixture(t: TestContext, options: { approved?: boolean; answer?: boolean } = {}) {
    const dir = realpathSync(mkdtempSync(join(root, "gate-")));
    const folder = join(dir, "project");
    const outside = join(dir, "outside");
    const shared = join(dir, "shared");
    const temporary = join(dir, "tmp");

    for (const path of [folder, outside, shared, temporary]) {
        mkdirSync(path);
    }

    writeFileSync(join(folder, "file.txt"), "inside");
    writeFileSync(join(outside, "file.txt"), "outside");
    let settings: RunnerSettings = {};
    const approvals = new Approvals(
        () => settings,
        (change) => {
            settings = { ...settings, ...change };
        },
    );
    const a: SessionScope = { id: "session-a", folder, person: "Alice" };
    const b: SessionScope = { id: "session-b", folder, person: "Bob" };

    if (options.approved !== false) {
        await approvals.approve(a, "computer");
        await approvals.approve(b, "computer");
    }

    const sent: Buffer[] = [];
    const replies: Buffer[] = [];
    const asked: { scope: SessionScope; signal: AbortSignal }[] = [];
    const pending = new Map<number, (outcome: Outcome) => void>();

    const collect = (route: Outcome["route"], frames: Buffer[]) => (whole: Buffer) => {
        frames.push(whole);
        const parsed = readFrame(whole);
        const resolve = pending.get(parsed.id);

        pending.delete(parsed.id);
        resolve?.({ ...parsed, route });
    };

    const gate = new RequestGate({
        approvals,
        async ask(scope, signal) {
            asked.push({ scope, signal });

            if (options.answer === true) {
                await approvals.approve(scope, "computer");
            }

            return options.answer === true;
        },
        send: collect("send", sent),
        reply: collect("reply", replies),
        shared: async () => [shared],
        tmpdir: async () => temporary,
        name: () => "Test computer",
    });
    let nextId = 1;

    t.after(() => gate.stop());

    function request(
        json: Record<string, unknown>,
        scope: SessionScope | null = a,
        payload?: Uint8Array,
    ): Promise<Outcome> {
        const id = nextId++;
        const outcome = Promise.withResolvers<Outcome>();

        pending.set(id, outcome.resolve);
        gate.input(
            frame(
                FRAME.request,
                id,
                { ...json, ...(scope === null ? {} : { [SESSION_FIELD]: scope }) },
                payload,
            ),
        );

        return outcome.promise;
    }

    return { gate, approvals, request, a, b, folder, outside, shared, sent, replies, asked };
}

function refused(outcome: Outcome, message: RegExp): void {
    assert.equal(outcome.route, "reply");
    assert.equal(outcome.type, FRAME.error);
    assert.equal(outcome.json.code, "EACCES");
    assert.match(String(outcome.json.message), message);
}

describe("runner RequestGate", () => {
    it("refuses a request without its session field", async (t) => {
        const { request, folder, sent, asked } = await fixture(t);
        const outcome = await request({ op: "open", path: join(folder, "file.txt") }, null);

        refused(outcome, /A session permission on Test computer is required/);
        assert.deepEqual(sent, []);
        assert.deepEqual(asked, []);
    });

    for (const op of ["hello", "lstat", "realpath", "opendir"]) {
        it(`allows the listing operation ${op} without a session or approval`, async (t) => {
            const { request, outside, replies, asked } = await fixture(t, { approved: false });
            const json = op === "hello" ? { op } : { op, path: outside };
            const outcome = await request(json, null);

            assert.equal(outcome.route, "send");
            assert.equal(outcome.type, FRAME.request);
            assert.deepEqual(outcome.json, json);
            assert.deepEqual(replies, []);
            assert.deepEqual(asked, []);
        });
    }

    it("lets an unscoped folder listing use and close its directory handle", async (t) => {
        const { gate, request, outside, asked } = await fixture(t, { approved: false });
        const opened = await request({ op: "opendir", path: outside }, null);

        gate.output(frame(FRAME.result, opened.id, { handle: 41 }));
        assert.equal((await request({ op: "readdir", handle: 41 }, null)).route, "send");
        assert.equal((await request({ op: "close", handle: 41 }, null)).route, "send");
        assert.deepEqual(asked, []);
    });

    it("forwards an approved request and payload after removing only the session field", async (t) => {
        const { request, folder, replies, asked } = await fixture(t);
        const json = { op: "open", path: join(folder, "file.txt"), flags: "r" };
        const payload = Uint8Array.of(0, 255, 1);
        const outcome = await request(json, undefined, payload);

        assert.equal(outcome.route, "send");
        assert.equal(outcome.type, FRAME.request);
        assert.deepEqual(outcome.json, json);
        assert.equal(Object.hasOwn(outcome.json, SESSION_FIELD), false);
        assert.deepEqual(outcome.payload, payload);
        assert.deepEqual(replies, []);
        assert.deepEqual(asked, []);
    });

    it("refuses a path outside the approved folder", async (t) => {
        const { request, outside, sent } = await fixture(t);
        const outcome = await request({ op: "open", path: join(outside, "file.txt") });

        refused(outcome, /outside the session's approved folder/);
        assert.deepEqual(sent, []);
    });

    it("does not confuse a sibling with the same path prefix for an approved child", async (t) => {
        const { request, folder, sent } = await fixture(t);
        const sibling = `${folder}-other`;

        mkdirSync(sibling);
        refused(await request({ op: "open", path: join(sibling, "new.txt") }), /outside/);
        assert.deepEqual(sent, []);
    });

    it("refuses a rename destination outside the approved folder", async (t) => {
        const { request, folder, outside, sent } = await fixture(t);
        const outcome = await request({
            op: "rename",
            path: join(folder, "file.txt"),
            to: join(outside, "renamed.txt"),
        });

        refused(outcome, /outside the session's approved folder/);
        assert.deepEqual(sent, []);
    });

    it("checks every target instead of only the request's main path", async (t) => {
        const { request, folder, outside, sent } = await fixture(t);
        const outcome = await request({
            op: "watch",
            path: folder,
            targets: [{ path: join(folder, "file.txt") }, { path: join(outside, "file.txt") }],
        });

        refused(outcome, /outside the session's approved folder/);
        assert.deepEqual(sent, []);
    });

    it("allows a missing child when its existing ancestors are inside the folder", async (t) => {
        const { request, folder } = await fixture(t);
        const outcome = await request({ op: "mkdir", path: join(folder, "new", "child") });

        assert.equal(outcome.route, "send");
    });

    it("refuses an existing symlink in the folder that resolves outside it", async (t) => {
        const { request, folder, outside, sent } = await fixture(t);
        const link = join(folder, "escape");

        symlinkSync(outside, link, "dir");
        refused(await request({ op: "open", path: join(link, "file.txt") }), /outside/);
        assert.deepEqual(sent, []);
    });

    it("refuses a missing child below a symlink to an outside folder", async (t) => {
        const { request, folder, outside, sent } = await fixture(t);
        const link = join(folder, "escape");

        symlinkSync(outside, link, "dir");
        refused(await request({ op: "mkdir", path: join(link, "missing", "child") }), /outside/);
        assert.deepEqual(sent, []);
    });

    it("refuses a file handle opened by another session even in the same folder", async (t) => {
        const { gate, request, folder, b, sent } = await fixture(t);
        const opened = await request({ op: "open", path: join(folder, "file.txt") });

        gate.output(frame(FRAME.result, opened.id, { handle: 41 }));
        const outcome = await request({ op: "pread", handle: 41, length: 10 }, b);

        refused(outcome, /The handle belongs to another session/);
        assert.equal(sent.length, 1);
    });

    it("allows an opened file handle to be used by its own session", async (t) => {
        const { gate, request, folder } = await fixture(t);
        const opened = await request({ op: "open", path: join(folder, "file.txt") });

        gate.output(frame(FRAME.result, opened.id, { handle: 41 }));
        const outcome = await request({ op: "pread", handle: 41, length: 10 });

        assert.equal(outcome.route, "send");
        assert.deepEqual(outcome.json, { op: "pread", handle: 41, length: 10 });
    });

    it("refuses a target request owned by another session", async (t) => {
        const { request, b, sent } = await fixture(t);
        const running = await request({ op: "exec", command: "printf ok" });
        const outcome = await request({ op: "kill", target: running.id }, b);

        refused(outcome, /The request belongs to another session/);
        assert.equal(sent.length, 1);
    });

    it("allows a target request owned by the same session", async (t) => {
        const { request } = await fixture(t);
        const running = await request({ op: "exec", command: "printf ok" });
        const outcome = await request({ op: "kill", target: running.id });

        assert.equal(outcome.route, "send");
        assert.equal(outcome.json.target, running.id);
    });

    it("lets only the request's own session cancel it", async (t) => {
        const { gate, request, a, b, sent } = await fixture(t);
        const running = await request({ op: "exec", command: "printf ok" });
        const before = sent.length;

        gate.input(frame(FRAME.cancel, running.id, { [SESSION_FIELD]: b }));
        assert.equal(sent.length, before, "another session's cancel does not reach the daemon");

        gate.input(frame(FRAME.cancel, running.id, {}));
        assert.equal(sent.length, before, "a cancel with no session neither");

        gate.input(frame(FRAME.cancel, running.id, { [SESSION_FIELD]: a }));
        assert.equal(sent.length, before + 1, "its own session's cancel does");
        assert.equal(readFrame(sent.at(-1)!).type, FRAME.cancel);
        assert.equal(readFrame(sent.at(-1)!).json[SESSION_FIELD], undefined, "without the field");
    });

    it("fills a command's missing cwd with the session's approved folder", async (t) => {
        const { request, folder } = await fixture(t);
        const outcome = await request({ op: "exec", command: "printf ok" });

        assert.equal(outcome.route, "send");
        assert.deepEqual(outcome.json, { op: "exec", command: "printf ok", cwd: folder });
    });

    it("refuses an explicit command cwd outside the approved folder", async (t) => {
        const { request, outside, sent } = await fixture(t);

        refused(await request({ op: "exec", command: "printf ok", cwd: outside }), /outside/);
        assert.deepEqual(sent, []);
    });

    it("asks again without a valid permission and refuses a negative answer", async (t) => {
        const { request, folder, a, asked, sent } = await fixture(t, { approved: false });
        const outcome = await request({ op: "open", path: join(folder, "file.txt") });

        refused(outcome, /Session not approved on Test computer/);
        assert.equal(asked.length, 1);
        assert.deepEqual(asked[0]!.scope, a);
        assert.equal(asked[0]!.signal.aborted, false);
        assert.deepEqual(sent, []);
    });

    it("rechecks the permission after a positive approval answer", async (t) => {
        const { request, folder, asked, replies } = await fixture(t, {
            approved: false,
            answer: true,
        });
        const outcome = await request({ op: "open", path: join(folder, "file.txt") });

        assert.equal(outcome.route, "send");
        assert.equal(asked.length, 1);
        assert.deepEqual(replies, []);
    });

    it("allows the runner's shared folder without granting other outside paths", async (t) => {
        const { request, shared, outside } = await fixture(t);

        assert.equal(
            (await request({ op: "open", path: join(shared, "attachment") })).route,
            "send",
        );
        refused(await request({ op: "open", path: join(outside, "file.txt") }), /outside/);
    });
});
