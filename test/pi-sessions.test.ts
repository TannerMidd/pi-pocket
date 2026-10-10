// Pi's sessions from the terminal, continued here: Pi gets the context Pi itself builds from the file, people get the
// whole conversation, nothing Pi did runs again, the file is never written, and only the owner can do it.
import {
    type App,
    cleanUp,
    context,
    lastText,
    openApp,
    owner,
    root,
    say,
    scriptedModel,
    work,
} from "./helpers.ts";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import { after, before, test } from "node:test";
import type { FauxResponseStep, Message } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import {
    buildSessionContext,
    convertToLlm,
    parseSessionEntries,
    type SessionEntry,
    SessionManager,
} from "@earendil-works/pi-coding-agent";
import type { ConversationId } from "@earendil-works/pi-durable";
import { createHandler } from "../src/server/http.ts";
import { PiSessionError, readPiSession } from "../src/server/pi-sessions.ts";
import { projectEntry } from "../src/server/projection.ts";

/** The messages of the newest request to the model. */
let requested: Message[] = [];

const route: FauxResponseStep = (request) => {
    requested = (request as { messages: Message[] }).messages;

    return fauxAssistantMessage([fauxText(`echo: ${lastText(request as never).text}`)]);
};

let app: App;
const sessions = join(process.env.PI_CODING_AGENT_DIR!, "sessions");
const image = { type: "image" as const, data: "aGVsbG8=", mimeType: "image/png" };

before(async () => {
    app = await openApp(scriptedModel(route), join(root, "pi-sessions-data"));
});

after(async () => {
    await app?.close();
    cleanUp();
});

/** Write a session as Pi does, into the folder of its project in Pi's sessions folder; its path. */
function save(manager: SessionManager, name = "session"): string {
    const folder = join(sessions, `--${manager.getCwd().replace(/^\//, "").replace(/\//g, "-")}--`);
    const path = join(folder, `${name}.jsonl`);

    mkdirSync(folder, { recursive: true });
    writeFileSync(
        path,
        [manager.getHeader(), ...manager.getEntries()]
            .map((entry) => JSON.stringify(entry))
            .join("\n") + "\n",
    );

    return path;
}

/**
 * A session with everything Pi writes: a name, model and thinking changes, Pi's system messages, a tool call and its
 * result, an image, a branch left with a summary, an extension's message, `!` and `!!` commands, a compaction that
 * keeps the last turns, and context edits that replace one message and leave one out.
 */
function rich(cwd = work): SessionManager {
    const manager = SessionManager.inMemory(cwd);

    manager.appendModelChange("faux", "faux-1");
    manager.appendThinkingLevelChange("off");
    manager.appendSessionInfo("Fix the checkout total");
    manager.appendMessage({ role: "system", content: "Pi's own prompt", timestamp: 1 });
    manager.appendMessage({
        role: "user",
        content: [{ type: "text", text: "The total is off by a cent." }, image],
        timestamp: 2,
    });
    manager.appendMessage(
        fauxAssistantMessage([fauxToolCall("read", { path: "cart.ts" }, { id: "call-1" })], {
            stopReason: "toolUse",
        }),
    );
    manager.appendMessage({
        role: "toolResult",
        toolCallId: "call-1",
        toolName: "read",
        content: [{ type: "text", text: "export const total = (items) => items.reduce(...)" }],
        isError: false,
        timestamp: 3,
    });
    const fork = manager.appendMessage(fauxAssistantMessage([fauxText("Floats drift.")]));

    manager.appendMessage({ role: "user", content: "Try doubles", timestamp: 4 });
    manager.appendMessage(fauxAssistantMessage([fauxText("That will not help.")]));
    manager.branchWithSummary(fork, "Tried doubles; it did not help.");
    manager.appendMessage({ role: "user", content: "Use integer cents", timestamp: 5 });
    manager.appendMessage(
        fauxAssistantMessage([fauxText("Changing th")], { stopReason: "aborted" }),
    );
    manager.appendMessage(
        fauxAssistantMessage([], { stopReason: "error", errorMessage: "Overloaded" }),
    );
    manager.appendMessage(fauxAssistantMessage([fauxText("Changing the cart to cents.")]));
    manager.appendCustomMessageEntry("reminder", "Run the tests before you finish.", true);
    manager.appendMessage({
        role: "bashExecution",
        command: "npm test",
        output: "12 passing",
        exitCode: 0,
        cancelled: false,
        truncated: false,
        timestamp: 6,
    });
    manager.appendMessage({
        role: "bashExecution",
        command: "git status",
        output: "clean",
        exitCode: 0,
        cancelled: false,
        truncated: false,
        timestamp: 7,
        excludeFromContext: true,
    });
    const kept = manager.appendMessage({ role: "user", content: "Now the tax", timestamp: 8 });
    const long = manager.appendMessage(fauxAssistantMessage([fauxText("A long answer.")]));
    const noise = manager.appendMessage({ role: "user", content: "noise", timestamp: 9 });

    manager.appendCompaction("Cart totals use cents now.", kept, 5000);
    manager.appendMessage({ role: "user", content: "And rounding?", timestamp: 10 });
    manager.appendMessage(fauxAssistantMessage([fauxText("Round half to even.")]));
    manager.appendContextEdit(long, { content: "A short answer." });
    manager.appendContextEdit(noise, null);
    // Pi's model is the last one picked or answering: picked last here.
    manager.appendModelChange("faux", "faux-2");

    return manager;
}

/**
 * What Pi in the terminal sends the model for this session, Pi's own system messages left out. A reply that failed or
 * was stopped is in Pi's context but never sent: pi-ai's `transformMessages` drops it from every request, as Pi
 * Durable leaves it out of the context.
 */
function piContext(path: string): Message[] {
    const entries = parseSessionEntries(readFileSync(path, "utf8")).slice(1) as SessionEntry[];

    return convertToLlm(buildSessionContext(entries).messages).filter(
        (message) =>
            message.role !== "system" &&
            !(
                message.role === "assistant" &&
                (message.stopReason === "error" || message.stopReason === "aborted")
            ),
    );
}

/** What this session sends the model before Pi Pocket's own prompt joins it. */
async function pocketContext(id: ConversationId): Promise<Message[]> {
    const view = await (await app.harness.conversation(id, context))!.context(context);

    return (view.messages as Message[]).filter((message) => message.role !== "system");
}

/** The kinds of a session's entries, as people see them. */
async function shown(id: ConversationId) {
    const page = await (await app.harness.conversation(id, context))!.entries(
        {},
        500,
        undefined,
        context,
    );

    return [...page.items].reverse();
}

test("Pi gets the context Pi builds from the file; people get the whole conversation", async () => {
    const path = save(rich());
    const { id } = await app.commands.continuePiSession(owner(app), path);
    const expected = piContext(path);

    assert.ok(expected.length > 4, "the session has something to compare");
    assert.deepEqual(await pocketContext(id), expected);

    const entries = await shown(id);
    const texts = JSON.stringify(entries.map((entry) => entry.model ?? []));

    // Before the compaction, for people only; Pi's system messages and the `!!` command for nobody.
    assert.match(texts, /The total is off by a cent/);
    assert.match(texts, /Tried doubles/);
    assert.match(texts, /Changing th/, "a stopped reply shows, as it does in Pi");
    assert.doesNotMatch(texts, /Pi's own prompt/);
    assert.doesNotMatch(texts, /git status/);
    assert.ok(entries.some((entry) => entry.kind === "pi.compaction"));
    assert.equal(
        entries.at(-1)?.kind,
        "pocket.from-pi",
        "the history ends with where it came from",
    );
    const file = parseSessionEntries(readFileSync(path, "utf8"));

    assert.deepEqual(app.sessionMeta(id)?.fromPi, {
        session: file[0]!.id,
        count: file.filter((entry) => entry.type === "message").length,
    });
    assert.equal(app.sessionMeta(id)?.title, "Fix the checkout total");

    // The same after a restart.
    await app.close();
    app = await openApp(scriptedModel(route), join(root, "pi-sessions-data"));
    assert.deepEqual(await pocketContext(id), expected);
});

test("it continues with the session's model and folder, and Pi answers with the history", async () => {
    const path = save(rich(), "continued");
    const { id } = await app.commands.continuePiSession(owner(app), path);
    const agent = await (await app.harness.conversation(id, context))!.agent(context);

    assert.deepEqual(agent.model, { provider: "faux", modelId: "faux-2" });
    assert.equal(agent.cwd, work);
    await say(app, id, "Carry on");
    assert.match(JSON.stringify(requested), /Round half to even/);
    assert.match(JSON.stringify(requested), /A short answer/, "with Pi's context edit");
    assert.doesNotMatch(JSON.stringify(requested), /A long answer/);
    assert.match(lastText({ messages: requested } as never).text, /Carry on/);
});

test("a model not signed in here gives way to the usual one", async () => {
    const manager = SessionManager.inMemory(work);

    manager.appendModelChange("elsewhere", "big-model");
    manager.appendMessage({ role: "user", content: "hi", timestamp: 1 });
    const { id } = await app.commands.continuePiSession(owner(app), save(manager, "elsewhere"));
    const agent = await (await app.harness.conversation(id, context))!.agent(context);

    assert.equal(agent.model?.provider, "faux");
});

test("a tool call that never finished does not run: it gets a result saying so", async () => {
    const marker = join(work, "must-not-exist");
    const manager = SessionManager.inMemory(work);

    manager.appendMessage({ role: "user", content: "Make the file", timestamp: 1 });
    manager.appendMessage(
        fauxAssistantMessage(
            [fauxToolCall("bash", { command: `touch ${marker}` }, { id: "open" })],
            {
                stopReason: "toolUse",
            },
        ),
    );
    const { id } = await app.commands.continuePiSession(owner(app), save(manager, "open"));
    const results = (await pocketContext(id)).filter((message) => message.role === "toolResult");

    assert.equal(results.length, 1);
    assert.equal(results[0]!.isError, true);
    assert.match(JSON.stringify(results[0]!.content), /Not run: the Pi session ended/);
    await say(app, id, "What happened?");
    assert.equal(existsSync(marker), false);
});

test("Pi's files are only read: one cut off mid-line stays as it is", async () => {
    const path = save(rich(), "cut");
    const whole = readFileSync(path, "utf8");
    const cut = whole + '{"type":"message","id":"half';

    writeFileSync(path, cut);
    await app.piSessions.list(owner(app));
    await app.piSessions.preview(owner(app), path);
    const { id } = await app.commands.continuePiSession(owner(app), path);

    assert.equal(readFileSync(path, "utf8"), cut);
    assert.deepEqual(await pocketContext(id), piContext(path));
});

test("the list says which ones continue here, and when Pi went on since", async () => {
    const manager = rich();
    const path = save(manager, "listed");
    const find = async () =>
        (await app.piSessions.list(owner(app))).sessions.find((each) => each.path === path)!;

    assert.equal((await find()).title, "Fix the checkout total");
    assert.equal((await find()).cwd, work);
    assert.equal((await find()).pocket, undefined);
    const { id } = await app.commands.continuePiSession(owner(app), path);

    assert.deepEqual((await find()).pocket, { id: Number(id), behind: false });
    manager.appendMessage({ role: "user", content: "One more in the terminal", timestamp: 11 });
    save(manager, "listed");
    assert.deepEqual((await find()).pocket, { id: Number(id), behind: true });
    assert.deepEqual((await app.piSessions.preview(owner(app), path)).pocket, {
        id: Number(id),
        behind: true,
    });

    // Untitled: what it was first asked.
    const plain = SessionManager.inMemory(work);

    plain.appendMessage({ role: "user", content: "Why is CI red?\nIt was green.", timestamp: 1 });
    const untitled = save(plain, "untitled");

    assert.equal(
        (await app.piSessions.list(owner(app))).sessions.find((each) => each.path === untitled)
            ?.title,
        "Why is CI red?",
    );
});

test("only files Pi lists, from a Pi this one knows, in a folder that is there", async () => {
    const outside = join(root, "elsewhere.jsonl");

    writeFileSync(outside, readFileSync(save(rich(), "copy"), "utf8"));
    await assert.rejects(app.commands.continuePiSession(owner(app), outside), /no such session/);
    await assert.rejects(app.piSessions.preview(owner(app), "/etc/passwd"), /no such session/);

    const newer = save(rich(), "newer");
    const lines = readFileSync(newer, "utf8").split("\n");

    lines[0] = JSON.stringify({ ...JSON.parse(lines[0]!), version: 99 });
    writeFileSync(newer, lines.join("\n"));
    await assert.rejects(app.commands.continuePiSession(owner(app), newer), /newer Pi/);

    const gone = save(rich(join(root, "deleted-project")), "gone");

    assert.equal((await app.piSessions.preview(owner(app), gone)).cwdExists, false);
    await assert.rejects(app.commands.continuePiSession(owner(app), gone), /is not there/);
});

test("only the owner can list, look at, or continue Pi's sessions", async () => {
    const path = save(rich(), "owners");
    const server = createServer(
        createHandler({ app, listen: { host: "127.0.0.1", port: 0 }, restart: () => {} }),
    );

    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as { port: number }).port;
    const guest = app.config.addUser("Guest", "guest");
    const call = (token: string, route: string, body?: unknown) =>
        fetch(`http://127.0.0.1:${port}/api/pi-sessions${route}`, {
            method: body === undefined ? "GET" : "POST",
            headers: {
                authorization: `Bearer ${token}`,
                "x-pocket": "1",
                "content-type": "application/json",
            },
            ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        });
    const preview = `/preview?path=${encodeURIComponent(path)}`;

    try {
        assert.equal((await call(guest.token, "")).status, 403);
        assert.equal((await call(guest.token, preview)).status, 403);
        assert.equal((await call(guest.token, "/continue", { path })).status, 403);
        assert.equal((await call(app.config.ownerToken, "/continue", {})).status, 400);
        assert.equal((await call(app.config.ownerToken, "")).status, 200);
        assert.equal((await call(app.config.ownerToken, preview)).status, 200);
        const made = await call(app.config.ownerToken, "/continue", { path });

        assert.equal(made.status, 200);
        const { id } = (await made.json()) as { id: ConversationId };

        assert.equal(app.sessionMeta(id)?.title, "Fix the checkout total");
    } finally {
        server.closeAllConnections();
        server.close();
        app.config.removeUser(guest.user.id);
    }
});

test("reading a session is Pi's own: a branch, an edit, and a compaction keep their places", () => {
    const manager = rich();
    const read = readPiSession(
        [manager.getHeader(), ...manager.getEntries()]
            .map((each) => JSON.stringify(each))
            .join("\n"),
    );
    const compaction = read.entries.find((entry) => entry.kind === "compaction");

    assert.equal(read.title, "Fix the checkout total");
    assert.deepEqual(read.model, { provider: "faux", modelId: "faux-2" });
    assert.ok(compaction?.kind === "compaction" && compaction.head !== null);
    assert.equal(read.edits.length, 2);
    assert.deepEqual(
        read.edits.map((edit) => edit.messages.length),
        [1, 0],
    );
    // The branch left behind is not in it, only its summary.
    assert.doesNotMatch(JSON.stringify(read.entries), /That will not help/);
    assert.match(JSON.stringify(read.entries), /Tried doubles; it did not help/);
});

test("two compactions, the second keeping messages from before the first: Pi's context still", async () => {
    const manager = SessionManager.inMemory(work);

    manager.appendMessage({ role: "user", content: "one", timestamp: 1 });
    manager.appendMessage(fauxAssistantMessage([fauxText("reply one")]));
    const keptByBoth = manager.appendMessage({ role: "user", content: "two", timestamp: 2 });

    manager.appendMessage(fauxAssistantMessage([fauxText("reply two")]));
    manager.appendCompaction("First summary.", keptByBoth, 1000);
    manager.appendMessage({ role: "user", content: "three", timestamp: 3 });
    const keptBySecond = manager.appendMessage(fauxAssistantMessage([fauxText("reply three")]));

    manager.appendCompaction("Second summary.", keptBySecond, 2000);
    manager.appendMessage({ role: "user", content: "four", timestamp: 4 });
    const path = save(manager, "two-compactions");
    const { id } = await app.commands.continuePiSession(owner(app), path);

    assert.deepEqual(await pocketContext(id), piContext(path));
    assert.match(JSON.stringify(await pocketContext(id)), /Second summary/);
    assert.doesNotMatch(JSON.stringify(await pocketContext(id)), /First summary/);
});

test("a file whose entries lead in a circle says it is damaged, at once", () => {
    const manager = SessionManager.inMemory(work);

    manager.appendMessage({ role: "user", content: "one", timestamp: 1 });
    manager.appendMessage(fauxAssistantMessage([fauxText("reply one")]));
    const [header, first, second] = [manager.getHeader(), ...manager.getEntries()];
    // The first entry's parent made the second, as a damaged or hand-edited file might have it.
    const circle = [header, { ...first, parentId: second!.id }, second].map((entry) =>
        JSON.stringify(entry),
    );

    assert.throws(() => readPiSession(circle.join("\n")), PiSessionError);
    assert.throws(() => readPiSession(circle.join("\n")), /damaged/);
});

test("a long session with many compactions reads in time that grows with its length", () => {
    // Written as Pi writes it, line by line (building it through Pi's session manager takes far longer than reading).
    const at = "2026-10-09T10:00:00.000Z";

    const file = (count: number) => {
        const lines = [
            JSON.stringify({ type: "session", version: 3, id: "many", timestamp: at, cwd: work }),
            JSON.stringify({
                type: "message",
                id: "start",
                parentId: null,
                timestamp: at,
                message: { role: "user", content: "the start", timestamp: 1 },
            }),
        ];

        // Compaction after compaction, each keeping from the one before: the slowest kind of file to find what each
        // keeps in by looking back through the branch, as reading once did.
        for (let index = 0; index < count; index++) {
            const before = index === 0 ? "start" : `c${index - 1}`;

            lines.push(
                JSON.stringify({
                    type: "compaction",
                    id: `c${index}`,
                    parentId: before,
                    timestamp: at,
                    summary: `Summary ${index}.`,
                    firstKeptEntryId: before,
                    tokensBefore: 1000,
                }),
            );
        }

        return lines.join("\n");
    };

    // The fastest of three reads: what the machine is doing besides weighs on each alike.
    const time = (text: string) =>
        Math.min(
            ...[0, 1, 2].map(() => {
                const started = performance.now();

                readPiSession(text);

                return performance.now() - started;
            }),
        );
    const small = file(10_000);
    const large = file(40_000);

    assert.equal(
        readPiSession(large).entries.filter((entry) => entry.kind === "compaction").length,
        40_000,
    );
    // Four times the compactions, about four times the time: it was about sixteen, with the server waiting on it.
    const ratio = time(large) / time(small);

    assert.ok(ratio < 8, `4x the compactions took ${ratio.toFixed(1)}x the time`);
});

test("a message without content, as old or edited files have, reads; its session is named by what it can", async () => {
    const manager = SessionManager.inMemory(work);

    manager.appendMessage({ role: "user", content: "the first words", timestamp: 1 });
    manager.appendMessage(fauxAssistantMessage([fauxText("answer")]));
    const lines = [manager.getHeader(), ...manager.getEntries()].map((entry) =>
        JSON.stringify(entry),
    );
    // Content taken out of both, as a file edited by hand might be.
    const broken = lines.map((line) =>
        line
            .replace('"content":"the first words"', '"content":null')
            .replace(/"content":\[[^\]]*\]/, '"content":null'),
    );

    const read = readPiSession(broken.join("\n"));

    assert.equal(read.title, "Pi session");
    assert.equal(read.entries.length, 2);
});

test("a tool result without its call: Pi would send it, providers refuse it, Pi Pocket leaves it out", async () => {
    const manager = SessionManager.inMemory(work);

    manager.appendMessage({ role: "user", content: "look", timestamp: 1 });
    manager.appendMessage({
        role: "toolResult",
        toolCallId: "nowhere",
        toolName: "read",
        content: [{ type: "text", text: "a stray result" }],
        isError: false,
        timestamp: 2,
    });
    manager.appendMessage(fauxAssistantMessage([fauxText("done")]));
    const path = save(manager, "stray");
    const { id } = await app.commands.continuePiSession(owner(app), path);
    const without = piContext(path).filter((message) => message.role !== "toolResult");

    assert.ok(piContext(path).some((message) => message.role === "toolResult"));
    assert.deepEqual(await pocketContext(id), without);
});

test("a search looks through every session's title, folder, and words, before the list's limit", async () => {
    const manager = SessionManager.inMemory(work);

    manager.appendMessage({
        role: "user",
        content: "Where is the flux capacitor wired?",
        timestamp: 1,
    });
    manager.appendMessage(fauxAssistantMessage([fauxText("Behind the dashboard.")]));
    const path = save(manager, "searchable");
    const found = async (query: string) =>
        (await app.piSessions.list(owner(app), query)).sessions.map((each) => each.path);

    assert.ok((await found("dashboard")).includes(path), "by the words of an answer");
    assert.ok((await found("FLUX")).includes(path), "whatever the case");
    assert.deepEqual(await found("nothing says this anywhere"), []);
});

test("people see the session file's name, not the folder it is in", async () => {
    const { id } = await app.commands.continuePiSession(owner(app), save(rich(), "named"));
    const entries = await shown(id);
    const marker = entries.find((entry) => entry.kind === "pocket.from-pi")!;

    assert.match(String((marker.data as { file?: unknown }).file), /\/named\.jsonl$/, "kept whole");
    assert.deepEqual(projectEntry(marker), {
        id: marker.id,
        kind: "fromPi",
        title: "Fix the checkout total",
        file: "named.jsonl",
    });
});
