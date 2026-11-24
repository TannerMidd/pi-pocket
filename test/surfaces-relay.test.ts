// Surfaces in a chat and on a phone (slice 2): the relay sends a card as numbered text and reads a reply such as `1`,
// `3` or `2: text` as an action, only from people the card allows; and a card Pi waits for is pushed by its title.
import {
    type App,
    cleanUp,
    context,
    fakeTab,
    lastText,
    loadTools,
    newSession,
    openApp,
    owner,
    root,
    scriptedModel,
    until,
} from "./helpers.ts";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import type { ConversationId } from "@earendil-works/pi-durable";
import { SurfacesDoc } from "../src/server/docs.ts";
import type { Client } from "../src/server/room.ts";
import type { EmbedderMessage } from "../src/server/push.ts";
import { createHandler } from "../src/server/http.ts";
import { prepareRelay, recordSent } from "../src/server/surfaces/relay.ts";

const dataDir = join(root, "data");
const card = {
    action: "show",
    title: "Ship it?",
    data: { agree: false, pub: false, note: "" },
    components: [
        {
            type: "Column",
            children: [
                { type: "CheckBox", id: "agree", label: "Agree", bind: "/agree" },
                { type: "CheckBox", id: "pub", label: "Public", bind: "/pub", who: "anyone" },
                { type: "TextField", id: "note", label: "Note", bind: "/note", who: "anyone" },
                {
                    type: "Button",
                    id: "go",
                    label: "Go",
                    action: { event: { name: "go", context: { agree: { "@path": "/agree" } } } },
                },
            ],
        },
    ],
};
let firstReference: string;
const model = scriptedModel((request) => {
    const { role, text } = lastText(request as never);

    const shown = /^Surface (s\d+) shown/.exec(text);

    if (role === "toolResult" && shown !== null) {
        return fauxAssistantMessage(
            [
                fauxToolCall("relay_reply", {
                    text: "",
                    surface: shown[1],
                    reply_to: firstReference,
                } as never),
            ],
            { stopReason: "toolUse" },
        );
    }

    if (role === "toolResult") {
        return fauxAssistantMessage([fauxText(`done: ${text}`)]);
    }

    if (text.includes("show the waiting card")) {
        return fauxAssistantMessage([fauxToolCall("ui", { ...card, wait: true } as never)], {
            stopReason: "toolUse",
        });
    }

    return text.includes("show the card")
        ? fauxAssistantMessage([fauxToolCall("ui", card as never)], { stopReason: "toolUse" })
        : fauxAssistantMessage([fauxText(`echo: ${text}`)]);
});
let app: App;
let server: Server;
let session: ConversationId;
let base = "";

type Mock = {
    push: (events: unknown[]) => void;
    sent: { text: string; channel?: string }[];
    holdNext?: () => Promise<void>;
};
const mock = () => (globalThis as { relayMock?: Mock }).relayMock!;

before(async () => {
    mkdirSync(join(dataDir, "extensions"), { recursive: true });
    writeFileSync(
        join(dataDir, "extensions", "mock-relay.ts"),
        `/** Mock relay: a connector for tests. */
export default (_host, web) => {
    const queue = [];
    let wake = () => {};
    let stop = () => {};
    const sent = [];
    globalThis.relayMock = { sent, push: (events) => { queue.push(events); wake(); } };
    globalThis.relayService = web.use("pocket-relay");
    const connector = {
        kind: "mock",
        authenticatedAuthors: true,
        label: "Mock",
        shape: "stream",
        fields: [{ name: "token", label: "Token", type: "secret", required: true }],
        run: async (context) => {
            while (!context.signal.aborted) {
                const next = queue.shift();
                if (next === undefined) {
                    await new Promise((resolve) => { wake = resolve; context.signal.addEventListener("abort", resolve, { once: true }); });
                    continue;
                }
                await context.emit(next);
            }
        },
        reply: async (_context, reply) => {
            sent.push({ text: reply.text, channel: reply.channel });
            const id = "m" + sent.length;
            const hold = globalThis.relayMock.holdNext;
            delete globalThis.relayMock.holdNext;
            await hold?.();
            return { id, channel: reply.channel, thread: reply.thread };
        },
    };
    const add = () => { stop(); stop = web.use("pocket-relay")?.register(connector) ?? (() => {}); };
    add();
    web.onService("pocket-relay", add);
    web.onDispose(() => stop());
};
`,
    );
    app = await openApp(model, dataDir);
    server = createServer(
        createHandler({ app, listen: { host: "127.0.0.1", port: 0 }, restart: () => {} }),
    );
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    session = await newSession(app);
    await loadTools(app, session, "ui");
    await app.setExtensionEnabled(owner(app), "pocket-relay.ts", true);
    await app.setExtensionEnabled(owner(app), "mock-relay.ts", true);
});

after(async () => {
    server.closeAllConnections();
    server.close();
    await app.close();
    cleanUp();
});

const surfaces = async () =>
    Object.values((await app.harness.snapshot(SurfacesDoc, session, context))?.items ?? {});
const surface = async () => (await surfaces())[0];

const event = (id: string, author: string, text: string, more: object = {}) => ({
    id,
    text,
    author: { id: author, name: author },
    channel: "room-1",
    ...more,
});

async function userTexts(): Promise<string[]> {
    const view = await (await app.harness.conversation(session, context))!.context(context);

    return view.messages
        .filter((message) => message.role === "user")
        .map((message) => JSON.stringify(message.content));
}

test("a card goes to the chat as numbered text, and replies act on it for the people it allows", async () => {
    const added = await fetch(`${base}/api/x/pocket-relay/connectors`, {
        method: "POST",
        headers: {
            authorization: `Bearer ${app.config.ownerToken}`,
            "x-pocket": "1",
            "content-type": "application/json",
        },
        body: JSON.stringify({
            name: "Chat",
            kind: "mock",
            target: session,
            ownerIds: ["owner-1"],
            values: { token: "a-token-for-the-mock" },
        }),
    });

    assert.equal(added.status, 200);
    mock().push([event("e1", "owner-1", "hello there")]);
    await until(async () => (await userTexts()).length === 1, "the first message");

    const reference = /event: (e-[A-Za-z0-9_-]+)/.exec((await userTexts())[0]!)?.[1];

    assert.ok(reference, "the delivered message has an opaque event reference");
    firstReference = reference;

    // Pi shows the card, then sends it to the chat the message came from.
    await app.commands.submit(session, owner(app), { text: "show the card", requestId: "card-1" });
    await until(() => mock().sent.length === 1, "the card in the chat");

    const sent = mock().sent[0]!;

    assert.equal(sent.channel, "room-1");
    assert.match(
        sent.text,
        /^Ship it\? \(s1\)\. Reply with the card ID and number:\n1 \[ \] Agree\n2 \[ \] Public\n3 Note: \(empty\)\n4 Go\nReply "s1 1" to toggle Agree, "s1 4" to press Go, "s1 3: your text" to fill Note\.$/,
    );
    // The message id is stored once the send returns, a moment after the chat has the text.
    await until(async () => (await surface())!.relay?.msgId === "m1", "the card's message id");

    const before = (await userTexts()).length;

    // The owner's own account toggles and presses: handled, confirmed in the chat, never sent to Pi.
    mock().push([event("e2", "owner-1", "1", { replyTo: "m1" })]);
    await until(async () => (await surface())!.data.agree === true, "the toggle");
    await until(() => mock().sent.length === 2, "the confirmation");
    assert.match(mock().sent[1]!.text, /1 \[x\] Agree/);

    // The confirmation (m2) is a copy of the card: a reply to it acts on the card too, as one to the card's message.
    await until(
        async () =>
            (await surface())!.relay?.echoes?.some(
                (each) => typeof each !== "string" && each.id === "m2",
            ) === true,
        "the echo",
    );
    mock().push([event("e2b", "owner-1", "1", { replyTo: "m2" })]);
    await until(
        async () => (await surface())!.data.agree === false,
        "the toggle back, by the echo",
    );
    await until(() => mock().sent.length === 3, "the second confirmation");
    // Some services start a thread rooted at the message a person answers.
    mock().push([event("e2c", "owner-1", "1", { replyTo: "m3", thread: "m3" })]);
    await until(
        async () => (await surface())!.data.agree === true,
        "the toggle, by the second echo",
    );
    await until(() => mock().sent.length === 4, "the third confirmation");

    // A stranger may use only what says `anyone`: 2 and 3 yes, 1 and 4 no; the refusal goes to Pi as data too.
    mock().push([event("e3", "stranger", "2", { replyTo: "m1" })]);
    await until(async () => (await surface())!.data.pub === true, "the stranger's toggle");
    mock().push([event("e4", "stranger", "3: hi there", { replyTo: "m1" })]);
    await until(async () => (await surface())!.data.note === "hi there", "the stranger's text");
    mock().push([event("e5", "stranger", "1", { replyTo: "m1" })]);
    await until(
        () => mock().sent.some((each) => /That did not work on card s1\./.test(each.text)),
        "the refusal",
    );
    assert.equal((await surface())!.data.agree, true, "unchanged by a stranger");

    // A number the card does not have, and a message that is not an action at all.
    mock().push([event("e6", "owner-1", "9", { replyTo: "m1" })]);
    await until(
        () => mock().sent.some((each) => /There is no 9 on card s1/.test(each.text)),
        "no such number",
    );
    mock().push([event("e7", "owner-1", "thanks, looks good")]);
    await until(
        async () => (await userTexts()).some((text) => text.includes("looks good")),
        "normal data",
    );
    // A bare number that does not reply to the card's message is a message for Pi, never the card's.
    const agreed = (await surface())!.data.agree;

    mock().push([event("e7b", "owner-1", "1")]);
    await until(
        async () =>
            (await userTexts()).slice(before).filter((text) => text.includes("<relay-message"))
                .length === 4,
        "the bare number reaching Pi",
    );
    assert.equal((await surface())!.data.agree, agreed, "a bare number leaves the card alone");

    const fresh = (await userTexts()).slice(before);

    assert.equal(fresh.join("\n").includes("hi there"), false, "a handled reply never reaches Pi");
    assert.equal(
        fresh.filter((text) => text.includes("<relay-message")).length,
        4,
        "only the refused, the unknown number, the plain message, and the bare number reach Pi",
    );

    // Go: the card is done, and the surface's action reaches the session once.
    mock().push([event("e8", "owner-1", "4", { replyTo: "m1" })]);
    await until(async () => (await surface())!.status === "done", "the card done");
    assert.match(mock().sent.at(-1)!.text, /s1: Go pressed, and the card is done\./);
    await until(
        async () => (await userTexts()).some((text) => text.includes("[via surface s1]")),
        "the action's message",
    );
});

test("the relay's own echo of a card goes through the outbound screen", async () => {
    // The first test's card is done: send a new one to the same chat.
    await app.commands.submit(session, owner(app), { text: "show the card", requestId: "card-3" });
    await until(async () => Object.keys(await surfaces()).length === 2, "the second card");

    await until(
        async () => (await surfaces()).find((card) => card.id === "s2")?.relay?.msgId !== undefined,
        "the second card delivered",
    );

    const holds: string[] = [];
    const stop = (
        globalThis as { relayService?: { outbound: (hook: never) => () => void } }
    ).relayService!.outbound(((event: { text: string }) => {
        holds.push(event.text);

        return "block";
    }) as never);
    const sent = mock().sent.length;

    try {
        mock().push([event("e30", "owner-1", "s2 1")]);
        await until(
            async () => (await surfaces()).find((each) => each.id === "s2")!.data.agree === true,
            "the toggle",
        );
        await until(() => holds.length === 1, "the screen reading the echo");
        assert.match(holds[0]!, /Agree/);
        assert.equal(mock().sent.length, sent, "a blocked echo is not sent");
    } finally {
        stop();
    }

    mock().push([event("e31", "owner-1", "s2 1")]);
    await until(() => mock().sent.length === sent + 1, "the echo with no screen");
});

test("a delayed echo cannot become a reply target after Pi sends the card again", async () => {
    const second = (await surfaces()).find((each) => each.id === "s2")!;
    const sent = mock().sent.length;
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
        release = resolve;
    });

    mock().holdNext = () => held;
    mock().push([event("e40", "owner-1", "s2 1")]);

    try {
        await until(() => mock().sent.length === sent + 1, "the echo waiting at the service");
        const active = second.relay!;
        const prepared = await prepareRelay(app, session, second.id, {
            connector: active.connector,
            routeRevision: active.routeRevision!,
            channel: "room-1",
        });

        await recordSent(
            app,
            session,
            second.id,
            prepared,
            { id: "resent", channel: "room-1" },
            () => true,
        );
    } finally {
        release();
    }

    mock().push([event("e41", "owner-1", "s2 1")]);
    await until(
        async () =>
            (await surfaces()).find((each) => each.id === "s2")!.relay?.echoes?.length === 1,
        "the newer echo recorded",
    );

    const relay = (await surfaces()).find((each) => each.id === "s2")!.relay!;

    assert.deepEqual(
        relay.echoes?.map((each) => (typeof each === "string" ? each : each.id)),
        [`m${sent + 2}`],
    );
    const before = (await userTexts()).filter((text) => text.includes("<relay-message")).length;

    mock().push([event("e42", "owner-1", "1", { replyTo: `m${sent + 1}` })]);
    await until(
        async () =>
            (await userTexts()).filter((text) => text.includes("<relay-message")).length > before,
        "the old echo reply reaching Pi",
    );
    assert.equal(
        (await surfaces()).find((each) => each.id === "s2")!.data.agree,
        second.data.agree,
    );
});

test("a card Pi waits for is pushed to the person who can act, by its title only", async () => {
    const id = await newSession(app);

    await loadTools(app, id, "ui");

    const tab = fakeTab(id, owner(app));
    const client: Client = { ...tab.client, embedder: "embedder-notify" };

    await app.attach(client);
    app.setVisible(owner(app), client.id, false);

    try {
        await app.commands.submit(id, owner(app), {
            text: "show the waiting card",
            requestId: "card-2",
        });
        await until(
            () => tab.events.some((each) => each.event === "embedder-notify"),
            "the notification",
            10_000,
        );

        const sent = tab.events
            .filter((each) => each.event === "embedder-notify")
            .map((each) => each.data as unknown as EmbedderMessage);
        const message = sent.find((each) => each.tag?.startsWith("surface-"));

        assert.ok(message, JSON.stringify(sent));
        assert.match(message.title, /^Pi needs you · /);
        assert.equal(message.body, "Ship it?");
        assert.equal(message.url, `/s/${String(id)}`);
        assert.equal(message.urgency, "high");
    } finally {
        app.detach(client);
    }
});
