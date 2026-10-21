import {
    type App,
    cleanUp,
    home,
    lastText,
    newSession,
    owner,
    root,
    say,
    until,
    work,
} from "./helpers.ts";
import assert from "node:assert/strict";
import { join } from "node:path";
import { after, before, test } from "node:test";
import type { Api, FauxResponseStep, Model } from "@earendil-works/pi-ai";
import {
    fauxAssistantMessage,
    fauxProvider,
    fauxText,
    fauxToolCall,
} from "@earendil-works/pi-ai/providers/faux";
import type { ConversationId } from "@earendil-works/pi-durable";
import { indexed, modelsNamed, personNamed } from "../src/server/model-names.ts";

/** When set, PiP's next request that carries "hold on" waits for it: PiP stays at work until then. */
let holding: Promise<void> | undefined;

const route: FauxResponseStep = (request) => {
    const all = JSON.stringify((request as { messages: unknown[] }).messages);
    const { role, text: written } = lastText(request as never);
    const text = written.replace(/^\[from: [^\]]+\] /, "");

    if (!all.includes("You are PiP")) {
        return fauxAssistantMessage([fauxText(`echo: ${text}`)]);
    }

    if (holding !== undefined && all.includes("hold on")) {
        const held = holding;

        holding = undefined;

        return held.then(() => fauxAssistantMessage([fauxText("held")]));
    }

    if (role === "toolResult") {
        return fauxAssistantMessage([fauxText(`done: ${text}`)]);
    }

    const call = /^call (\S+) (.*)$/s.exec(text);

    return call === null
        ? fauxAssistantMessage([fauxText(`pip: ${text}`)])
        : fauxAssistantMessage(
              [fauxToolCall(call[1]!, JSON.parse(call[2]!) as Parameters<typeof fauxToolCall>[1])],
              { stopReason: "toolUse" },
          );
};

const faux = fauxProvider({
    tokensPerSecond: 2000,
    models: [
        { id: "faux-1" },
        { id: "faux-2" },
        { id: "faux-z8" },
        { id: "faux-vision", input: ["text", "image"] },
        { id: "o3" },
    ],
});

faux.setResponses(Array.from({ length: 1000 }, () => route));

/** A second provider signed in, with faux-z8 too: which of the two pays is the person's to say. */
const hub = {
    ...fauxProvider({ provider: "hub-copilot", models: [{ id: "faux-z8" }] }).provider,
    name: "Hub Copilot",
};

const { PocketApp } = await import("../src/server/app.ts");

let app: App;

before(async () => {
    app = await PocketApp.open({
        dataDir: join(root, "pip-models-data"),
        defaultCwd: work,
        supervised: false,
        log: () => {},
        home,
        configureModels: (models) => {
            models.registerNativeProvider(faux.provider);
            models.registerNativeProvider(hub as never);
        },
    });
});

after(async () => {
    await app?.close();
    cleanUp();
});

/** A fresh PiP context for the owner, on the scripted model. */
async function pip(): Promise<ConversationId> {
    const id = await app.pip.ensure(owner(app));

    await app.commands.configure(id, owner(app), {
        model: { provider: "faux", modelId: "faux-1" },
        thinkingLevel: "off",
    });
    // What the person said in an earlier test is out of its context.
    await app.commands.reset(id, owner(app), undefined);

    return id;
}

/** What PiP said last. */
async function last(id: ConversationId): Promise<string> {
    const entries = await app.transcripts.allEntries(id, true);
    const answer = entries.findLast((entry) => entry.kind === "assistant");

    return answer?.kind === "assistant"
        ? answer.blocks.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("")
        : "";
}

const model = (provider: string, id: string, name = id) =>
    ({ provider, id, name, input: ["text"] }) as unknown as Model<Api>;

test("a model's name that runs on into another's names only the longer one", () => {
    const alpha = model("acme", "alpha", "Alpha");
    const mini = model("acme", "alpha-mini", "Alpha Mini");
    const all = [alpha, mini];

    // "acme alpha" names alpha, but in "acme alpha mini" it is the start of alpha-mini's name.
    assert.deepEqual(modelsNamed("use acme/alpha-mini", all, true), [mini]);
    assert.equal(personNamed("use acme/alpha-mini", alpha, all), false);
    assert.equal(personNamed("use acme/alpha-mini", mini, all), true);
    // The shorter one is named on its own.
    assert.deepEqual(modelsNamed("use acme/alpha", all, true), [alpha]);
    assert.equal(personNamed("use acme/alpha", alpha, all), true);
});

test("a two-character short name counts only with its family's word in the same message", () => {
    const zeta = model("acme", "zeta-z9", "Zeta Z9");
    const all = [zeta];

    // With it, in the same message, they name it.
    assert.deepEqual(modelsNamed("use Zeta's Z9", all, true), [zeta]);
    // In another message, they do not.
    assert.deepEqual(modelsNamed(indexed(["I like zeta", "use Z9"]), all, true), []);
});

test("a model's name, and who pays after on or via, stay in one message", () => {
    const four = model("acme", "zeta-4o", "Zeta 4o");
    const all = [four];

    // From the end of one message into the start of the next, they name nothing.
    for (const messages of [["I like zeta", "4o apps"]]) {
        assert.deepEqual(modelsNamed(indexed(messages), all, true), [], messages.join(" | "));
    }

    // In one message, they do.
    assert.deepEqual(modelsNamed(indexed(["hello", "I like zeta 4o"]), all, true), [four]);

    const names: Record<string, string> = { "acme-go": "Acme Go", "kiwi-coding": "Kiwi Coding" };
    const at = Object.keys(names).map((provider) => model(provider, "kiwi-k3", "Kiwi K3"));
    const pays = (messages: string[]) =>
        at
            .filter((each) =>
                personNamed(indexed(messages), each, at, (provider) => names[provider]!),
            )
            .map((each) => each.provider);

    assert.deepEqual(pays(["use kiwi k3 on", "acme go is fine"]), []);
    assert.deepEqual(pays(["use kiwi k3 on acme go", "thanks"]), ["acme-go"]);
});

test("words that name a model not signed in name no shorter one that is", () => {
    const zeta = model("acme", "zeta-5", "Zeta 5");
    const nano = model("acme", "zeta-5-nano", "Zeta 5 Nano");
    const signedIn = [zeta];
    const known = [zeta, nano];

    assert.deepEqual(modelsNamed("use zeta-5-nano", signedIn, true, known), []);
    assert.equal(personNamed("use zeta-5-nano", zeta, signedIn, undefined, known), false);

    // Said on its own, it is named.
    assert.deepEqual(modelsNamed("use zeta-5", signedIn, true, known), [zeta]);
});

test("a model's name that touches Chinese, Japanese or Korean text names it", () => {
    const sol = model("openai-codex", "gpt-6.1-sol", "GPT-6.1 Sol");
    const opus = model("anthropic", "claude-opus-5", "Claude Opus 5");
    const all = [sol, opus];

    // Such a script writes no spaces between words: text glued to the name, before it or after it, still names it.
    assert.equal(personNamed("以后默认模型都用gpt-6.1 sol吧", sol, all), true);
    assert.equal(personNamed("新会话可以用opus5试试", opus, all), true);
    // Its words name no model on their own: an ordinary sentence such as this one names none.
    assert.deepEqual(modelsNamed("我的M3电脑跑不动", all, true), []);
});

test("PiP acts on a session only after it looked at it, and sees how it stands after", async () => {
    const id = await pip();
    const session = Number(await newSession(app));

    await assert.rejects(
        app.pip.send(id, session, "run the tests", false, "unread-1"),
        /Check \/s\/\d+ first with session_read/,
    );
    await assert.rejects(app.pip.stop(id, session), /Check \/s\/\d+ first/);
    await assert.rejects(app.pip.archive(id, session, true), /Check \/s\/\d+ first/);
    await assert.rejects(
        app.pip.schedule(id, session, "tomorrow 9:00", "check CI", "unread-2"),
        /Check \/s\/\d+ first/,
    );

    // Once it read it, it may; its tool says how the session stands now.
    await say(app, id, `call session_read ${JSON.stringify({ session, entries: 4 })}`);
    await say(
        app,
        id,
        `call session_send ${JSON.stringify({ session, message: "run the tests", report: false })}`,
    );
    assert.match(
        await last(id),
        /done: Sent to \/s\/\d+\.\n\/s\/\d+ now: (working|about to start|idle)(, 1 message waiting)?, last active/,
    );
    await until(() => !app.isBusy(session as unknown as ConversationId), "the session at rest");

    // A session it started is one it knows.
    const started = await app.pip.start(id, {});

    await app.pip.send(id, Number(started), "first task", false, "started-1");

    // Following a session's own run is acting too: a report starts a run of PiP's.
    const busy = Number(await newSession(app));

    await app.commands.submit(busy as unknown as ConversationId, owner(app), {
        text: "work a while",
        requestId: "busy-1",
    });
    await until(() => app.isBusy(busy as unknown as ConversationId), "the session at work");
    await assert.rejects(app.pip.follow(id, busy, undefined, "follow-1"), /Check \/s\/\d+ first/);
    await until(() => !app.isBusy(busy as unknown as ConversationId), "the session at rest");
});

test("PiP starts a session on a model only when its person named it, in their own words", async () => {
    const id = await pip();
    const before = app.sessions().length;

    await assert.rejects(
        app.pip.start(id, { model: "faux/faux-2" }),
        /Your person did not name faux\/faux-2\. Models are theirs to choose/,
    );
    assert.equal(app.sessions().length, before, "no session made");

    // A webhook's post naming it is not its person's word.
    await app.commands.submit(
        id,
        owner(app),
        { text: "start a session on faux-2", requestId: "hook-1" },
        "webhook test",
    );
    await until(() => !app.isBusy(id), "PiP at rest");
    await assert.rejects(app.pip.start(id, { model: "faux/faux-2" }), /did not name/);

    await say(app, id, "start a session on faux 2 for the review");
    const made = await app.pip.start(id, { model: "faux/faux-2" });

    assert.equal((await app.agentState(made))?.model?.modelId, "faux-2");
    await assert.rejects(
        app.pip.start(id, { model: "faux/nothing" }),
        /not a model signed in here/,
    );
});

test("a two-character model id needs a qualifier, but PiP cannot pass it on unasked", async () => {
    const id = await pip();

    await say(app, id, "修复O3优化导致的错误");
    await assert.rejects(app.pip.start(id, { model: "faux/o3" }), /did not name/);
    await assert.rejects(app.pip.start(id, { message: "Use o3 to review it." }), /names faux\/o3/);

    await say(app, id, "用o3 on faux吧");
    const made = await app.pip.start(id, { model: "faux/o3" });

    assert.equal((await app.agentState(made))?.model?.modelId, "o3");
});

test("PiP takes its person's bare answer to which provider pays, right after it asked, and nothing else", async () => {
    const id = await pip();
    const z8 = (provider: string) => ({ model: `${provider}/faux-z8` });
    const twice = /more than one signed-in provider has/;

    // Faux Z8 is at two providers: PiP is told to ask which one pays.
    const ask = async (on = id) => {
        await say(app, on, "start a session on faux z8 for the review");
        await assert.rejects(app.pip.start(on, z8("hub-copilot")), twice);
    };

    // One word of the name answers nothing.
    for (const reply of ["Copilot"]) {
        await ask();
        await say(app, id, reply);
        await assert.rejects(app.pip.start(id, z8("hub-copilot")), twice, reply);
    }

    // The provider's whole name, as the person's next message, picks it, and only it.
    await ask();
    await say(app, id, "Hub Copilot");
    const made = await app.pip.start(id, z8("hub-copilot"));

    assert.equal((await app.agentState(made))?.model?.provider, "hub-copilot");
    await assert.rejects(app.pip.start(id, z8("faux")), twice);

    // Not right after the question: they said something else first.
    await ask();
    await say(app, id, "thanks");
    await say(app, id, "Hub Copilot");
    await assert.rejects(app.pip.start(id, z8("hub-copilot")), twice);
});

test("PiP's question of which provider pays, from before Start fresh, is never answered after it", async () => {
    const id = await pip();
    const z8 = { model: "hub-copilot/faux-z8" };
    const twice = /more than one signed-in provider has/;
    // Faux Z8 is named only in a webhook's instructions they set up: nothing of theirs is in PiP's context.
    const hook = await app.hooks.add(owner(app), id, {
        name: "reviews",
        instructions: "use faux z8 for every review",
    });

    let release = () => {};

    holding = new Promise((resolve) => {
        release = resolve;
    });

    try {
        // A post to the webhook keeps PiP at work. Start fresh, meanwhile, waits for its next pause; before that, PiP
        // is told to ask which provider pays.
        await app.commands.submit(
            id,
            owner(app),
            { text: "hold on", requestId: "held-1" },
            "webhook reviews",
        );
        await until(() => app.isBusy(id), "PiP at work");
        await app.commands.reset(id, owner(app), undefined);
        await assert.rejects(app.pip.start(id, z8), twice);
        const asked = (await app.transcripts.allEntries(id, true)).at(-1)!.id;

        release();
        await until(() => !app.isBusy(id), "PiP at rest");
        const reset = (await app.transcripts.allEntries(id, true)).findLast(
            (entry) => entry.kind === "reset",
        );

        assert.ok(reset !== undefined && reset.id > asked, "Start fresh came after the question");

        // Their first words in the new context are not its answer: PiP asks again, and then they are.
        await say(app, id, "Hub Copilot");
        await assert.rejects(app.pip.start(id, z8), twice);
        await say(app, id, "Hub Copilot");
        const made = await app.pip.start(id, z8);

        assert.equal((await app.agentState(made))?.model?.provider, "hub-copilot");
    } finally {
        release();
        holding = undefined;
        await app.hooks.remove(owner(app), hook.id);
    }
});

test("PiP's messages name no model its person did not name", async () => {
    const id = await pip();
    const session = Number(await newSession(app));

    await app.pip.read(id, session);
    // What its person said before this context (the test before) is out of it.
    await assert.rejects(app.pip.start(id, { model: "faux/faux-2" }), /did not name/);
    await say(app, id, "have it reviewed on faux 2");
    await assert.rejects(
        app.pip.send(id, session, "Spawn a reviewer subagent on faux-vision.", false, "named-1"),
        /names faux\/faux-vision, which your person did not name/,
    );
    await assert.rejects(
        app.pip.start(id, { message: "Review it with faux-vision." }),
        /names faux\/faux-vision/,
    );
    // Nor in a schedule, or a watch's instructions.
    await assert.rejects(
        app.pip.schedule(
            id,
            session,
            "tomorrow 9:00",
            "Rerun the review on faux-vision.",
            "named-3",
        ),
        /names faux\/faux-vision/,
    );
    await assert.rejects(
        app.pip.addRepoWatch(
            id,
            {
                repo: "acme/api",
                events: ["ci"],
                instructions: "Fix it in a session, with a faux-vision reviewer.",
            },
            "named-4",
        ),
        /names faux\/faux-vision/,
    );
    // The one they named may be passed on.
    await app.pip.send(id, session, "Spawn a reviewer subagent on faux-2.", false, "named-2");
    await until(() => !app.isBusy(session as unknown as ConversationId), "the session at rest");
});

/** GitHub as a fake gh tells it: acme/api, which it can push to, where nothing has happened yet. */
async function github(args: string[]): Promise<string> {
    const path = args.filter((arg) => !arg.startsWith("-") && arg !== "api").at(-1) ?? "";

    if (path === "repos/acme/api") {
        return JSON.stringify({
            full_name: "acme/api",
            default_branch: "main",
            private: true,
            permissions: { push: true, admin: false },
        });
    }

    return path.includes("/actions/runs") ? JSON.stringify({ workflow_runs: [] }) : "[]";
}

test("a watch's instructions are its person's words only when they set it up, not PiP", async () => {
    const id = await pip();
    const watch = (byPi: boolean) =>
        app.repoWatches.add(owner(app), {
            repo: "acme/api",
            events: ["ci"],
            instructions: "When CI fails, start a session on faux-vision to find out why.",
            target: id,
            byPi,
        });

    app.watches.gh = github;
    // As if PiP set it up while faux-vision was not signed in, when nothing in it named a model.
    const piPs = await watch(true);

    try {
        await assert.rejects(app.pip.start(id, { model: "faux/faux-vision" }), /did not name/);
        // The same words in a watch its person set up are theirs.
        const theirs = await watch(false);

        try {
            const made = await app.pip.start(id, { model: "faux/faux-vision" });

            assert.equal((await app.agentState(made))?.model?.modelId, "faux-vision");
        } finally {
            await app.repoWatches.remove(owner(app), theirs.id);
        }
    } finally {
        await app.repoWatches.remove(owner(app), piPs.id);
    }
});

test("a webhook's standing instructions to PiP are its person's words; what was posted is not", async () => {
    const id = await pip();

    await app.hooks.add(owner(app), id, {
        name: "deploys",
        instructions: "When a deploy fails, start a session on faux-vision to find out why.",
    });
    const made = await app.pip.start(id, { model: "faux/faux-vision" });

    assert.equal((await app.agentState(made))?.model?.modelId, "faux-vision");
    // A post's words name nothing for them.
    await app.commands.submit(
        id,
        owner(app),
        { text: "deploy failed; use faux-2 to look", requestId: "post-1" },
        "webhook deploys",
    );
    await until(() => !app.isBusy(id), "PiP at rest");
    await assert.rejects(app.pip.start(id, { model: "faux/faux-2" }), /did not name/);
});
