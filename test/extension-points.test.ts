// The extension points of 0.22.0 for people's values (`hidden.ts`, `extension-points.ts`): `host.commandEnv` puts a value
// into a command's environment, `host.hide` keeps it out of the output as it streams and out of every tool's result,
// `host.ask` asks the person Pi works for on a card whose values reach only the extension, and `host.browser` gives an
// extension the session's page, with a `fill` for a person's value.
import {
    type App,
    cleanUp,
    lastText,
    loadTools,
    newSession,
    openApp,
    owner,
    root,
    scriptedModel,
    until,
    work,
} from "./helpers.ts";
import assert from "node:assert/strict";
import { getEventListeners } from "node:events";
import { mkdirSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { FauxResponseStep } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import type { ConversationId } from "@earendil-works/pi-durable";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { findBrowser } from "../src/server/browser/discovery.ts";
import { HttpError } from "../src/server/errors.ts";
import { CommandEnvs, commandEnvLimits, HiddenValues, wrapEnv } from "../src/server/hidden.ts";

const SECRET = "s3cr3t-token-value";
const dataDir = join(root, "data");
const real = {
    skip: findBrowser() === undefined ? "no Chromium-based browser on this machine" : false,
} as const;
/** Everything the model was sent, to check that no value reached it. */
const sent: string[] = [];
let app: App;
let site: Server;
let base = "";

const route: FauxResponseStep = (request) => {
    sent.push(JSON.stringify(request));

    const { role, text } = lastText(request as never);
    const call = (name: string, args: Parameters<typeof fauxToolCall>[1]) =>
        fauxAssistantMessage([fauxToolCall(name, args)], { stopReason: "toolUse" });

    if (role === "toolResult") {
        return fauxAssistantMessage([fauxText(`ok: ${text}`)]);
    }

    if (text.endsWith("use the token")) {
        return call("bash", {
            command: 'printf "%s" "$TOKEN"; echo; printf "%s" "$TOKEN" | wc -c',
        });
    }

    if (text.endsWith("leak it")) {
        return call("test_leak", {});
    }

    if (text.endsWith("sign in")) {
        return call("test_sign_in", {});
    }

    if (text.endsWith("type the password")) {
        return call("browser", {
            action: "type",
            selector: "input[type=password]",
            text: "typed-by-pi",
        });
    }

    if (text.endsWith("type where the focus is")) {
        return call("browser", { action: "type", text: "typed-by-pi" });
    }

    return fauxAssistantMessage([fauxText(`echo: ${text}`)]);
};

before(async () => {
    mkdirSync(join(dataDir, "extensions"), { recursive: true });
    writeFileSync(
        join(dataDir, "extensions", "points.ts"),
        `/** Points: uses host.ask, host.hide, host.commandEnv, and host.browser, for tests. */
import { Type } from "@earendil-works/pi-ai";
import { defineExtension, defineTool, hook, ToolTask } from "@earendil-works/pi-durable";

export const pocketApi = 2;

const TARGET = ["ref", "selector", "label", "x", "y"];

export default (host, web) => {
    web.onDispose(host.hide({ value: ${JSON.stringify(SECRET)}, label: "secret TOKEN" }));
    web.onDispose(
        host.commandEnv(({ command }) =>
            typeof command === "string" && command.includes("$TOKEN") ? { TOKEN: ${JSON.stringify(SECRET)} } : undefined,
        ),
    );
    web.route("POST", "browse", async (request) => {
        const page = await host.browser(Number(request.body.id), { open: true });

        await page.navigate(String(request.body.url));

        const before = await page.snapshot();
        const field = before.controls.find((control) => control.kind === "password");
        const info = await page.inspect({ ref: field.ref });
        const label = await page.fill({ ref: field.ref }, "hunter2-pass");
        const after = await page.snapshot();
        const filled = after.controls.find((control) => control.kind === "password");
        // A field that holds a password, with no name of its own: what describes it never says the password.
        const again = await page.inspect({ ref: filled.ref });
        const refill = await page.fill({ ref: filled.ref }, "hunter2-pass");
        let data = "";

        try {
            await page.navigate("data:text/html,<script>1</script>");
        } catch (error) {
            data = error.message;
        }

        const refused = [];

        try {
            await page.fill({ x: 10, y: 10 }, "hunter2-pass");
        } catch (error) {
            refused.push(error.message);
        }

        try {
            await page.fill({ ref: filled.ref }, "hunter2-pass");
            await page.navigate(String(request.body.url) + "covered");
            const covered = (await page.snapshot()).controls.find((control) => control.kind === "password");

            await page.fill({ ref: covered.ref }, "hunter2-pass");
        } catch (error) {
            refused.push(error.message);
        }

        // Nothing went into the covered page's fields: a password field would show ••••.
        const coveredValues = (await page.snapshot()).controls.map((control) => control.value ?? "").join("");

        // A field in a shadow root, and a part of a rich text editor, are filled as any field is.
        await page.navigate(String(request.body.url) + "shadow");
        const deep = (await page.snapshot()).controls.find((control) => control.kind === "password");
        const shadow = { inspected: await page.inspect({ ref: deep.ref }), filled: await page.fill({ ref: deep.ref }, "deep-pass") };

        await page.fill({ selector: "#editor b" }, "new words");

        return {
            before: field,
            info,
            label,
            again: again.label,
            refill,
            data,
            refused,
            coveredValues,
            shadow,
            after: filled,
            text: after.text,
            evaluate: "evaluate" in page,
        };
    });

    const signIn = defineTool({
        name: "test_sign_in",
        description: "Sign in, with the person's values.",
        parameters: Type.Object({}),
        execute: async (_args, api, context) => {
            const answer = await host.ask(
                {
                    conversationId: api.conversationId,
                    id: api.taskId + ":" + api.callId,
                    taskId: api.taskId,
                    callId: api.callId,
                    title: "Sign in to example.test",
                    fields: [
                        { name: "user", label: "Username", autocomplete: "username" },
                        { name: "password", label: "Password", secret: true },
                    ],
                    submit: "Fill in",
                },
                context,
            );

            if (!answer.answered) {
                throw new Error(answer.by + " declined");
            }

            return {
                output: [
                    {
                        type: "text",
                        text: "filled " + answer.values.user.length + "+" + answer.values.password.length,
                    },
                ],
            };
        },
    });

    const leak = defineTool({
        name: "test_leak",
        description: "Give back the value, as a careless tool would.",
        parameters: Type.Object({}),
        execute: async () => ({
            output: [{ type: "text", text: "the value is " + ${JSON.stringify(SECRET)} }],
            details: { nested: [${JSON.stringify(SECRET)}] },
        }),
    });

    // As the guide shows: Pi's own browser tool never types into a password field; the card fills it.
    const noTypedPasswords = hook(ToolTask, {
        beforeTool: async (call, api) => {
            if (call.name !== "browser" || call.arguments.action !== "type") {
                return undefined;
            }

            const at = Object.fromEntries(TARGET.filter((key) => key in call.arguments).map((key) => [key, call.arguments[key]]));

            if (Object.keys(at).length === 0) {
                return { block: "Name the field to type into." };
            }

            const page = await host.browser(api.conversationId);
            const found = await page?.inspect(at).catch(() => undefined);

            return found?.password ? { block: "A password is filled in from its card, not typed by Pi." } : undefined;
        },
    });

    web.route("POST", "open", async (request) => {
        const page = await host.browser(Number(request.body.id), { open: true });

        await page.navigate(String(request.body.url));

        return { ok: true };
    });

    web.route("POST", "role", (request) => ({ role: host.roleOf(String(request.body.id)) ?? null }));

    web.route("POST", "scroll", async (request) => {
        const page = await host.browser(Number(request.body.id), { open: true });

        await page.navigate(String(request.body.url));

        const top = (await page.snapshot()).scroll;

        await page.scroll(undefined, 300);

        return { top, down: (await page.snapshot()).scroll };
    });

    return defineExtension({ name: "test-points", tools: [signIn, leak], hooks: [noTypedPasswords] });
};
`,
    );
    app = await openApp(scriptedModel(route), dataDir);
    await app.setExtensionEnabled(owner(app), "points.ts", true);
    site = createServer((request, response) => {
        response.writeHead(200, { "content-type": "text/html" });

        // At /shadow, a password field in a shadow root, and a rich text editor.
        if (request.url?.endsWith("shadow")) {
            return response.end(
                `<title>Deep</title><sign-in><template shadowrootmode="open"><label>Password <input type="password"></label></template></sign-in><div id="editor" contenteditable>Some <b>old words</b> here</div>`,
            );
        }

        if (request.url?.endsWith("tall")) {
            return response.end(`<title>Tall</title><div style="height:3000px">Tall page</div>`);
        }

        // At /covered, a banner lies over the password field, as a cookie banner can.
        const banner = request.url?.endsWith("covered")
            ? `<div style="position:fixed;inset:0;background:#fff;z-index:9">Accept cookies</div>`
            : "";

        response.end(
            `<title>Sign in</title><form><label>User <input name="user"></label><label>Password <input type="password" name="password"></label><button>Sign in</button></form>${banner}`,
        );
    });
    await new Promise<void>((done) => site.listen(0, "127.0.0.1", done));
    base = `http://127.0.0.1:${(site.address() as { port: number }).port}`;
});

after(async () => {
    site?.close();
    await app?.close();
    cleanUp();
});

const stored = async (id: ConversationId) =>
    JSON.stringify(await app.transcripts.allEntries(id, true));

test("hidden values leave output as it streams, also when a value is split across chunks", () => {
    const hidden = new HiddenValues();
    const stop = hidden.add({ value: "abcdefgh", label: "secret X" });
    const out: string[] = [];
    const stream = hidden.stream(1, (text) => out.push(text));
    const context = BACKGROUND_CONTEXT;

    for (const chunk of ["one abc", "def", "gh two ", "abcdefgh", " three"]) {
        stream.onOutput(chunk, context, { stream: "stdout" });
    }

    stream.flush();
    assert.equal(out.join(""), "one [secret X] two [secret X] three");

    // Output keeps its order across the two streams.
    const ordered: string[] = [];
    const both = hidden.stream(1, (text) => ordered.push(text));

    both.onOutput("ERR ", context, { stream: "stderr" });
    both.onOutput("OUT ", context, { stream: "stdout" });
    both.onOutput("ERR2", context, { stream: "stderr" });
    both.flush();
    assert.equal(ordered.join(""), "ERR OUT ERR2");

    // In a tool's result: strings and object keys, and the same object when nothing is there to hide.
    const result = {
        output: [{ type: "text" as const, text: "x" }],
        details: { abcdefgh: ["abcdefgh"] },
    };

    assert.deepEqual(hidden.result(result, 1).details, { "[secret X]": ["[secret X]"] });

    const clean = { output: [{ type: "text" as const, text: "nothing here" }] };

    assert.equal(hidden.result(clean, 1), clean);
    assert.ok(out.every((each) => !each.includes("abcdefgh")));
    // Another session's value, and one taken away, hide nothing here.
    hidden.add({ value: "elsewhere", label: "x", conversationId: 2 });
    assert.equal(hidden.replace("elsewhere", 1), "elsewhere");
    stop();
    assert.equal(hidden.replace("abcdefgh", 1), "abcdefgh");

    for (const bad of [
        { value: "abc", label: "x" },
        { value: "abcd", label: "two\nlines" },
        { value: "abcd", label: "x", conversationId: 0 },
    ]) {
        assert.throws(() => hidden.add(bad));
    }
});

test("a session's hidden value is hidden in its subagents too, and not elsewhere", () => {
    // Conversation 7 is a subagent of session 3.
    const hidden = new HiddenValues((id) => (id === 7 ? 3 : id));

    hidden.add({ value: "session-three-secret", label: "s3", conversationId: 3 });
    assert.equal(hidden.replace("session-three-secret", 7), "[s3]");
    assert.equal(hidden.replace("session-three-secret", 3), "[s3]");
    assert.equal(hidden.replace("session-three-secret", 4), "session-three-secret");
});

test("a provider that hangs adds nothing after its time, and the command runs", async () => {
    const envs = new CommandEnvs(() => {});
    const was = commandEnvLimits.providerMs;

    commandEnvLimits.providerMs = 50;
    envs.add(() => new Promise(() => {}));
    envs.add(() => ({ AFTER: "yes" }));

    try {
        assert.deepEqual(await envs.for({ conversationId: 1, command: "true", cwd: work }), {
            AFTER: "yes",
        });

        // One signal for many commands keeps no listener for those done.
        const signal = new AbortController().signal;

        for (let index = 0; index < 5; index += 1) {
            await envs.for({ conversationId: 1, command: "true", cwd: work }, signal);
        }

        assert.equal(getEventListeners(signal, "abort").length, 0);
    } finally {
        commandEnvLimits.providerMs = was;
    }
});

test("a command gets the variables a provider gives it, and its output hides the value", async () => {
    const hidden = new HiddenValues();
    const envs = new CommandEnvs(() => {});

    hidden.add({ value: SECRET, label: "secret TOKEN" });
    envs.add(({ command }) => (String(command).includes("$TOKEN") ? { TOKEN: SECRET } : undefined));
    // A provider that throws, or gives a bad name, adds nothing, and the command still runs.
    envs.add(() => {
        throw new Error("broken");
    });
    envs.add(() => ({ "1BAD": "x", GOOD: "yes" }));

    const env = wrapEnv(new NodeExecutionEnv({ cwd: work }), 1, work, envs, hidden);
    let output = "";
    const result = await env.exec(
        'printf "%s %s" "$TOKEN" "$GOOD"',
        { onOutput: (text) => (output += text) },
        BACKGROUND_CONTEXT,
    );

    assert.ok(result.ok);
    assert.equal(output, "[secret TOKEN] yes");
});

test("Pi's bash uses the value without the model, the transcript, or the result holding it", async () => {
    const id = await newSession(app);
    const before = sent.length;

    await app.commands.submit(id, owner(app), {
        text: "please use the token",
        requestId: crypto.randomUUID(),
    });
    await until(async () => (await stored(id)).includes("ok: "), "the answer");

    const transcript = await stored(id);

    assert.match(transcript, /\[secret TOKEN\]/);
    // The value was there: its length counted.
    assert.match(transcript, new RegExp(String(SECRET.length)));
    assert.doesNotMatch(transcript, new RegExp(SECRET));
    assert.ok(sent.slice(before).every((request) => !request.includes(SECRET)));
});

test("a value pasted into a message to Pi, or into an edit sent again, is hidden before it is stored", async () => {
    const id = await newSession(app);
    const me = owner(app);
    const before = sent.length;

    await app.commands.submit(id, me, {
        text: `the key is ${SECRET} ok`,
        requestId: crypto.randomUUID(),
    });
    await until(async () => (await stored(id)).includes("echo: "), "the answer");
    assert.match(await stored(id), /the key is \[secret TOKEN\] ok/);
    assert.doesNotMatch(await stored(id), new RegExp(SECRET));

    const entries = await app.transcripts.allEntries(id, true);
    const message = entries.find((entry) => entry.kind === "user")!;
    const { id: fork } = await app.commands.resend(id, me, {
        entryId: message.id,
        text: `now ${SECRET} again`,
    });

    await until(async () => (await stored(fork)).includes("echo: now"), "the fork's answer");
    assert.match(await stored(fork), /now \[secret TOKEN\] again/);
    assert.doesNotMatch(await stored(fork), new RegExp(SECRET));
    assert.ok(sent.slice(before).every((request) => !request.includes(SECRET)));
});

test("a ! command that holds a hidden value is refused, so it is not stored as typed", async () => {
    const id = await newSession(app);

    await assert.rejects(
        app.shell.start(id, owner(app), { command: `echo ${SECRET}` }),
        /holds a hidden value/,
    );
});

test("any tool's result hides the value before it is stored, its details too", async () => {
    const id = await newSession(app);

    await app.commands.submit(id, owner(app), {
        text: "please leak it",
        requestId: crypto.randomUUID(),
    });
    await until(async () => (await stored(id)).includes("ok: "), "the answer");

    const transcript = await stored(id);

    assert.match(transcript, /the value is \[secret TOKEN\]/);
    assert.doesNotMatch(transcript, new RegExp(SECRET));
});

test("host.roleOf gives a person's role by id, and nothing for an id that is not a person", async () => {
    const guest = app.config.addUser("Rae", "guest").user;
    const viewer = app.config.addUser("Vic", "viewer").user;

    const ask = async (id: string) => {
        const { createHandler } = await import("../src/server/http.ts");
        const server = createServer(
            createHandler({ app, listen: { host: "127.0.0.1", port: 0 }, restart: () => {} }),
        );

        await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));

        try {
            const response = await fetch(
                `http://127.0.0.1:${(server.address() as { port: number }).port}/api/x/points/role`,
                {
                    method: "POST",
                    headers: {
                        authorization: `Bearer ${app.config.ownerToken}`,
                        "x-pocket": "1",
                        "content-type": "application/json",
                    },
                    body: JSON.stringify({ id }),
                },
            );

            return ((await response.json()) as { role: string | null }).role;
        } finally {
            server.closeAllConnections();
            server.close();
        }
    };

    assert.equal(await ask(owner(app).id), "owner");
    assert.equal(await ask(guest.id), "guest");
    assert.equal(await ask(viewer.id), "viewer");
    assert.equal(await ask("nobody"), null);

    app.config.updateUser(guest.id, { role: "viewer" });
    assert.equal(await ask(guest.id), "viewer");
    app.config.removeUser(guest.id);
    assert.equal(await ask(guest.id), null);
});

test("an ask's card is answered by the person Pi works for, and its values reach only the extension", async () => {
    const id = await newSession(app);
    const me = owner(app);
    const guest = app.config.addUser("Gus", "guest").user;

    await app.commands.submit(id, me, { text: "please sign in", requestId: crypto.randomUUID() });
    await until(() => app.approvals.forConversation(id).length === 1, "the card");

    const [card] = app.approvals.forConversation(id);

    assert.equal(card!.form?.title, "Sign in to example.test");
    assert.deepEqual(
        card!.form?.fields.map((field) => field.name),
        ["user", "password"],
    );
    assert.equal(card!.requestedBy, me.id);

    // Its peek tile knows it is a question, which is answered on its card (Open and Decline, never Allow).
    const tile = (await app.room(id)).peek()?.approvals[0];

    assert.equal(tile?.form, true);
    assert.doesNotMatch(JSON.stringify(tile), /fields/);

    // Someone else in the session cannot answer it; a plain Allow, or a missing field, is no answer.
    await assert.rejects(
        app.answerApproval(card!.id, true, guest, { user: "x", password: "y" }),
        (error) => error instanceof HttpError && error.status === 403,
    );
    await assert.rejects(
        app.answerApproval(card!.id, true, me),
        (error) => error instanceof HttpError && error.status === 400,
    );
    await assert.rejects(
        app.answerApproval(card!.id, true, me, { user: "tevis" }),
        /Fill in Password/,
    );
    await assert.rejects(
        app.answerApproval(card!.id, true, me, { user: "tevis", password: "pw", extra: "z" }),
        /not a field/,
    );

    assert.equal(
        await app.answerApproval(card!.id, true, me, { user: "tevis", password: "correct-horse" }),
        true,
    );
    await until(async () => (await stored(id)).includes("ok: filled"), "the answer");

    const transcript = await stored(id);

    assert.match(transcript, /filled 5\+13/);
    assert.doesNotMatch(transcript, /correct-horse|tevis/);

    // Anyone who can steer declines one.
    await app.commands.submit(id, me, { text: "again sign in", requestId: crypto.randomUUID() });
    await until(() => app.approvals.forConversation(id).length === 1, "the second card");
    assert.equal(
        await app.answerApproval(app.approvals.forConversation(id)[0]!.id, false, guest),
        true,
    );
    await until(async () => (await stored(id)).includes("Gus declined"), "the decline");
});

test(
    "an extension drives the session's page and fills a password Pi never sees",
    real,
    async () => {
        const id = await newSession(app);
        const { createHandler } = await import("../src/server/http.ts");
        const server = createServer(
            createHandler({ app, listen: { host: "127.0.0.1", port: 0 }, restart: () => {} }),
        );

        await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));

        try {
            const response = await fetch(
                `http://127.0.0.1:${(server.address() as { port: number }).port}/api/x/points/browse`,
                {
                    method: "POST",
                    headers: {
                        authorization: `Bearer ${app.config.ownerToken}`,
                        "x-pocket": "1",
                        "content-type": "application/json",
                    },
                    body: JSON.stringify({ id: Number(id), url: `${base}/` }),
                },
            );
            const result = (await response.json()) as {
                before: { kind: string; value: string; role: string };
                info: { password: boolean; editable: boolean };
                after: { value: string };
                text: string;
                evaluate: boolean;
                data: string;
                refused: string[];
                coveredValues: string;
                shadow: { inspected: { password: boolean }; filled: string };
            };

            assert.equal(response.status, 200, JSON.stringify(result));
            assert.equal(result.before.kind, "password");
            assert.equal(result.before.value, "");
            assert.deepEqual(
                { password: result.info.password, editable: result.info.editable },
                { password: true, editable: true },
            );
            assert.equal(result.after.value, "••••");
            assert.doesNotMatch(JSON.stringify(result), /hunter2/);
            assert.match(result.data, /navigate needs/);
            assert.match(result.refused[0] ?? "", /not by a point/);
            assert.match(result.refused[1] ?? "", /covered by/);
            assert.equal(result.coveredValues, "");
            assert.equal(result.shadow.inspected.password, true);
            assert.doesNotMatch(result.text, /hunter2/);
            assert.equal(result.evaluate, false, "no script runs through the handle");
            // The shadow root's field holds the value, and the editor its new words.
            assert.equal(
                await app.browsers
                    .page(Number(id))!
                    .evaluate(
                        `document.querySelector("sign-in").shadowRoot.querySelector("input").value + "|" + document.querySelector("#editor").innerText`,
                    ),
                "deep-pass|new words",
            );
        } finally {
            server.closeAllConnections();
            server.close();
            await app.browsers.close(Number(id));
        }
    },
);

test("a hook can keep Pi's own browser tool from typing into a password field", real, async () => {
    const id = await newSession(app);

    await loadTools(app, id, "browser");
    const { createHandler } = await import("../src/server/http.ts");
    const server = createServer(
        createHandler({ app, listen: { host: "127.0.0.1", port: 0 }, restart: () => {} }),
    );

    await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));

    try {
        const opened = await fetch(
            `http://127.0.0.1:${(server.address() as { port: number }).port}/api/x/points/open`,
            {
                method: "POST",
                headers: {
                    authorization: `Bearer ${app.config.ownerToken}`,
                    "x-pocket": "1",
                    "content-type": "application/json",
                },
                body: JSON.stringify({ id: Number(id), url: `${base}/` }),
            },
        );

        assert.equal(opened.status, 200);
        await app.commands.submit(id, owner(app), {
            text: "type the password",
            requestId: crypto.randomUUID(),
        });
        await until(async () => (await stored(id)).includes("from its card"), "the block");
        await app.commands.submit(id, owner(app), {
            text: "type where the focus is",
            requestId: crypto.randomUUID(),
        });
        await until(async () => (await stored(id)).includes("Name the field"), "the second block");
        assert.equal(
            await app.browsers
                .page(Number(id))!
                .evaluate(
                    `[...document.querySelectorAll("input")].map((input) => input.value).join("")`,
                ),
            "",
        );
    } finally {
        server.closeAllConnections();
        server.close();
        await app.browsers.close(Number(id));
    }
});

test("a snapshot says where the page is scrolled, in CSS pixels", real, async () => {
    const id = await newSession(app);
    const { createHandler } = await import("../src/server/http.ts");
    const server = createServer(
        createHandler({ app, listen: { host: "127.0.0.1", port: 0 }, restart: () => {} }),
    );

    await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));

    const scroll = async (path: string) => {
        const response = await fetch(
            `http://127.0.0.1:${(server.address() as { port: number }).port}/api/x/points/scroll`,
            {
                method: "POST",
                headers: {
                    authorization: `Bearer ${app.config.ownerToken}`,
                    "x-pocket": "1",
                    "content-type": "application/json",
                },
                body: JSON.stringify({ id: Number(id), url: `${base}/${path}` }),
            },
        );
        const result = (await response.json()) as {
            top: { y: number; viewport: number; height: number };
            down: { y: number; viewport: number; height: number };
        };

        assert.equal(response.status, 200, JSON.stringify(result));

        return result;
    };

    try {
        const tall = await scroll("tall");

        assert.equal(tall.top.y, 0);
        assert.ok(tall.top.viewport > 0);
        assert.ok(tall.top.height >= 3000, `the page is ${tall.top.height} tall`);
        assert.ok(tall.top.y + tall.top.viewport < tall.top.height, "more below");
        assert.ok(tall.down.y > 0, "scrolled down");
        assert.equal(tall.down.height, tall.top.height);

        const short = await scroll("");

        assert.ok(short.top.y + short.top.viewport >= short.top.height, "nothing below");
        assert.equal(short.down.y, 0);
    } finally {
        server.closeAllConnections();
        server.close();
        await app.browsers.close(Number(id));
    }
});
