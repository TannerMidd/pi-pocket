// Auto-resume end to end: scripted models that fail as providers do, schedules that wait for the reset, and restarts
// with an advanced clock. No request goes to a provider, and nothing touches live data.
import {
    type App,
    cleanUp,
    context,
    lastText,
    modelTexts,
    newSession,
    openApp,
    owner,
    root,
    say,
    scriptedModel,
    until,
} from "./helpers.ts";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { join } from "node:path";
import { after, test } from "node:test";
import { fauxAssistantMessage, fauxText } from "@earendil-works/pi-ai/providers/faux";
import type { ConversationId } from "@earendil-works/pi-durable";
import type { User } from "../src/server/config.ts";
import { createHandler } from "../src/server/http.ts";
import { runningNow } from "../src/server/running.ts";

const CONTINUATION = "[usage reset]";
const ERRORS: Record<string, string> = {
    "limit me": "You have hit your ChatGPT usage limit (plus plan). Try again in ~30 min.",
    "crash me": "An unknown error occurred",
    "bill me":
        '429 {"error":{"type":"insufficient_quota","code":"insufficient_quota","message":"You exceeded your current quota"}}',
};

let serial = 0;

after(cleanUp);

type Scenario = {
    app: () => App;
    id: ConversationId;
    /** Close, move the clock on, and open the same data again. */
    restart: (minutes: number) => Promise<void>;
    /** How many continuations Pi got in the chat. */
    continuations: (target?: ConversationId) => Promise<number>;
    pending: (target?: ConversationId) => Promise<{ next: number; key?: string; runs: number }[]>;
    command: (args: string, user?: User, target?: ConversationId) => Promise<string>;
    /** Whether the model answers a continuation, or fails again with no reset time. */
    continuationFails: (fails: boolean) => void;
};

async function scenario(run: (state: Scenario) => Promise<void>) {
    const dataDir = join(root, `auto-resume-${++serial}`);
    let offset = 0;
    let fails = false;
    let recovering = 0;
    const model = scriptedModel((view) => {
        const { text } = lastText(view as never);
        const failure =
            Object.entries(ERRORS).find(([ending]) => text.endsWith(ending))?.[1] ??
            (text.includes(CONTINUATION) && fails ? ERRORS["crash me"] : undefined) ??
            (text.endsWith("retry then recover") && recovering++ === 0
                ? "429 Rate limit reached for requests"
                : undefined);

        return failure === undefined
            ? fauxAssistantMessage([
                  fauxText(text.includes(CONTINUATION) ? "continued" : `echo: ${text}`),
              ])
            : fauxAssistantMessage([], { stopReason: "error", errorMessage: failure });
    });
    const clock = () => Date.now() + offset;
    let app = await openApp(model, dataDir, clock);
    const id = await newSession(app);

    const state: Scenario = {
        app: () => app,
        id,
        restart: async (minutes) => {
            await app.close();
            offset += minutes * 60_000;
            app = await openApp(model, dataDir, clock);
        },
        continuations: async (target = id) => {
            const entries = await (await app.harness.conversation(target, context))!.entries(
                {},
                200,
                undefined,
                context,
            );

            return entries.items.filter(
                (entry) =>
                    entry.kind === "pi.user" && JSON.stringify(entry.model).includes(CONTINUATION),
            ).length;
        },
        pending: async (target = id) =>
            (await app.schedules.list(target)).filter((item) =>
                item.key?.startsWith("x.auto-resume:"),
            ),
        command: async (args, user = owner(app), target = id) => {
            const commandId = app.webs.commands().find((each) => each.name === "auto-resume")?.id;
            const result = await app.extensionCommands.run(target, user, {
                commandId,
                args,
                requestId: crypto.randomUUID(),
            });

            return JSON.stringify(result);
        },
        continuationFails: (value) => {
            fails = value;
        },
    };

    try {
        await run(state);
    } finally {
        await app.close();
    }
}

test("off by default: a limit leaves the chat stopped", async () => {
    await scenario(async ({ app, id, pending, restart, continuations }) => {
        await say(app(), id, "limit me");
        assert.deepEqual(await pending(), []);
        await restart(40);
        assert.equal(await continuations(), 0);
    });
});

test("a limit with a reset time continues once after it, as the person's work, and then stops", async () => {
    await scenario(async ({ app, id, pending, restart, continuations, command }) => {
        assert.match(await command("on"), /Auto-resume is on \(this chat\)/);
        await say(app(), id, "limit me");
        const [planned] = await pending();

        assert.ok(planned);
        // Thirty minutes and the grace, from the provider's words.
        assert.ok(planned.next >= app().now() + 30 * 60_000);
        assert.ok(planned.next <= app().now() + 32 * 60_000);
        assert.ok(
            (await runningNow(app(), owner(app()))).some((session) =>
                session.tasks.some((task) => task.label.includes(CONTINUATION)),
            ),
            "Running now lists the retry, with its Stop",
        );
        assert.match(await command(""), /next try at .* \(1 of 5\)/);

        await restart(32);
        await until(async () => (await continuations()) === 1, "the continuation");
        await until(
            async () => (await modelTexts(app(), id)).some((text) => text.includes("continued")),
            "Pi's answer to it",
        );
        await until(async () => (await pending()).length === 0, "the answer to end the retries");
        await restart(120);
        assert.equal(await continuations(), 1);
    });
});

test("no reset time: the owner's fixed delay, tried at most as many times as fit in five hours", async () => {
    await scenario(
        async ({ app, id, pending, restart, continuations, command, continuationFails }) => {
            await command("all on");
            await command("delay 300");
            continuationFails(true);
            await say(app(), id, "crash me");
            const [planned] = await pending();

            assert.ok(planned);
            assert.ok(planned.next >= app().now() + 299 * 60_000);
            assert.match(await command(""), /the app's default\).*\(1 of 1\).*after 5 h/);

            // The one try fails again with no reset time: it gives up.
            await restart(301);
            await until(async () => (await continuations()) === 1, "the one try");
            await until(async () => (await pending()).length === 0, "auto-resume to give up");
            await restart(301);
            assert.equal(await continuations(), 1);
        },
    );
});

test("a failed try keeps the same retry going, and counts it", async () => {
    await scenario(
        async ({ app, id, pending, restart, continuations, command, continuationFails }) => {
            await command("on");
            await command("delay 1h");
            continuationFails(true);
            await say(app(), id, "crash me");
            assert.match(await command(""), /\(1 of 5\)/);
            await restart(61);
            await until(async () => (await continuations()) === 1, "the first try");
            await until(async () => (await pending())[0]?.runs === 1, "the try to count");
            assert.match(await command(""), /\(2 of 5\)/);
            assert.equal((await pending()).length, 1);
        },
    );
});

test("billing errors never resume, and a new answer ends a pending retry", async () => {
    await scenario(async ({ app, id, pending, restart, continuations, command }) => {
        await command("on");
        await say(app(), id, "bill me");
        assert.deepEqual(await pending(), []);
        await say(app(), id, "limit me");
        assert.equal((await pending()).length, 1);
        await say(app(), id, "hello");
        assert.deepEqual(await pending(), []);
        await restart(40);
        assert.equal(await continuations(), 0);
    });
});

test("Pi's own retry that recovers leaves no continuation", async () => {
    await scenario(async ({ app, id, pending, restart, continuations, command }) => {
        await command("on");
        await say(app(), id, "retry then recover");
        assert.ok((await modelTexts(app(), id)).some((text) => text.includes("echo:")));
        assert.deepEqual(await pending(), []);
        await restart(120);
        assert.equal(await continuations(), 0);
    });
});

test("turning a chat off, or cancel, stops its retry; the default follows new chats", async () => {
    await scenario(async ({ app, id, pending, command }) => {
        await command("on");
        await say(app(), id, "limit me");
        assert.equal((await pending()).length, 1);
        await command("off");
        assert.deepEqual(await pending(), []);

        await command("default");
        await say(app(), id, "limit me");
        assert.deepEqual(await pending(), [], "the default is off");

        await command("all on");
        const other = await newSession(app());

        await say(app(), other, "limit me");
        assert.equal((await pending(other)).length, 1);
        await command("cancel", owner(app()), other);
        assert.deepEqual(await pending(other), []);
    });
});

test("who may change what: guests change their chat only; viewers read; the owner sets the defaults", async () => {
    await scenario(async ({ app, id, command }) => {
        const guest = app().config.addUser("Gale", "guest");
        const viewer = app().config.addUser("Vic", "viewer");

        assert.match(await command("on", guest.user), /on \(this chat\)/);
        assert.match(await command("all on", guest.user), /"failed".*Only the owner/);
        assert.match(await command("delay 2h", guest.user), /"failed".*Only the owner/);
        assert.match(await command("delay 2m"), /"failed".*from 10m to 5h/);

        const server = createServer(
            createHandler({
                app: app(),
                listen: { host: "127.0.0.1", port: 0 },
                restart: () => {},
            }),
        );

        await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
        const base = `http://127.0.0.1:${(server.address() as { port: number }).port}/api/x/auto-resume`;
        const call = async (token: string, path: string, body?: unknown) =>
            (
                await fetch(`${base}/${path}`, {
                    method: body === undefined ? "GET" : "POST",
                    headers: {
                        authorization: `Bearer ${token}`,
                        "x-pocket": "1",
                        ...(body === undefined ? {} : { "content-type": "application/json" }),
                    },
                    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
                })
            ).status;

        try {
            assert.equal(await call(viewer.token, `chat/${id}`), 200);
            // A route someone may not use is not there for them.
            assert.equal(await call(viewer.token, `chat/${id}`, { on: false }), 405);
            assert.equal(await call(guest.token, `chat/${id}`, { on: false }), 200);
            assert.equal(await call(guest.token, "settings", { defaultOn: true }), 404);
            assert.equal(await call(app().config.ownerToken, "settings", { delayMinutes: 5 }), 400);
            assert.equal(
                await call(app().config.ownerToken, "settings", { delayMinutes: 30 }),
                200,
            );
        } finally {
            server.closeAllConnections();
            server.close();
        }

        assert.match(await command(""), /after 30 min/);
    });
});
