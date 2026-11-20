// Where a copy of a session runs (`commands.ts` `fork`/`resend` with `place`): this server or a linked computer, a
// folder there, a model and thinking level. Two real runners connect over real WebSockets to real pi-env daemons on
// this machine, each in a folder of its own. Also: each session's repository (`repo.ts`), the folder a copy suggests,
// and the folder picker's Recent and Favorites per computer.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import {
    fauxAssistantMessage,
    fauxText,
    type FauxResponseStep,
} from "@earendil-works/pi-ai/providers/faux";
import type { ConversationId } from "@earendil-works/pi-durable";
import { Runner, type SessionAnswer, type SessionQuestion } from "../src/runner/runner.ts";
import { ChatDoc, FolderFavoritesDoc } from "../src/server/docs.ts";
import { normalizeRemote } from "../src/server/repo.ts";
import { REMOTE_EXTENSIONS } from "../src/server/runners.ts";
import {
    type App,
    cleanUp,
    context,
    lastText,
    newSession,
    openApp,
    owner,
    root,
    say,
    scriptedModel,
    until,
    work,
} from "./helpers.ts";

/** What the model got in its newest request, as text. */
let seen = "";

const route: FauxResponseStep = (request) => {
    seen = JSON.stringify(request.messages);

    return fauxAssistantMessage([fauxText(`ok: ${lastText(request as never).text}`)]);
};

let app: App;
let server: Server;
let port: number;

/** A linked computer: its runner, id, and folder. */
type Computer = { runner: Runner; id: string; folder: string; settings: { confirm?: boolean } };

const asked: SessionQuestion[] = [];
let answer: (question: SessionQuestion) => Promise<SessionAnswer> = () =>
    Promise.resolve({ allow: true });

async function link(name: string): Promise<Computer> {
    const folder = join(root, name.toLowerCase());
    const settings: { confirm?: boolean } = {};

    mkdirSync(folder, { recursive: true });
    const { code } = app.runners.makeCode(name, owner(app).id);
    const linked = app.runners.redeem(code);
    const runner = new Runner({
        link: { server: `http://127.0.0.1:${port}`, ...linked },
        version: "test",
        cwd: folder,
        log: () => {},
        retryMs: [50, 100, 200],
        settings: () => settings,
        ask: (question) => {
            asked.push(question);

            return answer(question);
        },
    });

    runner.start();
    await until(
        () => app.runners.list().find((each) => each.id === linked.id)?.online === true,
        `${name} to connect`,
    );

    return { runner, id: linked.id, folder, settings };
}

let laptop: Computer;
let desk: Computer;

/** A git repository at `folder` whose origin is `url`. */
function repository(folder: string, url: string): void {
    mkdirSync(folder, { recursive: true });
    execFileSync("git", ["init", "-q"], { cwd: folder });
    execFileSync("git", ["remote", "add", "origin", url], { cwd: folder });
}

/** The newest activity lines of a session's chat. */
async function activity(id: ConversationId): Promise<string[]> {
    const chat = await app.harness.snapshot(ChatDoc, id, context);

    return (chat?.messages ?? []).filter((each) => each.kind === "event").map((each) => each.text);
}

/** A session on this server with one exchange, in `cwd`. */
async function talked(cwd = work): Promise<{ id: ConversationId; reply: number; prompt: number }> {
    const id = await newSession(app, cwd);

    await say(app, id, "hello there");
    const entries = (await (await app.conversation(id)).entries({}, 10, undefined, context)).items;

    return {
        id,
        reply: Number(entries.find((entry) => entry.kind === "pi.assistant")!.id),
        prompt: Number(entries.find((entry) => entry.kind === "pi.user")!.id),
    };
}

before(async () => {
    app = await openApp(scriptedModel(route));
    app.config.lastModel ??= { provider: "faux", modelId: "faux-1", thinkingLevel: "off" };
    server = createServer((request, response) => response.writeHead(404).end());
    server.on("upgrade", (request, socket, head) => {
        if (!app.runners.upgrade(request, socket, head)) {
            socket.destroy();
        }
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    port = (server.address() as AddressInfo).port;
    laptop = await link("Laptop");
    desk = await link("Desk");
});

after(async () => {
    await laptop?.runner.stop();
    await desk?.runner.stop();
    await app?.close();
    server?.closeAllConnections();
    await new Promise((resolve) => server?.close(resolve));
    cleanUp();
});

/** A remote with a user and a made-up token in it, built here so that secret scanners do not take it for a real one. */
const withToken = (user: string, token: string, rest: string) => `https://${user}:${token}@${rest}`;

describe("a repository's name", () => {
    it("is one for every way to write it, without user names or tokens", () => {
        const same = [
            "git@GitHub.com:vitalNohj/pi-pocket.git",
            "https://github.com/vitalNohj/pi-pocket",
            withToken("user", "not-a-token", "GitHub.COM/vitalNohj/pi-pocket.git/"),
            "ssh://git@github.com:22/vitalNohj/pi-pocket.git",
            "git+ssh://git@github.com/vitalNohj/pi-pocket",
        ];

        for (const url of same) {
            assert.equal(normalizeRemote(url), "github.com/vitalNohj/pi-pocket", url);
        }

        assert.ok(!normalizeRemote(withToken("me", "tok3n", "host/a/b"))!.includes("tok3n"));
        assert.equal(normalizeRemote("/srv/git/app.git"), "/srv/git/app");
        assert.equal(normalizeRemote("file:///srv/git/app.git"), "/srv/git/app");
        assert.equal(normalizeRemote("C:\\repos\\app"), "C:\\repos\\app");
        assert.equal(normalizeRemote(""), undefined);
    });

    it("is noted when a session starts, is copied, or moves, and left out without a remote", async () => {
        const app1 = join(root, "repos", "app");

        repository(app1, withToken("token", "x-oauth", "GitHub.com/me/app.git"));
        const id = await newSession(app, app1);

        await until(() => app.sessionMeta(id)?.repo !== undefined, "the repository to be noted");
        assert.equal(app.sessionMeta(id)?.repo, "github.com/me/app");

        const plain = await newSession(app, work);

        await new Promise((resolve) => setTimeout(resolve, 200));
        assert.equal(app.sessionMeta(plain)?.repo, undefined);

        await app.commands.configure(plain, owner(app), { cwd: app1 });
        await until(
            () => app.sessionMeta(plain)?.repo !== undefined,
            "the moved session's repository",
        );
        assert.equal(app.sessionMeta(plain)?.repo, "github.com/me/app");

        // On another computer, by one git command there.
        const there = join(laptop.folder, "app");

        repository(there, "git@github.com:me/app.git");
        const remote = await app.commands.createSession(owner(app), {
            cwd: there,
            runner: laptop.id,
        });

        await until(() => app.sessionMeta(remote.id)?.repo !== undefined, "the remote repository");
        assert.equal(app.sessionMeta(remote.id)?.repo, "github.com/me/app");
    });
});

describe("a copy with a place", () => {
    it("without place, or with an empty one, is the fork it always was", async () => {
        const { id, reply } = await talked();
        const plain = await app.commands.fork(id, owner(app), { entryId: reply });
        const empty = await app.commands.fork(id, owner(app), { entryId: reply, place: {} });

        for (const copy of [plain, empty]) {
            assert.equal(app.runnerOf(copy.id), undefined);
            assert.equal(app.cwdOf(copy.id), work);
            assert.equal((await app.agentState(copy.id))?.model?.modelId, "faux-1");
        }

        const lines = await activity(empty.id);

        assert.ok(
            lines.some((line) => /^forked this from “/.test(line) && !line.includes(" to run on ")),
        );
    });

    it("checks every field", async () => {
        const { id, reply } = await talked();
        const bad = [
            "nope",
            { runner: 5 },
            { runner: "" },
            { cwd: 7 },
            { model: { provider: "faux" } },
            { thinkingLevel: "loud" },
            { worktree: "yes" },
        ];

        for (const place of bad) {
            await assert.rejects(app.commands.fork(id, owner(app), { entryId: reply, place }), {
                status: 400,
            });
        }

        await assert.rejects(
            app.commands.fork(id, owner(app), {
                entryId: reply,
                place: { model: { provider: "faux", modelId: "missing" } },
            }),
            /Unknown model faux\/missing/,
        );
    });

    it("sets the model and thinking level, and tells Pi of another folder on the same computer", async () => {
        const { id, reply } = await talked();
        const elsewhere = join(root, "elsewhere");

        mkdirSync(elsewhere, { recursive: true });
        const copy = await app.commands.fork(id, owner(app), {
            entryId: reply,
            place: {
                runner: null,
                cwd: elsewhere,
                model: { provider: "faux", modelId: "faux-2" },
                thinkingLevel: "high",
            },
        });
        const agent = await app.agentState(copy.id);

        assert.equal(agent?.model?.modelId, "faux-2");
        // faux-2 does not think: the level is the highest it has.
        assert.equal(agent?.thinkingLevel, "off");
        assert.equal(agent?.cwd, elsewhere);
        assert.equal(app.sessionMeta(copy.id)?.cwd, elsewhere);
        assert.equal(app.cwdOf(id), work, "the original stays");

        await say(app, copy.id, "where am I");
        assert.match(seen, /made this copy to run on This server in .*elsewhere\. Paths earlier/);
        assert.ok(
            (await activity(copy.id)).some((line) => line.includes("to run on This server in")),
        );
        assert.ok((await activity(id)).some((line) => line.includes("to run on This server in")));
    });

    it("goes to another computer: asked there, with the remote extensions, and Pi is told", async () => {
        const { id, reply } = await talked();

        asked.length = 0;
        const copy = await app.commands.fork(id, owner(app), {
            entryId: reply,
            place: { runner: laptop.id, cwd: laptop.folder },
        });

        assert.equal(app.runnerOf(copy.id), laptop.id);
        assert.equal(app.sessionMeta(copy.id)?.runner, laptop.id);
        assert.equal(app.sessionMeta(copy.id)?.cwd, laptop.folder);
        assert.deepEqual(
            asked.map((each) => [each.kind, each.folder]),
            [["fork", laptop.folder]],
        );
        assert.deepEqual((await app.agentState(copy.id))?.extensions, [...REMOTE_EXTENSIONS]);

        const agent = await (await app.conversation(copy.id)).agent(context);
        // Subagent waits for tool search, codemode is offered at once: both are tools of the copy.
        const tools = [...agent.tools, ...agent.deferred].map((tool) => tool.name);

        assert.ok(tools.includes("subagent"), "subagents work on another computer");
        assert.ok(tools.includes("codemode"), "codemode works on another computer");

        await say(app, copy.id, "where now");
        assert.match(
            seen,
            /run on Laptop in .*\. Paths earlier in this conversation were on This server in/,
        );
        assert.ok((await activity(id)).some((line) => line.includes("to run on Laptop in")));
    });

    it("comes back to this server with every extension again", async () => {
        const remote = await app.commands.createSession(owner(app), {
            cwd: laptop.folder,
            runner: laptop.id,
        });

        await app.commands.configure(remote.id, owner(app), {
            model: { provider: "faux", modelId: "faux-1" },
        });
        await say(app, remote.id, "on the laptop");
        const entries = (
            await (await app.conversation(remote.id)).entries({}, 10, undefined, context)
        ).items;
        const reply = Number(entries.find((entry) => entry.kind === "pi.assistant")!.id);

        assert.deepEqual((await app.agentState(remote.id))?.extensions, [...REMOTE_EXTENSIONS]);

        const back = await app.commands.fork(remote.id, owner(app), {
            entryId: reply,
            place: { runner: null },
        });

        assert.equal(app.runnerOf(back.id), undefined);
        assert.equal(app.sessionMeta(back.id)?.runner, undefined);
        assert.equal(app.cwdOf(back.id), work, "no folder named: the default workspace");
        assert.equal((await app.agentState(back.id))?.extensions, undefined);

        const backAgent = await (await app.conversation(back.id)).agent(context);
        const tools = [...backAgent.tools, ...backAgent.deferred].map((tool) => tool.name);

        assert.ok(tools.includes("subagent"), "the server's tools are back");
        assert.deepEqual(
            (await app.agentState(remote.id))?.extensions,
            [...REMOTE_EXTENSIONS],
            "the original keeps its list",
        );

        await say(app, back.id, "home again");
        assert.match(
            seen,
            /run on This server in .*Paths earlier in this conversation were on Laptop in/,
        );

        // From one computer to another.
        const across = await app.commands.fork(remote.id, owner(app), {
            entryId: reply,
            place: { runner: desk.id },
        });

        assert.equal(app.runnerOf(across.id), desk.id);
        assert.equal(
            app.cwdOf(across.id),
            app.commands.copySuggestion(remote.id, owner(app), desk.id).cwd,
        );
        assert.deepEqual((await app.agentState(across.id))?.extensions, [...REMOTE_EXTENSIONS]);

        // A copy of the copy, as it is: its folder is the copy's, not the one the history had at that reply.
        const again = await app.commands.fork(across.id, owner(app), { entryId: reply });

        assert.equal(app.runnerOf(again.id), desk.id);
        assert.equal(app.cwdOf(again.id), app.cwdOf(across.id));
        assert.equal((await app.agentState(again.id))?.cwd, app.cwdOf(across.id));
    });

    it("refuses a worktree outside a repository, and a folder that is not there", async () => {
        const { id, reply } = await talked();

        await assert.rejects(
            app.commands.fork(id, owner(app), {
                entryId: reply,
                place: { runner: laptop.id, worktree: true },
            }),
            /is not in a git repository/,
        );
        await assert.rejects(
            app.commands.fork(id, owner(app), {
                entryId: reply,
                place: { runner: laptop.id, cwd: join(laptop.folder, "nope") },
            }),
            /is not a folder on Laptop/,
        );
    });

    it("is the linker's alone on their computer", async () => {
        const { id, reply } = await talked();
        const { user: coOwner } = app.config.addUser("Co-owner", "owner");

        await assert.rejects(
            app.commands.fork(id, coOwner, { entryId: reply, place: { runner: laptop.id } }),
            { status: 403 },
        );
        await assert.rejects(
            app.commands.fork(id, coOwner, { entryId: reply, place: { runner: "nobody" } }),
            { status: 403 },
        );
    });

    it("is not made when the computer says no, is offline, or is gone", async () => {
        const { id, reply, prompt } = await talked();
        const count = () => app.sessions(owner(app)).length;
        const before = count();

        answer = () => Promise.resolve({ allow: false, reason: "Not now, said the laptop." });

        try {
            await assert.rejects(
                app.commands.fork(id, owner(app), { entryId: reply, place: { runner: laptop.id } }),
                /Not now, said the laptop/,
            );
            await assert.rejects(
                app.commands.resend(id, owner(app), {
                    entryId: prompt,
                    place: { runner: laptop.id },
                }),
                /Not now, said the laptop/,
            );
        } finally {
            answer = () => Promise.resolve({ allow: true });
        }

        // Linked, but its runner never started.
        const { code } = app.runners.makeCode("Shelf", owner(app).id);
        const shelf = app.runners.redeem(code);

        await assert.rejects(
            app.commands.fork(id, owner(app), { entryId: reply, place: { runner: shelf.id } }),
            /Shelf is offline/,
        );
        app.runners.remove(shelf.id);
        await assert.rejects(
            app.commands.fork(id, owner(app), { entryId: reply, place: { runner: shelf.id } }),
            /not linked to this server/,
        );

        assert.equal(count(), before, "no copy was made, here or there");
    });

    it("withdraws reply forks and resends without making their copies", async () => {
        const { id, reply, prompt } = await talked();

        for (const kind of ["fork", "resend"] as const) {
            const before = app.sessions(owner(app)).length;
            const controller = new AbortController();
            let late!: (answer: SessionAnswer) => void;

            asked.length = 0;
            answer = () =>
                new Promise((resolve) => {
                    late = resolve;
                });

            try {
                const request = {
                    entryId: kind === "fork" ? reply : prompt,
                    place: { runner: laptop.id },
                };
                const result =
                    kind === "fork"
                        ? app.commands.fork(id, owner(app), request, controller.signal)
                        : app.commands.resend(id, owner(app), request, controller.signal);
                const rejected = assert.rejects(result, { status: 409, message: "Cancelled." });

                await until(() => asked.length === 1, "the copy question");
                controller.abort();
                await rejected;
                await until(() => asked[0]!.signal.aborted, "the copy question to be withdrawn");
                late({ allow: true });
                await new Promise((resolve) => setTimeout(resolve, 50));
                assert.equal(app.sessions(owner(app)).length, before, "no cancelled copy was made");
            } finally {
                controller.abort();
                answer = () => Promise.resolve({ allow: true });
            }
        }
    });

    it("sends a message again on another computer with another model", async () => {
        const { id, prompt } = await talked();
        const copy = await app.commands.resend(id, owner(app), {
            entryId: prompt,
            text: "hello from the laptop",
            place: {
                runner: laptop.id,
                cwd: laptop.folder,
                model: { provider: "faux", modelId: "faux-2" },
            },
        });

        assert.equal(app.runnerOf(copy.id), laptop.id);
        assert.equal((await app.agentState(copy.id))?.model?.modelId, "faux-2");
        await until(async () => seen.includes("hello from the laptop"), "the message to go out");
        // Before the first message there is no history to have paths in: no note.
        assert.ok(!seen.includes("Paths earlier"));
        assert.ok((await activity(copy.id)).some((line) => line.includes("edited a message")));
    });

    it("keeps the old fields working, and the session's own model is the same model", async () => {
        const { id, prompt } = await talked();
        const same = await app.commands.resend(id, owner(app), {
            entryId: prompt,
            place: { model: { provider: "faux", modelId: "faux-1" } },
        });

        assert.match(app.sessionMeta(same.id)?.title ?? "", /· retry$/);

        const other = await app.commands.resend(id, owner(app), {
            entryId: prompt,
            model: { provider: "faux", modelId: "faux-2" },
        });

        assert.equal((await app.agentState(other.id))?.model?.modelId, "faux-2");
    });
});

describe("the folder a copy suggests", () => {
    it("is the session's own on its computer, the same repository elsewhere, else a namesake, else home", async () => {
        const mine = join(root, "repos", "suggested");

        repository(mine, "https://github.com/me/suggested.git");
        const id = await newSession(app, mine);

        await until(() => app.sessionMeta(id)?.repo !== undefined, "its repository");
        assert.deepEqual(app.commands.copySuggestion(id, owner(app), null), {
            cwd: mine,
            reason: "current",
        });
        assert.deepEqual(app.commands.copySuggestion(id, owner(app), desk.id), {
            cwd: app.runners.stored(desk.id)!.platform!.home,
            reason: "home",
        });

        const namesake = join(desk.folder, "suggested");

        mkdirSync(namesake, { recursive: true });
        await app.commands.createSession(owner(app), { cwd: namesake, runner: desk.id });
        assert.deepEqual(app.commands.copySuggestion(id, owner(app), desk.id), {
            cwd: namesake,
            reason: "name",
        });

        const clone = join(desk.folder, "checkout");

        repository(clone, "git@github.com:me/suggested");
        const there = await app.commands.createSession(owner(app), { cwd: clone, runner: desk.id });

        await until(() => app.sessionMeta(there.id)?.repo !== undefined, "the clone's repository");
        assert.deepEqual(app.commands.copySuggestion(id, owner(app), desk.id), {
            cwd: clone,
            reason: "repository",
        });
        assert.throws(() => app.commands.copySuggestion(id, owner(app), "nobody"), {
            status: 404,
        });
    });
});

describe("the folder picker's places, per computer", () => {
    it("lists recent folders of that computer's sessions only", () => {
        const here = app.recentFolders(owner(app), undefined);
        const there = app.recentFolders(owner(app), laptop.id);

        assert.ok(here.length > 0 && there.length > 0);
        assert.ok(
            here.every((path) => !path.startsWith(laptop.folder)),
            "no Laptop folder here",
        );
        assert.ok(
            there.every((path) => path.startsWith(laptop.folder)),
            "only Laptop folders there",
        );
    });

    it("keeps favorites per computer; the old ones stay this server's", async () => {
        const me = owner(app);
        const old = join(root, "old-favorite");

        // As stored before computers had favorites.
        await app.harness.commit(async (tx) => {
            (await tx.doc(FolderFavoritesDoc)).users[me.id] = [old];
        }, context);
        assert.deepEqual(await app.folderFavorites.list(me), [old]);

        await app.folderFavorites.set(me, {
            path: `${laptop.folder}/`,
            starred: true,
            runner: laptop.id,
        });
        await app.folderFavorites.set(me, { path: "C:\\work\\", starred: true, runner: desk.id });
        assert.deepEqual(await app.folderFavorites.list(me), [old], "this server's are apart");
        assert.deepEqual(await app.folderFavorites.runners(me), {
            [laptop.id]: [laptop.folder],
            [desk.id]: ["C:\\work"],
        });

        await app.folderFavorites.set(me, {
            path: laptop.folder,
            starred: false,
            runner: laptop.id,
        });
        assert.deepEqual(await app.folderFavorites.runners(me), { [desk.id]: ["C:\\work"] });

        const { user: coOwner } = app.config.addUser("Other owner", "owner");

        await assert.rejects(
            app.folderFavorites.set(coOwner, { path: "/x", starred: true, runner: laptop.id }),
            { status: 403 },
        );
        await assert.rejects(
            app.folderFavorites.set(me, { path: "C:\\x", starred: true }),
            { status: 400 },
            "a Windows path is no folder on this server",
        );
        await assert.rejects(
            app.folderFavorites.set(me, { path: "/x", starred: true, runner: "nobody" }),
            { status: 404 },
        );
    });
});
