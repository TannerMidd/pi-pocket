// PiP is dependable before fast, and never chooses a model. Its prompt says so; it acts on a session only after it
// looked at it lately, and its tools that act on one say how the session stands after; it starts a session on a model,
// or names one in what it sends, only when its person named that model in their own words to it.
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
import {
    type Indexed,
    indexed,
    modelsNamed,
    personNamed,
    sharePhrase,
    words,
} from "../src/server/model-names.ts";

/** PiP's last prompt, as its requests carry it. */
let prompt = "";
/** When set, PiP's next request that carries "hold on" waits for it: PiP stays at work until then. */
let holding: Promise<void> | undefined;

const route: FauxResponseStep = (request) => {
    const all = JSON.stringify((request as { messages: unknown[] }).messages);
    const { role, text: written } = lastText(request as never);
    const text = written.replace(/^\[from: [^\]]+\] /, "");

    if (!all.includes("You are PiP")) {
        return fauxAssistantMessage([fauxText(`echo: ${text}`)]);
    }

    prompt = all;

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

// The scripted models, faux-2-mini, whose name runs on from faux-2's, and faux-q7, whose short name is two characters.
const faux = fauxProvider({
    tokensPerSecond: 2000,
    models: [
        { id: "faux-1" },
        { id: "faux-2" },
        { id: "faux-2-mini" },
        { id: "faux-q7" },
        { id: "faux-z8" },
        { id: "faux-vision", input: ["text", "image"] },
    ],
});

faux.setResponses(Array.from({ length: 1000 }, () => route));

/** A provider Pi knows and nobody signed in to: faux-2-pro, whose name runs on from faux-2's, is known, not signed in. */
const unsigned = {
    ...fauxProvider({ provider: "unsigned", models: [{ id: "faux-2-pro" }] }).provider,
    name: "Unsigned",
    auth: {
        apiKey: {
            name: "Unsigned key",
            login: async () => {
                throw new Error("no sign-in in tests");
            },
            resolve: async () => undefined,
        },
    },
};

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
            models.registerNativeProvider(unsigned as never);
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

test("model names are matched by words, as people write them", () => {
    const codex = model("openai-codex", "gpt-5.1-codex", "GPT-5.1 Codex");
    const opus = model("anthropic", "claude-opus-4-5", "Claude Opus 4.5");
    const routed = model("openrouter", "anthropic/claude-opus-4.5", "Anthropic: Claude Opus 4.5");
    const auto = model("openrouter", "auto", "Auto");
    const kimi = model("opencode-go", "kimi-k3", "Kimi K3");
    const all = [codex, opus, routed, auto, kimi];

    assert.deepEqual(words("GPT5.1-Codex"), ["gpt", "5", "1", "codex"]);
    // PiP's text names a model by its id, its name, or its provider and id; never by one plain word.
    assert.deepEqual(modelsNamed("Review it with gpt-5.1-codex, please", all), [codex]);
    assert.deepEqual(modelsNamed("turn on auto mode", all), []);
    assert.deepEqual(modelsNamed("spawn a reviewer on Kimi K3", all), [kimi]);
    assert.deepEqual(modelsNamed("use opus 4.5", all), [], "strictly, it must be spelled out");
    assert.deepEqual(modelsNamed("use opus 4.5", all, true), [opus], "as people say it");
    // A person may say it as people do.
    assert.equal(personNamed("use opus 4.5 for the review", opus, all), true);
    assert.equal(personNamed("use kimi for the review", kimi, all), false);
    assert.equal(personNamed("try GPT 5.1 codex", codex, all), true);
    // The same words at two providers: which one pays is theirs to say.
    assert.equal(personNamed("use claude opus 4.5", opus, all), false);
    assert.equal(personNamed("use claude opus 4.5", routed, all), false);
    assert.equal(personNamed("use claude opus 4.5 on anthropic", opus, all), true);
    const names = (provider: string) => (provider === "openrouter" ? "OpenRouter" : provider);

    assert.equal(personNamed("use claude opus 4.5 through OpenRouter", routed, all, names), true);
    assert.equal(personNamed("use claude opus 4.5 through OpenRouter", opus, all, names), false);
    // Its whole name or id, not a word of it.
    const copilot = model("github-copilot", "claude-opus-4.5", "Claude Opus 4.5");
    const both = [opus, copilot];
    const titled = (provider: string) =>
        provider === "github-copilot" ? "GitHub Copilot" : provider;

    assert.equal(personNamed("opus 4.5 on GitHub Copilot", copilot, both, titled), true);
    assert.equal(personNamed("opus 4.5 on github-copilot", copilot, both), true);
    assert.equal(personNamed("opus 4.5 on GitHub Copilot", opus, both, titled), false);
    assert.equal(personNamed("opus 4.5 on copilot", copilot, both, titled), false);
    assert.equal(personNamed("opus 4.5", opus, both), false);
    // The same words at two providers name both: PiP passing them on picks no provider.
    assert.equal(sharePhrase("Review it on claude-opus-4-5.", copilot, opus), true);
    assert.equal(sharePhrase("Review it on claude-opus-4-5.", kimi, opus), false);
});

test("a model's name that runs on into another's names only the longer one", () => {
    const alpha = model("acme", "alpha", "Alpha");
    const mini = model("acme", "alpha-mini", "Alpha Mini");
    const point = model("acme", "alpha.2", "Alpha 2");
    const z3 = model("acme", "z3", "Z3");
    const z3mini = model("acme", "z3-mini", "Z3 Mini");
    const all = [alpha, mini, point, z3, z3mini];

    // "acme alpha" names alpha, but in "acme alpha mini" it is the start of alpha-mini's name.
    assert.deepEqual(modelsNamed("use acme/alpha-mini", all, true), [mini]);
    assert.deepEqual(modelsNamed("use acme alpha.2", all, true), [point]);
    assert.deepEqual(modelsNamed("try z3-mini", all, true), [z3mini]);
    assert.deepEqual(modelsNamed("try z3-mini", all), [z3mini]);
    assert.equal(personNamed("use acme/alpha-mini", alpha, all), false);
    assert.equal(personNamed("use acme/alpha-mini", mini, all), true);
    assert.equal(personNamed("use acme/alpha.2", alpha, all), false);
    assert.equal(personNamed("try z3-mini", z3, all), false);
    // The shorter one is named on its own, and next to the longer one.
    assert.deepEqual(modelsNamed("use acme/alpha", all, true), [alpha]);
    assert.deepEqual(modelsNamed("try z3, not z3-mini", all, true), [z3, z3mini]);
    assert.equal(personNamed("use acme/alpha", alpha, all), true);
    assert.equal(personNamed("try z3, then z3-mini", z3, all), true);
    // Where the longer model is not there, its words name the shorter one as before.
    assert.equal(personNamed("try z3-mini", z3, [z3]), true);
});

test("matching reads a text once, then looks only where a model's name could start", () => {
    const models = Array.from({ length: 200 }, (_, index) =>
        model("acme", `zeta-${String(index)}-mini`, `Zeta ${String(index)} Mini`),
    );

    // How many of the text's words matching looks at, once it is read: counted, not timed.
    const looks = (filler: number) => {
        const text = indexed(
            `${"so it goes, and ".repeat(filler)}use zeta-7-mini, then zeta-8-mini`,
        );
        let reads = 0;
        const counted: Indexed = {
            ...text,
            words: new Proxy(text.words, {
                get(target, key, receiver) {
                    if (typeof key === "string" && /^\d+$/.test(key)) {
                        reads += 1;
                    }

                    return Reflect.get(target, key, receiver);
                },
            }),
        };

        assert.equal(personNamed(counted, models[7]!, models), true);
        assert.deepEqual(modelsNamed(counted, models, true), [models[7], models[8]]);

        return reads;
    };

    const few = looks(100);

    assert.ok(few > 0, "it looks where the names are");
    // Ten times the words, not one look more: the cost is reading the text, not the text times the models.
    assert.equal(looks(1000), few);
});

test("who pays is named after on, via, or the like, not by everyday words", () => {
    const names: Record<string, string> = {
        "acme-go": "Acme Go",
        "kiwi-coding": "Kiwi Coding",
        "zeta-gateway": "Zeta AI Gateway",
        "hub-copilot": "Hub Copilot",
        kiwi: "Kiwi",
    };
    const at = Object.keys(names).map((provider) => model(provider, "kiwi-k3", "Kiwi K3"));
    const pays = (text: string) =>
        at
            .filter((each) => personNamed(text, each, at, (provider) => names[provider]!))
            .map((each) => each.provider);

    // A provider's word as an everyday word picks none of them, after "on" or "with" too.
    for (const text of [
        "use Kiwi K3",
        "use Kiwi K3, go ahead",
        "use Kiwi K3 for the coding task",
        "use Kiwi K3 via the AI gateway",
        "write the server with Go using Kiwi K3",
        "use Kiwi K3 and push it on hub",
        "use Kiwi K3 from coding notes",
    ]) {
        assert.deepEqual(pays(text), [], text);
    }

    // Its whole name or id after on, via, through, and the like does; of two from the same word, the longer one.
    assert.deepEqual(pays("use Kiwi K3 on Acme Go"), ["acme-go"]);
    assert.deepEqual(pays("use Kiwi K3 on Kiwi Coding"), ["kiwi-coding"]);
    assert.deepEqual(pays("use Kiwi K3 on Kiwi"), ["kiwi"]);
    assert.deepEqual(pays("use Kiwi K3 via Zeta AI Gateway"), ["zeta-gateway"]);
    assert.deepEqual(pays("use Kiwi K3 through acme-go"), ["acme-go"]);
    assert.deepEqual(pays("push it on Hub Copilot with Kiwi K3"), ["hub-copilot"]);
});

test("a two-character short name counts only with its family's word in the same message", () => {
    const zeta = model("acme", "zeta-z9", "Zeta Z9");
    const v3 = model("acme", "acme-v3", "Acme V3");
    const v4 = model("acme", "acme-v4", "Acme V4");
    const m3 = model("acme", "acme-m3", "Acme-M3");
    const all = [zeta, v3, v4, m3];

    // Without it, they are ordinary codes, in a person's words or PiP's own: they name nothing.
    for (const text of [
        "generate ids with uuid v4",
        "my M3 MacBook is slow",
        "upgrade to Tailwind v3",
        "use Z9",
        "zeta's Z9s are here",
    ]) {
        assert.deepEqual(modelsNamed(text, all, true), [], text);
    }

    // With it, in the same message, they name it.
    assert.deepEqual(modelsNamed("use Zeta's Z9", all, true), [zeta]);
    assert.deepEqual(modelsNamed("zeta: use Z9 for it", all, true), [zeta]);
    assert.equal(personNamed(indexed(["hello", "zeta: use Z9 for it"]), zeta, all), true);
    // In another message, they do not.
    assert.deepEqual(modelsNamed(indexed(["I like zeta", "use Z9"]), all, true), []);
    assert.equal(personNamed(indexed(["I like zeta", "use Z9"]), zeta, all), false);
});

test("a model's name, and who pays after on or via, stay in one message", () => {
    const four = model("acme", "zeta-4o", "Zeta 4o");
    const nano = model("acme", "zeta-5-nano", "Zeta 5 Nano");
    const all = [four, nano];

    // From the end of one message into the start of the next, they name nothing.
    for (const messages of [
        ["I like zeta", "4o apps"],
        ["please use zeta", "5 nano is fine"],
    ]) {
        assert.deepEqual(modelsNamed(indexed(messages), all, true), [], messages.join(" | "));
    }

    // In one message, they do.
    assert.deepEqual(modelsNamed(indexed(["hello", "I like zeta 4o"]), all, true), [four]);
    assert.deepEqual(modelsNamed(indexed(["use zeta 5 nano", "thanks"]), all, true), [nano]);

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

    // Nor do a version or a written word that carries on, known here or not: those are other models.
    for (const text of ["use zeta-5.2", "use zeta-5o"]) {
        assert.deepEqual(modelsNamed(text, signedIn, true, known), [], text);
    }

    // Said on its own, or beside the longer one, it is named.
    assert.deepEqual(modelsNamed("use zeta-5", signedIn, true, known), [zeta]);
    assert.deepEqual(modelsNamed("zeta-5, not zeta-5-nano", signedIn, true, known), [zeta]);
    assert.equal(personNamed("use Zeta 5 for it", zeta, signedIn, undefined, known), true);
});

test("a model's usual short name names it, as it is written; ordinary words name no model", () => {
    const q4 = model("acme", "q4-mini");
    const kiwi = model("acme", "kiwi-k3", "Kiwi K3");
    const zeta = model("acme", "zeta-5-mini", "Zeta 5 Mini");
    const nova = model("acme", "nova-4o", "Nova 4o");
    const lyra = model("acme", "lyra-opus-4-5", "Lyra Opus 4.5");
    const gem = model("acme", "gem-2.5-flash", "Gem 2.5 Flash");
    const rho = model("acme", "rho-3-haiku", "Rho 3 Haiku");
    const all = [q4, kiwi, zeta, nova, lyra, gem, rho];

    // Its name without its first word: a version and a word, or a word first, and two characters with its family's word.
    assert.deepEqual(modelsNamed("use Kiwi's K3", all, true), [kiwi]);
    assert.deepEqual(modelsNamed("nova: try 4o", all, true), [nova]);
    assert.deepEqual(modelsNamed("use 2.5 Flash", all, true), [gem]);
    assert.deepEqual(modelsNamed("use 2.5-flash", all, true), [gem]);
    assert.equal(personNamed("kiwi, use K3 for the review", kiwi, all), true);
    assert.equal(personNamed("use opus 4.5", lyra, all), true);

    // The same words written otherwise, or a bare number and a word, are ordinary text.
    for (const text of [
        "Build 4 mini apps",
        "Build 5 mini apps",
        "write 3 haiku poems",
        "teach K-3 classes",
        "meet at 4 o'clock",
        "pages 2-5 flash drives",
        "use 2.5",
    ]) {
        assert.deepEqual(modelsNamed(text, all, true), [], text);
    }

    assert.equal(personNamed("Build 4 mini apps", q4, all), false);
    assert.equal(personNamed("teach K-3 classes", kiwi, all), false);
    // Spelled out, each is named.
    assert.deepEqual(
        modelsNamed("use q4-mini, Kiwi K3, zeta-5-mini, nova-4o, or rho-3-haiku", all, true),
        [q4, kiwi, zeta, nova, rho],
    );
});

test("PiP's prompt puts checking before acting, and never picking a model", async () => {
    const id = await pip();

    await say(app, id, "hello");
    assert.match(prompt, /be dependable before fast/);
    assert.match(prompt, /Check before you act/);
    assert.match(prompt, /Never send one message to several sessions without checking each/);
    assert.match(prompt, /Say only what your tools showed you just now/);
    assert.match(prompt, /run the checks and tests/);
    assert.match(prompt, /Never choose a model/);
    assert.doesNotMatch(prompt, /just do it/);
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

test("PiP takes its person's bare answer to which provider pays, right after it asked, and nothing else", async () => {
    const id = await pip();
    const z8 = (provider: string) => ({ model: `${provider}/faux-z8` });
    const twice = /more than one signed-in provider has/;

    // Faux Z8 is at two providers: PiP is told to ask which one pays.
    const ask = async (on = id) => {
        await say(app, on, "start a session on faux z8 for the review");
        await assert.rejects(app.pip.start(on, z8("hub-copilot")), twice);
    };

    // Everyday words, one word of the name, or a provider it did not ask about, answer nothing.
    for (const reply of ["sure", "go", "Copilot", "Unsigned"]) {
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

    // A question from before Start fresh is not the one answered, even by the first thing said after it: the model named
    // only in a webhook's instructions they set up, so it is named after Start fresh too, with a message of theirs before
    // the question, or none.
    const hook = await app.hooks.add(owner(app), id, {
        name: "reviews",
        instructions: "use faux z8 for every review",
    });

    try {
        for (const earlier of ["hello", undefined]) {
            await pip();

            if (earlier !== undefined) {
                await say(app, id, earlier);
            }

            await assert.rejects(app.pip.start(id, z8("hub-copilot")), twice);
            await app.commands.reset(id, owner(app), undefined);
            await say(app, id, "Hub Copilot");
            await assert.rejects(
                app.pip.start(id, z8("hub-copilot")),
                twice,
                earlier ?? "no message before",
            );
        }

        // Without Start fresh between, the same answer picks it.
        await pip();
        await assert.rejects(app.pip.start(id, z8("hub-copilot")), twice);
        await say(app, id, "Hub Copilot");
        const answered = await app.pip.start(id, z8("hub-copilot"));

        assert.equal((await app.agentState(answered))?.model?.provider, "hub-copilot");
    } finally {
        await app.hooks.remove(owner(app), hook.id);
    }
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

test("PiP takes a longer model's name for that model only", async () => {
    const id = await pip();
    const session = Number(await newSession(app));

    await app.pip.read(id, session);
    await say(app, id, "start a session on faux-2-mini");
    await assert.rejects(
        app.pip.start(id, { model: "faux/faux-2" }),
        /Your person did not name faux\/faux-2\. Models are theirs to choose/,
    );
    await assert.rejects(
        app.pip.send(id, session, "Spawn a reviewer subagent on faux-2.", false, "longer-1"),
        /names faux\/faux-2, which your person did not name/,
    );
    const made = await app.pip.start(id, { model: "faux/faux-2-mini" });

    assert.equal((await app.agentState(made))?.model?.modelId, "faux-2-mini");
});

test("PiP takes the name of a model not signed in for no shorter one that is", async () => {
    const id = await pip();
    const session = Number(await newSession(app));

    assert.equal(
        app.models.getAvailableSnapshot().some((each) => each.id === "faux-2-pro"),
        false,
        "known, not signed in",
    );
    await app.pip.read(id, session);
    await say(app, id, "start a session on faux-2-pro");
    await assert.rejects(
        app.pip.start(id, { model: "faux/faux-2" }),
        /Your person did not name faux\/faux-2\. Models are theirs to choose/,
    );
    await assert.rejects(
        app.pip.send(id, session, "Spawn a reviewer subagent on faux-2.", false, "unsigned-1"),
        /names faux\/faux-2, which your person did not name/,
    );
});

test("PiP takes a two-character short name only with its family's word in the same message", async () => {
    const id = await pip();

    await say(app, id, "I run faux for everything");
    await say(app, id, "start a session on Q7");
    await assert.rejects(
        app.pip.start(id, { model: "faux/faux-q7" }),
        /did not name faux\/faux-q7/,
    );
    await say(app, id, "the faux one, Q7, please");
    const made = await app.pip.start(id, { model: "faux/faux-q7" });

    assert.equal((await app.agentState(made))?.model?.modelId, "faux-q7");
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
