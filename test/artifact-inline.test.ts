// The artifact_inline tool (#87): HTML published into the artifact store as a card in the reply. Each result records the
// version its call made, so an earlier card keeps its version after an update; the store is the artifact tool's, so
// versions, edits, limits, replays, forks, and who may read a page all work as they do for it.
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
    work,
} from "./helpers.ts";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import type { ConversationId } from "@earendil-works/pi-durable";
import createArtifacts, { slugify } from "../src/server/extensions/artifacts.ts";
import type { PocketHost } from "../src/server/host.ts";
import { createHandler } from "../src/server/http.ts";
import { withBridge } from "../src/server/http/artifacts.ts";

const PAGE = `<!doctype html><html><body><h1>Loan</h1><input id="rate" value="4"></body></html>`;

let app: App;
let server: Server;
let port = 0;
let calls = 0;

const route: Parameters<typeof scriptedModel>[0] = (context) => {
    const { role, text } = lastText(context as never);
    const call = (name: string, args: Parameters<typeof fauxToolCall>[1]) =>
        fauxAssistantMessage([fauxToolCall(name, args)], { stopReason: "toolUse" });

    if (role === "toolResult") {
        return fauxAssistantMessage([fauxText(`tool said: ${text}`)]);
    }

    if (text.includes("show a calculator")) {
        return call("artifact_inline", { id: "Loan Calc", title: "Loan", content: PAGE });
    }

    if (text.includes("add a years field")) {
        return call("artifact_inline", {
            id: "loan-calc",
            title: "Loan with years",
            edits: [{ oldText: "</body>", newText: '<input id="years" value="30"></body>' }],
        });
    }

    if (text.includes("show notes inline")) {
        return call("artifact_inline", { id: "notes", title: "Notes", content: "<p>no</p>" });
    }

    if (text.includes("publish notes")) {
        return call("artifact", {
            id: "notes",
            title: "Notes",
            type: "markdown",
            content: "# Notes",
        });
    }

    return fauxAssistantMessage([fauxText(`echo: ${text}`)]);
};

before(async () => {
    app = await openApp(scriptedModel(route));
    server = createServer(
        createHandler({ app, listen: { host: "127.0.0.1", port: 0 }, restart: () => {} }),
    );
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    port = (server.address() as { port: number }).port;
});

after(async () => {
    server.closeAllConnections();
    server.close();
    await app.close();
    cleanUp();
});

/** What each artifact_inline result in the session recorded, oldest first. */
async function results(id: ConversationId) {
    const entries = await app.transcripts.allEntries(id, false);

    return entries.flatMap((entry) =>
        entry.kind === "toolResult" && (entry as { name?: string }).name === "artifact_inline"
            ? [entry as unknown as { isError?: boolean; details?: Record<string, unknown> }]
            : [],
    );
}

/** The page as a person with `token` gets it in a tab of its own (with no bridge), or none. */
async function page(token: string | undefined, id: ConversationId, path: string) {
    const response = await fetch(`http://127.0.0.1:${port}/a/${id}/${path}`, {
        headers: {
            "sec-fetch-dest": "document",
            ...(token === undefined ? {} : { authorization: `Bearer ${token}` }),
        },
    });

    return { status: response.status, text: await response.text() };
}

/** A direct call of the second tool, as Pi Durable makes it, with a fixed identity so it can be replayed. */
function inlineCall(id: ConversationId, taskId: number, callId: string) {
    const tool = createArtifacts({} as PocketHost).tools!.find(
        (each) => each.name === "artifact_inline",
    )!;

    return (args: Record<string, unknown>) =>
        tool.execute(
            { id: "loan-calc", title: "Loan", ...args } as never,
            {
                conversationId: id,
                taskId,
                callId,
                agent: async () => ({ cwd: work }),
                snapshot: app.harness.snapshot.bind(app.harness),
                commit: app.harness.commit.bind(app.harness),
            } as never,
            context,
        );
}

test("the module has both tools, and the guide says when to use each", async () => {
    const extension = createArtifacts({} as PocketHost);
    const section = extension.sections![0]!;

    assert.deepEqual(
        extension.tools!.map((tool) => tool.name),
        ["artifact", "artifact_inline"],
    );
    const render = (names: string[]) =>
        (section.render as (input: unknown) => Promise<string>)({
            agent: { tools: names.map((name) => ({ name })) },
        });

    const withBoth = await render(["artifact", "artifact_inline"]);

    assert.match(withBoth, /artifact_inline shows the page as a card in your reply/);
    assert.match(withBoth, /only a call you make directly shows a card/i);
    assert.match(withBoth, /schema, optional, is a string such as "v1"/);
    assert.match(withBoth, /focus alone does not count/);
    // A session without the tool (PiP's) is not told about it.
    const without = await render(["artifact"]);

    assert.doesNotMatch(without, /artifact_inline/);
    assert.match(without, /Use the artifact tool/);
});

test("a call creates an artifact and says which version it made; an update leaves the earlier result alone", async () => {
    const id = await newSession(app);

    await say(app, id, "show a calculator");
    await say(app, id, "add a years field");

    const [first, second] = await results(id);

    assert.deepEqual(first!.details, { id: "loan-calc", title: "Loan", version: 1, inline: true });
    assert.deepEqual(second!.details, {
        id: "loan-calc",
        title: "Loan with years",
        version: 2,
        inline: true,
    });
    assert.equal((await app.artifactBody(id, "loan-calc", 1)).content, PAGE);
    assert.match((await app.artifactBody(id, "loan-calc", 2)).content, /id="years"/);
    assert.equal((await app.artifactBody(id, "loan-calc", undefined)).version, 2);
    assert.equal(
        first!.details!.version,
        1,
        "the first result still names version 1 after the update",
    );
});

test("it shares the artifact tool's store: the page is served, and a Markdown artifact stays out of it", async () => {
    const id = await newSession(app);
    const me = app.config.ownerToken;

    await say(app, id, "publish notes");
    await say(app, id, "show a calculator");
    await say(app, id, "show notes inline");

    const done = await results(id);

    assert.equal(done[0]!.isError, false);
    assert.equal(done[1]!.isError, true, "an inline call cannot turn a Markdown artifact to HTML");
    assert.equal((await page(me, id, "loan-calc/1")).text, PAGE);
    assert.equal((await app.artifactBody(id, "notes", undefined)).content, "# Notes");
    assert.equal(slugify("Loan Calc"), "loan-calc");
});

test("a frame's page starts with the bridge's script, after the doctype; a tab's or a fetch's is as written", async () => {
    // With no Sec-Fetch-Dest (an older browser, a proxy that drops it), the bridge goes in too.
    const id = await newSession(app);

    await inlineCall(id, 850_000 + (calls += 1), "bridge")({ content: PAGE });
    const me = app.config.ownerToken;
    const get = async (dest?: string) =>
        (
            await fetch(`http://127.0.0.1:${port}/a/${id}/loan-calc/1`, {
                headers: {
                    authorization: `Bearer ${me}`,
                    ...(dest ? { "sec-fetch-dest": dest } : {}),
                },
            })
        ).text();

    assert.equal(await get("document"), PAGE);
    assert.equal(await get("empty"), PAGE);
    const framed = await get("iframe");

    assert.equal(await get(), framed, "no header: the bridge too");

    assert.ok(framed.startsWith("<!doctype html><script>"), "after the doctype: no quirks mode");
    assert.ok(
        framed.endsWith(PAGE.slice("<!doctype html>".length)),
        "the page follows, as written",
    );
    assert.match(framed, /structuredClone/);

    // Before a doctype only white space and a byte order mark are skipped: the bridge comes before any comment, odd
    // ones too, which a browser can end where a pattern would not (`<!-->` is a whole comment), and before any other
    // white space (a no-break space is text to a browser).
    const tag = framed.slice(
        "<!doctype html>".length,
        framed.indexOf("</script>") + "</script>".length,
    );

    for (const page of [
        "<!--><script>early()</script><!-- -->",
        "<!---><script>early()</script>-->",
        "<!-- a --><!doctype html><script>early()</script>",
        "\u00a0<!doctype html><script>early()</script>",
    ]) {
        assert.equal(withBridge(page), tag + page, JSON.stringify(page));
    }

    assert.equal(
        withBridge("\uFEFF \n<!DOCTYPE html><p>"),
        "\uFEFF \n<!DOCTYPE html>" + tag + "<p>",
    );
});

test("a replayed call finds its version; another call of the same task makes the next one", async () => {
    const id = await newSession(app);
    const call = inlineCall(id, 810_000 + (calls += 1), "one");

    const first = await call({ content: PAGE });
    const again = await call({ content: "<p>different</p>" });

    assert.deepEqual(first.details, { id: "loan-calc", title: "Loan", version: 1, inline: true });
    assert.equal(again.details && (again.details as { version: number }).version, 1);
    assert.equal((await app.artifactBody(id, "loan-calc", undefined)).version, 1);
    assert.equal((await app.artifactBody(id, "loan-calc", 1)).content, PAGE, "not written twice");

    // A script (codemode) makes several calls in one task.
    const task = 820_000 + (calls += 1);
    const one = await inlineCall(id, task, "a")({ content: "<p>a</p>" });
    const two = await inlineCall(id, task, "b")({ content: "<p>b</p>" });

    assert.deepEqual(
        [one, two].map((each) => (each.details as { version: number }).version),
        [2, 3],
    );
});

test("it takes content or nonempty edits, not both, not a path, and keeps the size limit", async () => {
    const id = await newSession(app);
    const call = (args: Record<string, unknown>) =>
        inlineCall(id, 830_000 + (calls += 1), "x")(args);

    await assert.rejects(call({}), /exactly one of/);
    await assert.rejects(
        call({ content: PAGE, edits: [{ oldText: "a", newText: "b" }] }),
        (error: Error) => {
            // It has no path: the message must not name one.
            assert.equal(error.message, "Give exactly one of content or nonempty edits.");

            return true;
        },
    );
    await assert.rejects(call({ edits: [] }), /exactly one/);
    await assert.rejects(
        call({ edits: [{ oldText: "a", newText: "b" }] }),
        /no artifact loan-calc to edit/,
    );
    // The model may send a path or a type anyway: they are the artifact tool's, and change nothing here.
    await assert.rejects(call({ path: "page.md" }), /exactly one of/);
    await assert.rejects(call({ type: "markdown" }), /exactly one of/);
    await assert.rejects(call({ content: "x".repeat(2_000_001) }), /limited to/);
    await call({ content: PAGE });
    await assert.rejects(call({ edits: [{ oldText: "absent", newText: "b" }] }), /not found/);
});

test("the result says a card shows only for a direct call, not for one inside codemode", async () => {
    const id = await newSession(app);
    const direct = await inlineCall(id, 840_000 + (calls += 1), "call_direct")({ content: PAGE });
    const nested = await inlineCall(
        id,
        840_000 + (calls += 1),
        "call_script/1",
    )({ content: PAGE, id: "from-script" });
    const text = (result: typeof direct) => (result.output![0] as { text: string }).text;

    assert.match(text(direct), /It shows as a card in your reply/);
    assert.match(text(nested), /does not show as a card here/);
    assert.doesNotMatch(text(nested), /It shows as a card/);
});

test("a fork keeps every version its cards name, and an update there leaves the original alone", async () => {
    const id = await newSession(app);

    await say(app, id, "show a calculator");
    await say(app, id, "add a years field");
    const last = (await app.transcripts.allEntries(id, false)).at(-1)!;
    const fork = await app.commands.fork(id, owner(app), { entryId: last.id });
    const me = app.config.ownerToken;

    assert.equal((await page(me, fork.id, "loan-calc/1")).text, PAGE);
    assert.match((await page(me, fork.id, "loan-calc/2")).text, /id="years"/);
    await inlineCall(fork.id, 840_000 + (calls += 1), "fork")({ content: "<p>fork</p>" });
    assert.equal((await page(me, fork.id, "loan-calc/3")).text, "<p>fork</p>");
    assert.equal((await page(me, id, "loan-calc/3")).status, 404, "the original has no version 3");
    assert.equal((await results(fork.id)).length, 2, "the fork has the same cards");
});

test("who may read a card's page: people who see the session, a viewer too, not another session's guest", async () => {
    const id = await newSession(app);
    const other = await newSession(app);

    await say(app, id, "show a calculator");

    const invited = app.config.addUser("Ivy", "guest", [String(id)]);
    const viewer = app.config.addUser("Vee", "viewer");
    const elsewhere = app.config.addUser("Sam", "guest", [String(other)]);

    try {
        assert.equal((await page(invited.token, id, "loan-calc/1")).text, PAGE, "an invite to it");
        assert.equal((await page(viewer.token, id, "loan-calc/1")).text, PAGE, "a viewer");
        assert.notEqual((await page(elsewhere.token, id, "loan-calc/1")).status, 200);
        assert.equal((await page(undefined, id, "loan-calc/1")).status, 401);
    } finally {
        for (const added of [invited, viewer, elsewhere]) {
            app.config.removeUser(added.user.id);
        }
    }
});

test("cards and versions survive closing and reopening the storage", async () => {
    const dataDir = join(root, "restart-data");
    const model = scriptedModel(route);
    const first = await openApp(model, dataDir);
    const id = await newSession(first);

    await say(first, id, "show a calculator");
    await say(first, id, "add a years field");
    await first.close();

    const second = await openApp(model, dataDir);

    try {
        const entries = await second.transcripts.allEntries(id, false);
        const versions = entries
            .filter((entry) => (entry as { name?: string }).name === "artifact_inline")
            .map((entry) => (entry as unknown as { details: { version: number } }).details.version);

        assert.deepEqual(versions, [1, 2]);
        assert.equal((await second.artifactBody(id, "loan-calc", 1)).content, PAGE);
        assert.equal((await second.artifactBody(id, "loan-calc", undefined)).version, 2);
    } finally {
        await second.close();
    }
});

test("an artifact with inline versions stays HTML, so an old card keeps showing its page", async () => {
    const id = await newSession(app);
    const task = 860_000 + (calls += 1);
    const me = app.config.ownerToken;
    const first = await inlineCall(id, task, "card")({ content: PAGE });
    const artifact = createArtifacts({} as PocketHost).tools![0]!;
    const direct = (taskId: number, args: Record<string, unknown>) =>
        artifact.execute(
            { id: "loan-calc", title: "Loan", ...args } as never,
            {
                conversationId: id,
                taskId,
                callId: "direct",
                agent: async () => ({ cwd: work }),
                snapshot: app.harness.snapshot.bind(app.harness),
                commit: app.harness.commit.bind(app.harness),
            } as never,
            context,
        );

    assert.match(
        (first.output as unknown as { text: string }[])[0]!.text,
        /It shows as a card in your reply, and keeps showing version 1/,
    );
    await assert.rejects(
        direct(task + 1, { type: "markdown", content: "# no" }),
        /stays HTML: publish the markdown under a new id/,
    );
    // The same type, and a later HTML version by the artifact tool, are fine.
    await direct(task + 2, { content: "<p>two</p>" });
    assert.equal((await page(me, id, "loan-calc/1")).text, PAGE);
    assert.equal((await page(me, id, "loan-calc/2")).text, "<p>two</p>");
    // An artifact made by the artifact tool alone may still change type, as before.
    await direct(task + 3, { id: "other", type: "html", content: "<p>x</p>" });
    await artifact.execute(
        { id: "other", title: "Other", type: "markdown", content: "# md" } as never,
        {
            conversationId: id,
            taskId: task + 4,
            callId: "direct",
            agent: async () => ({ cwd: work }),
            snapshot: app.harness.snapshot.bind(app.harness),
            commit: app.harness.commit.bind(app.harness),
        } as never,
        context,
    );
    assert.equal((await app.artifactBody(id, "other", undefined)).meta.type, "markdown");
});

test("one tap serves one follow-up: no other event of the same tap gives it back", async () => {
    const html = withBridge("");
    const body = html.slice(
        html.indexOf("<script>(() => {") + 16,
        html.lastIndexOf("})();</script>"),
    );
    const heard: string[] = [];
    // The channels it opens, to close after: an open port keeps the test running.
    const channels: MessageChannel[] = [];
    const Channel = class extends MessageChannel {
        constructor() {
            super();
            channels.push(this);
        }
    };
    const listeners = new Map<string, ((event: unknown) => void)[]>();
    const parent = {
        postMessage: (_message: unknown, _origin: string, ports?: MessagePort[]) => {
            if (ports?.[0]) {
                ports[0].onmessage = (event) => heard.push(event.data.text);
            }
        },
    };
    const window = {
        parent,
        addEventListener: (type: string, listener: (event: unknown) => void) =>
            listeners.set(type, [...(listeners.get(type) ?? []), listener]),
        dispatchEvent: () => true,
        setTimeout,
    };

    new Function(
        "window",
        "self",
        "location",
        "performance",
        "structuredClone",
        "MessageEvent",
        "MessageChannel",
        body,
    )(
        window,
        { origin: "null" },
        { origin: "null" },
        performance,
        structuredClone,
        class {},
        Channel,
    );

    const fire = (type: string, fields: object = {}) => {
        for (const listener of listeners.get(type) ?? []) {
            listener({ isTrusted: true, key: "a", ...fields });
        }
    };

    const ask = (text: string) =>
        (window.parent as typeof parent).postMessage({ type: "pocket-follow-up", text }, "*");

    // A mouse's click: the page spends the tap at its first event, then asks again after each later one.
    fire("pointerdown", { pointerType: "mouse" });
    ask("click");

    for (const type of ["mousedown", "pointerup", "mouseup", "click"]) {
        fire(type, { pointerType: "mouse" });
        ask(`after ${type}`);
    }

    // A finger's tap, the same.
    fire("pointerdown", { pointerType: "touch" });
    fire("touchstart");
    fire("pointerup", { pointerType: "touch" });
    ask("tap");

    for (const type of ["touchend", "mousedown", "mouseup", "click"]) {
        fire(type, { pointerType: "touch" });
        ask(`after ${type}`);
    }

    // A key held down: its repeats are not taps.
    fire("keydown");
    ask("key");
    fire("keydown", { repeat: true });
    ask("after a repeat");
    await new Promise((resolve) => setTimeout(resolve, 50));

    for (const channel of channels) {
        channel.port1.close();
        channel.port2.close();
    }

    assert.deepEqual(heard, ["click", "tap", "key"]);
});
