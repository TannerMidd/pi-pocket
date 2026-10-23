import {
    type App,
    cleanUp,
    lastText,
    modelTexts,
    newSession,
    openApp,
    owner,
    say,
    scriptedModel,
    until,
} from "./helpers.ts";
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";

let app: App;
/** Every request the model got, as JSON: what each prompt and message said. */
const requests: string[] = [];

before(async () => {
    const model = scriptedModel((request) => {
        const { text, role } = lastText(request as never);

        requests.push(JSON.stringify(request));

        if (role === "user" && text.includes("START_A_TEAM")) {
            return fauxAssistantMessage(
                [fauxToolCall("team", { action: "start", message: "Count the files." })],
                { stopReason: "toolUse" },
            );
        }

        return fauxAssistantMessage([fauxText("Done.")]);
    });

    app = await openApp(model);
    await app.setExtensionEnabled(owner(app), "agent-teams.ts", true);
});
after(async () => {
    await app?.close();
    cleanUp();
});

// With no count limit, the words are what keeps two agents from thanking each other without end (the spend limit is the brake).
test("the team tool and the linked message tell Pi to answer once and stop when the work is done", async () => {
    const id = await newSession(app);

    await say(app, id, "START_A_TEAM");
    const started = app.sessions().find((session) => session.linkedFrom?.id === Number(id));

    assert.ok(started, "a linked session");
    const source = (await modelTexts(app, id)).join("\n");

    assert.match(source, /ask it to send back what it finds, once/);
    assert.match(source, /Do not reply to a message that asks for nothing/);

    await until(
        async () =>
            (await modelTexts(app, started.id as never)).some((text) =>
                text.includes("<linked-session-message>"),
            ),
        "the first message",
    );
    const target = (await modelTexts(app, started.id as never)).join("\n");

    assert.match(
        target,
        /do not reply to thanks, acknowledgements, or messages that ask for nothing/,
    );
    assert.match(target, /stop when the work is done/);
});

test("agents write to each other in ASD-STE100: team messages, replies, and subagent tasks", async () => {
    const id = await newSession(app);

    requests.length = 0;
    await say(app, id, "START_A_TEAM");
    const started = app.sessions().findLast((session) => session.linkedFrom?.id === Number(id));

    assert.ok(started, "a linked session");
    await until(
        async () =>
            (await modelTexts(app, started.id as never)).some((text) =>
                text.includes("<linked-session-message>"),
            ),
        "the first message",
    );
    const all = requests.join("\n");

    // The source: its team messages, and its tasks for subagents.
    assert.match(all, /Write messages in ASD-STE100 \(Simplified Technical English\) at about 80%/);
    assert.match(
        all,
        /Write each message to a subagent \(spawn and send\) in ASD-STE100 \(Simplified Technical English\) at about 80%/,
    );
    assert.match(all, /ask for the report in it too/);
    assert.match(all, /ask for answers in it too/);
    // The linked session: the message asks for the reply in ASD-STE100, under a marker its prompt names.
    const target = (await modelTexts(app, started.id as never)).join("\n");

    assert.match(target, /\[via linked session session-[^\]]+\] Message from linked session/);
    assert.match(
        target,
        /Write any reply to that address in ASD-STE100 \(Simplified Technical English\)/,
    );
    // The linked session's own requests (those with its message) carry the rule for that marker.
    const own = requests.filter((each) => each.includes("<linked-session-message>")).join("\n");

    assert.match(
        own,
        /A message with the marker .*\[via linked session …\].* comes from another agent \(PiP/,
    );
});

test("with a list and a model that is not on it, the prompt lists the models with facts, and a start without a model is told to choose", async () => {
    const me = owner(app);

    try {
        // The session is on faux-1; only faux-2 is listed.
        await app.setSubagentModels(me, ["faux/faux-2"]);
        const id = await newSession(app);

        requests.length = 0;
        await say(app, id, "START_A_TEAM");
        const all = requests.join("\n");

        assert.match(all, /- faux\/faux-2: /);
        assert.match(all, /Match the model to the work/);
        assert.match(all, /Your model is not on the list, so model is required/);
        assert.equal(
            app.sessions().filter((session) => session.linkedFrom?.id === Number(id)).length,
            0,
            "nothing started without a model",
        );

        // The tool's refusal tells it to choose from the list, not to stop and ask the person.
        const refusal = all.match(/A model is required[^"]*/)?.[0] ?? "";

        assert.match(refusal, /faux\/faux-2/);
        assert.doesNotMatch(refusal, /stop and tell the person/);
    } finally {
        await app.setSubagentModels(me, []);
    }
});
