// Session permission, its expiry, and authenticator codes (`src/runner/approvals.ts`, `request-gate.ts`, `totp.ts`):
// the server's `Runners`, a real WebSocket, the runner, and the real pi-env daemon, all on this machine.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { execFile, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, realpathSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { connect, createServer as createNetServer } from "node:net";
import type { AddressInfo } from "node:net";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline";
import { after, describe, it } from "node:test";
import { BACKGROUND_CONTEXT as context, withAbortSignal } from "@earendil-works/chord/context";
import { realFolder } from "../src/runner/folders.ts";
import { LINK_PROTOCOL } from "../src/runner/protocol.ts";
import {
    Runner,
    type RunnerOptions,
    type RunnerSettings,
    type SessionQuestion,
} from "../src/runner/runner.ts";
import { base32, checkCode, STEP_MS, totp, unbase32, type TotpState } from "../src/runner/totp.ts";
import { ConfigStore } from "../src/server/config.ts";
import { Runners } from "../src/server/runners.ts";

const root = mkdtempSync(join(tmpdir(), "pi-pocket-approvals-test-"));
const launcher = fileURLToPath(new URL("../bin/pi-pocket.js", import.meta.url));

after(() => rmSync(root, { recursive: true, force: true }));

async function until(check: () => boolean, what: string, ms = 10_000): Promise<void> {
    const end = Date.now() + ms;

    while (!check()) {
        if (Date.now() > end) {
            throw new Error(`Timed out waiting for ${what}`);
        }

        await new Promise((resolve) => setTimeout(resolve, 20));
    }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// ─── TOTP ──────────────────────────────────────────────────────────────

describe("authenticator codes", () => {
    // RFC 6238, appendix B: the SHA-1 secret is the ASCII "12345678901234567890". Its 8-digit values, cut to their last
    // 6 digits, are the 6-digit codes.
    const secret = base32(Buffer.from("12345678901234567890"));
    const vectors: [number, string][] = [
        [59, "94287082"],
        [1111111109, "07081804"],
        [1111111111, "14050471"],
        [1234567890, "89005924"],
        [2000000000, "69279037"],
        [20000000000, "65353130"],
    ];

    it("matches the RFC 6238 SHA-1 test vectors", () => {
        for (const [seconds, code] of vectors) {
            assert.equal(totp(secret, Math.floor((seconds * 1000) / STEP_MS)), code.slice(2));
        }
    });

    it("writes and reads Base32, and refuses what is not Base32", () => {
        // RFC 4648's test vectors, without padding.
        for (const [text, encoded] of [
            ["", ""],
            ["f", "MY"],
            ["fo", "MZXQ"],
            ["foo", "MZXW6"],
            ["foob", "MZXW6YQ"],
            ["fooba", "MZXW6YTB"],
            ["foobar", "MZXW6YTBOI"],
        ]) {
            assert.equal(base32(Buffer.from(text!)), encoded);

            if (encoded !== "") {
                assert.equal(unbase32(encoded!).toString(), text);
                assert.equal(
                    unbase32(`${encoded!.toLowerCase()}======`.slice(0, 8)).length > 0,
                    true,
                );
            }
        }

        assert.throws(() => unbase32("MZXW1"), /Invalid Base32/);
        assert.throws(() => unbase32("M"), /Invalid Base32/);
        // Bits left over that are not zero.
        assert.throws(() => unbase32("MZ"), /Invalid Base32 padding/);
    });

    it("takes a code once, one step either side, and locks after 5 wrong codes in 10 minutes", () => {
        const now = 1_700_000_000_000;
        const step = Math.floor(now / STEP_MS);
        const state: TotpState = { secret };

        assert.equal(checkCode(state, totp(secret, step), now), true);
        assert.equal(checkCode(state, totp(secret, step), now), false, "a code works once");
        assert.equal(state.lockedUntil, undefined);
        // An older code inside the window is refused once a newer one was taken.
        assert.equal(checkCode(state, totp(secret, step - 1), now), false);
        // The next step's code: drift of one step.
        assert.equal(checkCode(state, totp(secret, step + 1), now), true);
        // Two steps ahead: refused.
        assert.equal(checkCode(state, totp(secret, step + 3), now + STEP_MS), false);

        const fresh: TotpState = { secret };

        assert.equal(checkCode(fresh, totp(secret, step - 1), now), true, "one step behind");
        assert.equal(checkCode(fresh, totp(secret, step - 2), now), false, "two steps behind");

        const locked: TotpState = { secret };

        for (let wrong = 0; wrong < 5; wrong++) {
            assert.equal(checkCode(locked, "000000", now + wrong), false);
        }

        assert.ok(locked.lockedUntil! > now);
        assert.equal(
            checkCode(locked, totp(secret, step), now + 1000),
            false,
            "a right code is refused while locked",
        );
        assert.equal(checkCode(locked, totp(secret, step + 20), now + 10 * 60_000 + 10), true);
    });
});

// ─── With the server ───────────────────────────────────────────────────

type Setup = { server: Server; address: string; runners: Runners };

async function serve(): Promise<Setup> {
    const config = new ConfigStore(mkdtempSync(join(root, "data-")));
    const runners = new Runners({ config, log: () => {} });
    const server = createServer((_request, response) => response.writeHead(404).end());

    server.on("upgrade", (request, socket, head) => {
        if (!runners.upgrade(request, socket, head)) {
            socket.destroy();
        }
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));

    const { port } = server.address() as AddressInfo;

    return { server, address: `http://127.0.0.1:${port}`, runners };
}

async function close(setup: Setup): Promise<void> {
    setup.runners.close();
    setup.server.closeAllConnections();
    await new Promise((resolve) => setup.server.close(resolve));
}

type Computer = {
    runner: Runner;
    id: string;
    settings: RunnerSettings;
    asked: SessionQuestion[];
    lines: string[];
    /** How the person at the computer answers the next questions; undefined: they do not answer yet. */
    answer: { allow: boolean } | undefined;
    /** Answer the questions that wait, as the person at the computer. */
    release: (allow: boolean) => void;
};

/** Link a computer and start its runner, with settings kept in memory as the link file keeps them. */
async function start(setup: Setup, more: Partial<RunnerOptions> = {}): Promise<Computer> {
    const { code } = setup.runners.makeCode(`Computer ${randomUUID().slice(0, 6)}`, "owner");
    const linked = setup.runners.redeem(code);
    const computer: Computer = {
        id: linked.id,
        settings: {},
        asked: [],
        lines: [],
        answer: { allow: true },
    } as unknown as Computer;
    const waiting: ((answer: { allow: boolean }) => void)[] = [];

    computer.release = (allow) => {
        for (const resolve of waiting.splice(0)) {
            resolve({ allow });
        }
    };

    computer.runner = new Runner({
        link: { server: setup.address, ...linked },
        version: "test",
        cwd: root,
        log: (line) => computer.lines.push(line),
        retryMs: [50, 100, 200],
        settings: () => computer.settings,
        saveSettings: (change) => {
            Object.assign(computer.settings, change);
        },
        ask: async (question) => {
            computer.asked.push(question);

            if (computer.answer === undefined) {
                return new Promise((resolve) => {
                    waiting.push(resolve);
                    question.signal.addEventListener("abort", () => resolve({ allow: false }), {
                        once: true,
                    });
                });
            }

            return computer.answer;
        },
        ...more,
    });
    computer.runner.start();
    await until(() => computer.runner.connected, "the runner to connect");
    // The runner's state reaches the server once it is welcomed.
    await until(() => setup.runners.link(computer.id).state !== undefined, "the runner's state");

    return computer;
}

function folder(name: string): string {
    const made = join(mkdtempSync(join(root, `${name}-`)), "work");

    mkdirSync(made);

    return made;
}

async function exec(
    env: ReturnType<Runners["env"]>,
    command: string,
): Promise<{ ok: boolean; output: string; message: string }> {
    let output = "";
    const result = await env.exec(command, { onOutput: (text) => (output += text) }, context);

    return { ok: result.ok, output, message: result.ok ? "" : result.error.message };
}

/** The authenticator's code now. */
function codeNow(settings: RunnerSettings): string {
    return totp(settings.totp!.secret, Math.floor(Date.now() / STEP_MS));
}

/**
 * As if the next 30-second step came: a code is taken once, and none from its step or before it after that. Tests do
 * not wait 30 seconds for it.
 */
function nextStep(settings: RunnerSettings): void {
    delete settings.totp!.lastStep;
}

describe("the link under load and after a failed save", () => {
    it("keeps a large result whole while a refusal is sent, and goes on after a failed settings save", async () => {
        const setup = await serve();
        let failSaves = false;
        const computer = await start(setup, {
            saveSettings: (change) => {
                if (failSaves) {
                    throw new Error("EPERM: the settings file is in use");
                }

                Object.assign(computer.settings, change);
            },
        });
        const work = folder("load");

        try {
            // About 8 MiB of output: the daemon writes it in many pieces.
            writeFileSync(join(work, "big.txt"), "x".repeat(8 * 1024 * 1024));

            const env = setup.runners.env(computer.id, work, {
                id: "load",
                folder: work,
                person: "Owner",
            });
            const unscoped = setup.runners.env(computer.id, work);

            assert.equal(
                (await env.readTextFile(join(work, "big.txt"), context)).ok,
                true,
                "approved",
            );

            // Refusals from the runner while the big read streams: each lands between whole frames.
            const big = env.readTextFile(join(work, "big.txt"), context);
            const refusals = await Promise.all(
                Array.from({ length: 20 }, () =>
                    unscoped.readTextFile(join(work, "big.txt"), context),
                ),
            );
            const read = await big;

            assert.ok(
                refusals.every((each) => !each.ok),
                "no session: refused",
            );
            assert.equal(read.ok, true);
            assert.equal(read.ok ? read.value.length : 0, 8 * 1024 * 1024);
            assert.equal((await exec(env, "echo still here")).output.trim(), "still here");

            // A save that fails (a request ending updates the permission) must not block later checks.
            failSaves = true;
            assert.equal((await exec(env, "echo during")).ok, true);
            await sleep(50);
            assert.equal((await exec(env, "echo after")).output.trim(), "after");
            failSaves = false;
        } finally {
            await computer.runner.stop();
            await close(setup);
        }
    });

    it("after a drop, sends new output only once welcomed, and the command finishes", async () => {
        const setup = await serve();
        // Between the runner and the server: the server's bytes come 150 ms late, so after a reconnect the
        // command's output always arrives before the welcome does.
        const proxy = createNetServer((client) => {
            const upstream = connect(Number(new URL(setup.address).port), "127.0.0.1");

            client.pipe(upstream);
            upstream.on("data", (bytes: Buffer) => setTimeout(() => client.write(bytes), 150));
            upstream.on("close", () => setTimeout(() => client.destroy(), 200));
            client.on("close", () => upstream.destroy());
            client.on("error", () => upstream.destroy());
            upstream.on("error", () => client.destroy());
        });

        await new Promise<void>((resolve) => proxy.listen(0, "127.0.0.1", resolve));

        const computer = await start({
            ...setup,
            address: `http://127.0.0.1:${(proxy.address() as AddressInfo).port}`,
        });
        const work = folder("drop");

        try {
            const env = setup.runners.env(computer.id, work, {
                id: "drop",
                folder: work,
                person: "Owner",
            });
            let output = "";
            const running = env.exec(
                "for i in $(seq 1 30); do echo line $i; sleep 0.05; done",
                { onOutput: (text) => (output += text) },
                context,
            );

            await until(() => output.includes("line 3"), "output before the drop");
            computer.runner.drop();

            const result = await running;

            assert.equal(result.ok, true, result.ok ? "" : result.error.message);
            assert.equal(output.trim().split("\n").at(-1), "line 30");
            assert.equal(output.match(/line \d+/g)?.length, 30, "every line once, none lost");
            assert.ok(
                !computer.lines.some((line) =>
                    /gap in the stream|could not resume|lost its place/.test(line),
                ),
                computer.lines.join("\n"),
            );
        } finally {
            await computer.runner.stop();
            proxy.close();
            await close(setup);
        }
    });
});

describe("session permission on the runner", () => {
    it("runs a command sent with no folder in the session's approved folder", async () => {
        const setup = await serve();
        const computer = await start(setup);
        const work = folder("nocwd");

        try {
            const scope = { id: "nocwd", folder: work, person: "Owner" };
            const link = setup.runners.link(computer.id);
            let output = "";

            // As a server that leaves the folder out: pi-env's client never does.
            await link.request(
                "exec",
                { argv: ["pwd"], env: {}, inheritEnv: true },
                {
                    onEvent: (json, payload) => {
                        output +=
                            payload !== undefined && payload.length > 0
                                ? Buffer.from(payload).toString("utf8")
                                : typeof json.text === "string"
                                  ? json.text
                                  : "";
                    },
                },
                scope,
            );

            assert.equal(output.trim(), realpathSync(work));
        } finally {
            await computer.runner.stop();
            await close(setup);
        }
    });

    it("refuses a request without session permission before the daemon, but lists folders", async () => {
        const setup = await serve();
        const computer = await start(setup);
        const work = folder("refuse");

        try {
            writeFileSync(join(work, "secret.txt"), "secret");
            mkdirSync(join(work, "inner"));

            // No session named, and one never approved: the folder picker still lists.
            const listed = await setup.runners.folders(computer.id, work, false);

            assert.deepEqual(
                listed.dirs.map((dir) => dir.name),
                ["inner"],
            );

            const unscoped = setup.runners.env(computer.id, work);
            const read = await unscoped.readTextFile(join(work, "secret.txt"), context);

            assert.equal(read.ok, false);
            assert.match(read.ok ? "" : read.error.message, /session permission on .* is required/);

            const ran = await exec(unscoped, `touch ${join(work, "made")}`);

            assert.equal(ran.ok, false);
            assert.throws(() => readFileSync(join(work, "made")), /ENOENT/, "nothing ran");

            // A session the computer never approved: it asks; Deny fails the request.
            computer.answer = { allow: false };
            const stranger = setup.runners.env(computer.id, work, {
                id: "stranger",
                folder: work,
                person: "Owner",
            });
            const refused = await stranger.readTextFile(join(work, "secret.txt"), context);

            assert.equal(refused.ok, false);
            assert.match(refused.ok ? "" : refused.error.message, /not approved on Computer/);
            assert.equal(computer.asked.at(-1)!.expired, true);
        } finally {
            await computer.runner.stop();
            await close(setup);
        }
    });

    it("keeps a session to its folder, and lets it use its own temporary folders", async () => {
        const setup = await serve();
        const computer = await start(setup);
        const work = folder("inside");
        const other = folder("outside");

        try {
            writeFileSync(join(other, "other.txt"), "other");
            await setup.runners
                .link(computer.id)
                .confirm({ kind: "new", person: "Owner", folder: work, session: "one" });

            const env = setup.runners.env(computer.id, work, {
                id: "one",
                folder: work,
                person: "Owner",
            });

            assert.ok((await env.writeFile(join(work, "a.txt"), "a", context)).ok);

            const outside = await env.readTextFile(join(other, "other.txt"), context);

            assert.equal(outside.ok, false);
            assert.match(
                outside.ok ? "" : outside.error.message,
                /outside the session's approved folder/,
            );

            // A command whose folder is elsewhere is refused; its own folder works.
            assert.equal((await exec(env, "pwd")).output.trim(), await realFolder(work));
            const elsewhere = await env.exec("pwd", { cwd: other }, context);

            assert.equal(elsewhere.ok, false);

            // Its own temporary folder, as codemode and long output use.
            const made = await env.createTempFile({ prefix: "out-" }, context);

            assert.ok(made.ok, made.ok ? "" : made.error.message);
            assert.ok((await env.writeFile(made.value, "spill", context)).ok);

            // Another session's temporary folder is not its own.
            await setup.runners
                .link(computer.id)
                .confirm({ kind: "new", person: "Owner", folder: other, session: "two" });

            const second = setup.runners.env(computer.id, other, {
                id: "two",
                folder: other,
                person: "Owner",
            });
            const theirs = await second.readTextFile(made.value, context);

            assert.equal(theirs.ok, false);

            // Pi's context file in a folder above, and a skill in the home folder: read, never written.
            const above = join(work, "..", "AGENTS.md");
            const skill = join(homedir(), ".agents", "skills", "pi-pocket-test-none", "SKILL.md");

            writeFileSync(above, "Context above");
            assert.equal((await env.readTextFile(above, context)).ok, true);
            assert.equal((await env.writeFile(above, "changed", context)).ok, false);
            assert.doesNotMatch(
                ((await env.readTextFile(skill, context)) as { error?: Error }).error?.message ??
                    "",
                /outside the session's approved folder/,
            );
            assert.equal((await env.writeFile(skill, "changed", context)).ok, false);
            assert.equal(readFileSync(above, "utf8"), "Context above");
        } finally {
            await computer.runner.stop();
            await close(setup);
        }
    });

    it("lets a session reach its own downloads and attached files only, never the downloads folder", async () => {
        const setup = await serve();
        const downloads = folder("chosen-downloads");
        const computer = await start(setup);
        const work = folder("own-work");
        const temp = await realFolder(tmpdir());

        computer.settings.downloads = downloads;

        try {
            for (const session of ["mine", "theirs"]) {
                await setup.runners
                    .link(computer.id)
                    .confirm({ kind: "new", person: "Owner", folder: work, session });
            }

            const env = setup.runners.env(computer.id, work, {
                id: "mine",
                folder: work,
                person: "Owner",
            });

            const write = async (path: string) => {
                mkdirSync(dirname(path), { recursive: true });

                return (await env.writeFile(path, "x", context)).ok;
            };

            assert.ok(await write(join(temp, "pi-pocket-downloads", "mine", "a.txt")));
            assert.ok(await write(join(temp, "pi-pocket-uploads", "mine", "a.txt")));
            assert.ok(await write(join(downloads, "mine", "a.txt")));
            assert.equal(await write(join(temp, "pi-pocket-downloads", "theirs", "a.txt")), false);
            assert.equal(await write(join(temp, "pi-pocket-uploads", "theirs", "a.txt")), false);
            assert.equal(await write(join(downloads, "theirs", "a.txt")), false);
            // The chosen folder itself, and what else is in it, belong to no session.
            assert.equal(await write(join(downloads, "a.txt")), false);
        } finally {
            await computer.runner.stop();
            await close(setup);
            rmSync(join(tmpdir(), "pi-pocket-downloads", "mine"), { recursive: true, force: true });
            rmSync(join(tmpdir(), "pi-pocket-uploads", "mine"), { recursive: true, force: true });
        }
    });

    it("limits worktree folders to one permission id and rejects path-like ids", async () => {
        const setup = await serve();
        const computer = await start(setup);
        const work = folder("worktree-permission");
        const id = randomUUID();
        const worktrees = join(await realFolder(homedir()), ".pi-pocket", "worktrees");
        const own = join(worktrees, id);
        const other = join(worktrees, randomUUID());
        const outside = join(worktrees, `${id}.txt`);

        try {
            for (const session of [id, "..", ".", `${id}/nested`, `${id}\\nested`]) {
                await setup.runners
                    .link(computer.id)
                    .confirm({ kind: "new", person: "Owner", folder: work, session });
                const env = setup.runners.env(computer.id, work, {
                    id: session,
                    folder: work,
                    person: "Owner",
                });
                const made = await env.createDir(
                    join(own, "checkout"),
                    { recursive: true },
                    context,
                );

                assert.equal(made.ok, session === id);
                assert.equal(
                    (await env.writeFile(join(own, "checkout", "note.txt"), "own", context)).ok,
                    session === id,
                );
                assert.equal(
                    (await env.createDir(join(other, "checkout"), { recursive: true }, context)).ok,
                    false,
                );
                assert.equal((await env.writeFile(outside, "outside", context)).ok, false);
            }
        } finally {
            await computer.runner.stop();
            await close(setup);
            rmSync(own, { recursive: true, force: true });
            rmSync(other, { recursive: true, force: true });
            rmSync(outside, { force: true });
        }
    });

    it("expires after idle time, keeps a running command in use, and asks again for an expired session", async () => {
        const setup = await serve();
        const computer = await start(setup, { approvalMs: 600 });
        const work = folder("expiry");
        const link = setup.runners.link(computer.id);

        try {
            await link.confirm({ kind: "new", person: "Owner", folder: work, session: "s" });
            assert.equal(computer.asked.length, 1);

            const env = setup.runners.env(computer.id, work, {
                id: "s",
                folder: work,
                person: "Owner",
            });

            // A command that runs longer than the expiry keeps the session in use; the next request needs no question.
            const long = await exec(env, "sleep 1.2; echo done");

            assert.equal(long.output, "done\n");
            assert.equal((await exec(env, "echo next")).output, "next\n");
            assert.equal(computer.asked.length, 1, "in use: no question");

            // Idle longer than the expiry: the next request waits while the computer asks again.
            await sleep(900);
            computer.answer = undefined;
            const waiting = exec(env, "echo again");
            // Another request of the session waits on the same question; cancelling it keeps the question.
            const cancel = new AbortController();
            const other = env.exec("echo other", {}, withAbortSignal(cancel.signal, context));

            await until(() => computer.asked.length === 2, "the question for the expired session");
            await sleep(100);
            cancel.abort();
            await other;
            await sleep(200);
            assert.equal(computer.asked.length, 2, "one question for the session");
            assert.equal(computer.asked[1]!.signal.aborted, false, "the question still stands");
            assert.equal(computer.asked[1]!.expired, true);
            assert.equal(computer.asked[1]!.permission, "session");
            await until(() => link.questions.size === 1, "the question on the server");
            assert.equal([...link.questions.values()][0]!.expired, true);

            let settled = false;

            void waiting.finally(() => (settled = true));
            await sleep(100);
            assert.equal(settled, false, "the request waits");

            // Allow at the computer: the request goes on.
            computer.release(true);
            assert.equal((await waiting).output, "again\n");
            await until(() => link.questions.size === 0, "the question to end on the server");
            assert.equal(computer.settings.sessions?.[0]?.approvedBy, "computer");
        } finally {
            await computer.runner.stop();
            await close(setup);
        }
    });

    it("keeps an expired approval question and its requests across a drop, then accepts a code after reconnect", async () => {
        const setup = await serve();
        const computer = await start(setup, { approvalMs: 600, retryMs: [700] });
        const work = folder("expiry-drop");
        const link = setup.runners.link(computer.id);

        computer.settings.totp = { secret: base32(Buffer.from("reconnect approval!!")) };

        try {
            await link.confirm({ kind: "new", person: "Owner", folder: work, session: "s" });
            const approvedAt = computer.settings.sessions![0]!.approvedAt;
            const env = setup.runners.env(computer.id, work, {
                id: "s",
                folder: work,
                person: "Owner",
            });

            await sleep(900);
            computer.answer = undefined;
            const waiting = exec(env, "echo approved after reconnect");
            let settled = false;

            void waiting.then(() => (settled = true));
            await until(() => link.questions.size === 1, "the expired approval question");
            const question = [...link.questions.values()][0]!;
            const local = computer.asked[1]!;

            assert.equal(question.expired, true);
            assert.equal(local.expired, true);
            computer.runner.drop();
            await until(() => !link.online, "the dropped link");
            assert.equal(link.questions.size, 0, "the server clears its disconnected view");
            await sleep(100);
            assert.equal(local.signal.aborted, false, "the computer keeps its question open");
            assert.equal(settled, false, "a drop neither denies nor grants the request");
            assert.equal(computer.settings.sessions![0]!.approvedAt, approvedAt);

            await until(
                () => link.online && link.questions.has(question.id),
                "the same approval question after reconnect",
            );
            await sleep(100);
            assert.equal(settled, false, "reconnecting does not approve the session");
            assert.equal(computer.asked.length, 2, "the computer did not ask a second question");
            assert.equal(local.signal.aborted, false);
            await link.approveCode(question.id, codeNow(computer.settings));
            const result = await waiting;

            assert.equal(result.ok, true, result.message);
            assert.equal(result.output, "approved after reconnect\n");
            assert.equal(computer.settings.sessions![0]!.approvedBy, "totp");
            await until(() => link.questions.size === 0, "the answered question to end");
        } finally {
            await computer.runner.stop();
            await close(setup);
        }
    });

    for (const allow of [true, false]) {
        it(`delivers a new session's offline ${allow ? "Allow" : "Deny"} answer after reconnect`, async () => {
            const setup = await serve();
            const computer = await start(setup, { retryMs: [1000] });
            const work = folder("confirm-drop");
            const link = setup.runners.link(computer.id);

            computer.answer = undefined;

            try {
                const confirmed = link.confirm({
                    kind: "new",
                    person: "Owner",
                    folder: work,
                    session: "new",
                });
                let settled = false;

                void confirmed.then(
                    () => (settled = true),
                    () => (settled = true),
                );
                await until(() => computer.asked.length === 1, "the new session's question");
                const local = computer.asked[0]!;

                computer.runner.drop();
                await until(() => !link.online, "the dropped confirm link");
                assert.equal(local.signal.aborted, false);
                computer.release(allow);
                await until(() => local.signal.aborted, "the offline answer to finish saving");
                assert.equal(link.online, false, "the computer answered while still offline");
                assert.equal(settled, false, "the server still waits for its confirm answer");
                assert.equal(
                    computer.settings.sessions?.some((session) => session.id === "new") ?? false,
                    allow,
                );
                await until(() => link.online, "the confirm link to reconnect");

                if (allow) {
                    await confirmed;
                } else {
                    await assert.rejects(confirmed, /did not allow the session/);
                }

                assert.equal(computer.asked.length, 1);
                await until(
                    () => link.questions.size === 0,
                    "the offline-answered question to end",
                );
            } finally {
                await computer.runner.stop();
                await close(setup);
            }
        });
    }

    it("never saves a broad folder, and ignores one found in the list", async () => {
        const setup = await serve();
        const computer = await start(setup);
        const link = setup.runners.link(computer.id);

        try {
            await link.confirm({
                kind: "new",
                person: "Owner",
                folder: homedir(),
                session: "home",
            });
            assert.equal(computer.asked[0]!.broad, true);
            assert.deepEqual(computer.settings.folders ?? [], []);
            assert.equal(computer.settings.sessions?.[0]?.id, "home");

            computer.settings.folders = [homedir()];
            computer.settings.confirm = false;
            await link.confirm({
                kind: "new",
                person: "Owner",
                folder: join(homedir(), "pi-pocket-missing"),
                session: "below",
            });
            assert.equal(
                computer.asked.length,
                2,
                "stop asking does not apply: the folder is broad",
            );
            assert.equal(computer.asked[1]!.permission, "folder");
            await until(
                () => link.state?.folders.length === 0,
                "Runners to leave the broad folder out",
            );
        } finally {
            await computer.runner.stop();
            await close(setup);
        }
    });

    it("revokes one session and all of them from Pi Pocket without a code", async () => {
        const setup = await serve();
        const computer = await start(setup);
        const work = folder("revoke");
        const link = setup.runners.link(computer.id);

        try {
            for (const session of ["a", "b", "c"]) {
                await link.confirm({ kind: "new", person: "Owner", folder: work, session });
            }

            await link.action({ action: "revoke", session: "a" });
            assert.deepEqual(link.state?.sessions.map((each) => each.id).sort(), ["b", "c"]);

            // The revoked session's next request asks again.
            computer.answer = { allow: false };
            const env = setup.runners.env(computer.id, work, {
                id: "a",
                folder: work,
                person: "Owner",
            });

            assert.equal((await exec(env, "true")).ok, false);
            await link.action({ action: "revoke", session: "all" });
            assert.deepEqual(link.state?.sessions, []);

            // Removing a saved folder: no code either.
            await link.action({ action: "remove-folder", folder: await realFolder(work) });
            assert.deepEqual(link.state?.folders, []);
        } finally {
            await computer.runner.stop();
            await close(setup);
        }
    });
});

describe("authenticator codes from Pi Pocket", () => {
    const secret = base32(Buffer.from("an authenticator!!!!"));

    it("approve a folder and a session, refuse a wrong or used code, and change a setting", async () => {
        const setup = await serve();
        const computer = await start(setup);
        const link = setup.runners.link(computer.id);
        const work = folder("totp");

        computer.settings.totp = { secret };
        computer.answer = undefined;

        try {
            await until(() => link.state?.totp === true, "the authenticator in Runners");

            // A folder without permission: approved with a code from Pi Pocket, which saves the folder.
            const started = link.confirm({
                kind: "new",
                person: "Owner",
                folder: work,
                session: "t1",
            });

            await until(() => link.questions.size === 1, "the question on the server");
            const question = [...link.questions.values()][0]!;

            assert.equal(question.totp, true);
            assert.equal(question.permission, "folder");
            assert.equal(
                computer.asked[0]!.expiresInMs,
                300_000,
                "5 minutes with an authenticator",
            );
            await assert.rejects(link.approveCode(question.id, "000000"), {
                status: 400,
                message: "That code is wrong or used. Try the next one.",
            });
            assert.equal(link.questions.size, 1, "a wrong code keeps the question");

            const code = codeNow(computer.settings);

            await link.approveCode(question.id, code);
            await started;
            assert.deepEqual(computer.settings.folders, [await realFolder(work)]);

            const approved = computer.settings.sessions?.find((each) => each.id === "t1");

            assert.equal(approved?.approvedBy, "totp");
            assert.equal(approved?.ttlMs, 7 * 86_400_000, "7 days by default");

            // A saved folder: session permission, with a code; a used code is refused.
            const second = link.confirm({
                kind: "new",
                person: "Owner",
                folder: work,
                session: "t2",
            });

            await until(() => link.questions.size === 1, "the session question");
            const next = [...link.questions.values()][0]!;

            assert.equal(next.permission, "session");
            await assert.rejects(link.approveCode(next.id, code), /wrong or used/);
            nextStep(computer.settings);
            await link.approveCode(next.id, codeNow(computer.settings));
            await second;
            assert.equal(computer.asked.length, 2, "both questions also showed at the computer");

            // A setting change: one code for one change.
            await assert.rejects(
                link.action({ action: "settings", code: "123456", change: { totpDays: 30 } }),
                /wrong or used/,
            );
            assert.equal(computer.settings.totpDays, undefined);
            nextStep(computer.settings);
            await assert.rejects(
                link.action({
                    action: "settings",
                    code: codeNow(computer.settings),
                    change: { totpDays: 30, network: false },
                }),
                /one runner setting at a time/,
            );
            await link.action({
                action: "settings",
                code: codeNow(computer.settings),
                change: { totpDays: 30 },
            });
            assert.equal(computer.settings.totpDays, 30);
            assert.equal(link.state?.settings.totpDays, 30);
            assert.ok(
                !JSON.stringify(link.state).includes(secret),
                "the secret stays on the computer",
            );
        } finally {
            await computer.runner.stop();
            await close(setup);
        }
    });

    it("without an authenticator, settings change only on the computer", async () => {
        const setup = await serve();
        const computer = await start(setup);
        const link = setup.runners.link(computer.id);

        try {
            assert.equal(link.state?.totp, false);
            await assert.rejects(
                link.action({ action: "settings", code: "123456", change: { stopAsking: true } }),
                /wrong or used|authenticator/,
            );
            assert.equal(computer.settings.confirm, undefined);
        } finally {
            await computer.runner.stop();
            await close(setup);
        }
    });
});

// ─── The command line ──────────────────────────────────────────────────

describe("pi-pocket runner totp, sessions, and unlink", () => {
    const run = (file: string, args: string[], input?: string) =>
        new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve) => {
            const child = spawn(process.execPath, [launcher, "runner", ...args, "--config", file]);
            let stdout = "";
            let stderr = "";

            child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
            child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
            child.once("close", (code) => resolve({ code, stdout, stderr }));
            child.stdin.end(input ?? "");
        });

    function linkFile(settings: RunnerSettings = {}): string {
        const file = join(mkdtempSync(join(root, "cli-")), "runner.json");

        writeFileSync(
            file,
            JSON.stringify({
                server: "https://example.com",
                id: "id",
                name: "Computer",
                key: "secret-key",
                settings,
            }),
            { mode: 0o600 },
        );

        return file;
    }

    it("settings confirm on|off is the same as stop-asking off|on", async () => {
        const file = linkFile();

        for (const [name, value, confirm] of [
            ["confirm", "off", false],
            ["confirm", "on", true],
            ["stop-asking", "on", false],
            ["stop-asking", "off", true],
        ] as const) {
            const result = await run(file, ["settings", name, value, "--json"]);
            const changed = JSON.parse(result.stdout);

            assert.equal(result.code, 0, result.stderr);
            assert.equal(changed.ok, true);
            assert.equal(changed.settings.stopAsking, !confirm);
            assert.equal(JSON.parse(readFileSync(file, "utf8")).settings.confirm, confirm);
        }

        const help = await run(file, ["--help"]);

        assert.match(help.stdout, /confirm on\|off +The same as stop-asking off\|on/);
    });

    it("sets up only after one correct code, turns off only with a code, and unlink removes it", async () => {
        const file = linkFile();
        const setup = spawn(process.execPath, [
            launcher,
            "runner",
            "totp",
            "setup",
            "--json",
            "--config",
            file,
        ]);
        const lines: Record<string, unknown>[] = [];

        createInterface({ input: setup.stdout }).on("line", (line) => lines.push(JSON.parse(line)));
        const ended = new Promise((resolve) => setup.once("close", resolve));

        await until(() => lines.length === 1, "the secret line");
        const shown = lines[0] as { secret: string; link: string };

        assert.match(
            shown.link,
            /^otpauth:\/\/totp\/Pi%20Pocket:Computer\?secret=[A-Z2-7]+&issuer=Pi%20Pocket$/,
        );
        assert.equal(
            JSON.parse(readFileSync(file, "utf8")).settings.totp,
            undefined,
            "not saved yet",
        );
        setup.stdin.write("000000\n");
        await until(() => lines.length === 2, "the wrong code's answer");
        assert.deepEqual(lines[1], {
            ok: false,
            error: "That code is wrong or used. Try the next one.",
        });
        assert.equal(JSON.parse(readFileSync(file, "utf8")).settings.totp, undefined);
        setup.stdin.write(`${totp(shown.secret, Math.floor(Date.now() / STEP_MS))}\n`);
        await until(() => lines.length === 3, "the right code's answer");
        assert.deepEqual(lines[2], { ok: true, totp: true });
        setup.stdin.end();
        await ended;

        const saved = JSON.parse(readFileSync(file, "utf8"));

        assert.equal(saved.settings.totp.secret, shown.secret);
        assert.equal((readFileSync(file).length > 0, true), true);
        assert.deepEqual(JSON.parse((await run(file, ["totp", "status", "--json"])).stdout), {
            totp: true,
            locked: false,
        });

        // Off needs a code; a wrong one changes nothing.
        const wrong = await run(file, ["totp", "off", "000000", "--json"]);

        assert.equal(wrong.code, 1);
        assert.deepEqual(JSON.parse(wrong.stdout), {
            ok: false,
            error: "That code is wrong or used. Try the next one.",
        });
        assert.equal(JSON.parse(readFileSync(file, "utf8")).settings.totp.secret, shown.secret);

        const help = await run(file, ["--help"]);

        assert.match(
            help.stdout.replace(/\s+/g, " "),
            /Lost your authenticator\? Unlink this computer \(pi-pocket runner unlink, or Unlink in a program that runs the runner, such as the desktop app\), then link it again\./,
        );

        // Unlink: no code; the link file, and with it the secret, the folders, and the sessions, are gone.
        const unlinked = await run(file, ["unlink", "--json"]);

        assert.deepEqual(JSON.parse(unlinked.stdout), { ok: true, unlinked: true });
        assert.throws(() => readFileSync(file), /ENOENT/);
    });

    it("turns the authenticator off with a right code", async () => {
        const secret = base32(Buffer.from("another secret here!"));
        const file = linkFile({ totp: { secret } });
        const code = totp(secret, Math.floor(Date.now() / STEP_MS));
        const off = await run(file, ["totp", "off", code, "--json"]);

        assert.deepEqual(JSON.parse(off.stdout), { ok: true, totp: false });
        assert.equal(JSON.parse(readFileSync(file, "utf8")).settings.totp, undefined);
    });

    it("lists approved sessions, and revokes one or all", async () => {
        const now = Date.now();
        const session = (id: string, approvedBy: string, ttlMs: number | null) => ({
            id,
            folder: "/work",
            person: "Owner",
            approvedBy,
            approvedAt: now,
            idleAt: now,
            ttlMs,
        });
        const file = linkFile({
            sessions: [
                session("a", "computer", 30 * 3_600_000),
                session("b", "totp", null),
                session("c", "automatic", 1),
            ] as RunnerSettings["sessions"],
        });
        const listed = JSON.parse((await run(file, ["sessions", "--json"])).stdout) as {
            id: string;
            approvedBy: string;
            expiresAt: number | null;
            expired: boolean;
        }[];

        assert.deepEqual(
            listed.map((each) => [each.id, each.approvedBy, each.expiresAt === null, each.expired]),
            [
                ["a", "computer", false, false],
                ["b", "totp", true, false],
                ["c", "automatic", false, true],
            ],
        );
        assert.match(
            (await run(file, ["sessions"])).stdout,
            /a {2}\/work {2}Owner, approved at this computer, expires/,
        );
        assert.deepEqual(
            JSON.parse((await run(file, ["sessions", "revoke", "a", "--json"])).stdout),
            {
                ok: true,
                revoked: 1,
            },
        );
        assert.equal((await run(file, ["sessions", "revoke", "a"])).code, 1);
        assert.deepEqual(
            JSON.parse((await run(file, ["sessions", "revoke", "all", "--json"])).stdout),
            {
                ok: true,
                revoked: 2,
            },
        );
        assert.deepEqual(JSON.parse(readFileSync(file, "utf8")).settings.sessions, []);
    });

    it("shows the new settings, also as JSON", async () => {
        const file = linkFile({ confirm: false, totpDays: null });
        const json = JSON.parse((await run(file, ["settings", "--json"])).stdout);

        assert.deepEqual(json, {
            stopAsking: true,
            totpDays: null,
            allowHttp: false,
            network: true,
            downloads: null,
            totp: false,
        });
        assert.match(
            (await run(file, ["settings"])).stdout,
            /stop-asking on\ntotp-days never\ntotp off/,
        );
        await promisify(execFile)(process.execPath, [
            launcher,
            "runner",
            "settings",
            "totp-days",
            "14",
            "--config",
            file,
        ]);
        assert.equal(JSON.parse(readFileSync(file, "utf8")).settings.totpDays, 14);
    });
});

assert.equal(LINK_PROTOCOL, 1);
