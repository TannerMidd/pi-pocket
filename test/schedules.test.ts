// Scheduled messages: reading times as people write them, and durable tasks that send them later, across restarts.
import {
    type App,
    cleanUp,
    context,
    lastText,
    newSession,
    openApp,
    owner,
    recordCost,
    root,
    scriptedModel,
    until,
} from "./helpers.ts";
import assert from "node:assert/strict";
import { join } from "node:path";
import { after, before, test } from "node:test";
import type { FauxResponseStep } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import type { ConversationId } from "@earendil-works/pi-durable";
import { AuthorsDoc, ChatDoc, ScheduleDoc } from "../src/server/docs.ts";
import {
    describeMoment,
    describeRepeat,
    nextClockTime,
    parseWhen,
    zonedMoment,
} from "../src/server/when.ts";

const iso = (moment: number) => new Date(moment).toISOString();
/** Sunday, October 4, 2026, 10:00 in Chicago (15:00 UTC). */
const sunday = Date.UTC(2026, 9, 4, 15, 0);
const chicago = "America/Chicago";

test("times read the way people write them, in their time zone", () => {
    const when = (text: string) => {
        const parsed = parseWhen(text, sunday, chicago);

        return [
            iso(parsed.next),
            parsed.every === undefined ? "once" : describeRepeat(parsed.every),
            parsed.rest,
        ];
    };

    assert.deepEqual(when("in 30m check the build"), [
        "2026-10-04T15:30:00.000Z",
        "once",
        "check the build",
    ]);
    assert.deepEqual(when("in 1.5 hours x"), ["2026-10-04T16:30:00.000Z", "once", "x"]);
    assert.deepEqual(
        when("7:00 x"),
        ["2026-10-05T12:00:00.000Z", "once", "x"],
        "7:00 has passed today: tomorrow",
    );
    assert.deepEqual(when("7pm x"), ["2026-10-05T00:00:00.000Z", "once", "x"]);
    assert.deepEqual(when("Tomorrow 9am x"), ["2026-10-05T14:00:00.000Z", "once", "x"]);
    assert.deepEqual(when("fri 17:30 x"), ["2026-10-09T22:30:00.000Z", "once", "x"]);
    assert.deepEqual(when("every 2h x"), ["2026-10-04T17:00:00.000Z", "every 2 hours", "x"]);
    assert.deepEqual(when("every day 8:00 x"), [
        "2026-10-05T13:00:00.000Z",
        "every day at 08:00",
        "x",
    ]);
    assert.deepEqual(when("every weekday 8:00 x"), [
        "2026-10-05T13:00:00.000Z",
        "weekdays at 08:00",
        "x",
    ]);
    assert.deepEqual(when("every tues,thursday 9:00 x"), [
        "2026-10-06T14:00:00.000Z",
        "tue, thu at 09:00",
        "x",
    ]);
    assert.deepEqual(
        when("every weekend 10am x"),
        ["2026-10-10T15:00:00.000Z", "weekends at 10:00", "x"],
        "10:00 today is now, not after it",
    );

    for (const [text, problem] of [
        ["every 5m x", /at most every 10 minutes/],
        ["every 2 days 8:00 x", /not both/],
        ["every 2 days at 8:00 x", /not both/],
        ["today 9:00 x", /09:00 today has passed/],
        ["in 0.001h x", /Say when/],
        ["soon x", /Say when/],
        ["25:00 x", /Say when/],
        ["13pm x", /Say when/],
        ["every fun 9:00 x", /Say when/],
        ["in 400 days x", /a year ahead/],
    ] as const) {
        assert.throws(() => parseWhen(text, sunday, chicago), problem, text);
    }
});

test("clock times hold across daylight saving changes", () => {
    assert.equal(
        iso(zonedMoment(2026, 3, 8, 2, 30, chicago)),
        "2026-03-08T08:30:00.000Z",
        "skipped 2:30 becomes 3:30",
    );
    assert.equal(
        iso(zonedMoment(2026, 11, 1, 1, 30, chicago)),
        "2026-11-01T06:30:00.000Z",
        "a 1:30 that happens twice is the first",
    );
    assert.equal(iso(zonedMoment(2026, 10, 4, 8, 0, "Europe/Berlin")), "2026-10-04T06:00:00.000Z");
    // Every day at 8:00 in Chicago, from the Saturday before clocks go back.
    const saturday = nextClockTime(Date.UTC(2026, 9, 31, 12), "08:00", undefined, chicago);
    const sundayAfter = nextClockTime(saturday, "08:00", undefined, chicago);

    assert.deepEqual(
        [iso(saturday), iso(sundayAfter)],
        ["2026-10-31T13:00:00.000Z", "2026-11-01T14:00:00.000Z"],
    );
    assert.equal(describeMoment(Date.UTC(2026, 9, 5, 12), chicago, sunday), "Mon 07:00");
    assert.equal(describeMoment(Date.UTC(2026, 9, 20, 12), chicago, sunday), "Oct 20 07:00");
});

/** Pi schedules its own follow-up, lists, and cancels, as the last message asks. */
const route: FauxResponseStep = (request) => {
    const { role, text } = lastText(request as never);
    const call = (args: Parameters<typeof fauxToolCall>[1]) =>
        fauxAssistantMessage([fauxToolCall("schedule", args)], { stopReason: "toolUse" });

    if (role === "toolResult") {
        return fauxAssistantMessage([fauxText(`tool said: ${text}`)]);
    }

    if (text.endsWith("remind yourself")) {
        return call({ action: "add", when: "in 15m", message: "look at the deploy again" });
    }

    if (text.endsWith("list them")) {
        return call({ action: "list" });
    }

    const cancel = /cancel (\w+)$/.exec(text)?.[1];

    if (cancel !== undefined) {
        return call({ action: "cancel", id: cancel });
    }

    return fauxAssistantMessage([fauxText(`echo: ${text}`)]);
};

const model = scriptedModel(route);
const dataDir = join(root, "data");
let app: App;
/** How far ahead of the real time the server's clock is. */
let ahead = 0;

before(async () => {
    app = await openApp(model, dataDir);
});

after(async () => {
    await app?.close();
    cleanUp();
});

/** Restart the server with its clock `minutes` further ahead. Returns the server's time as it starts. */
async function restartLater(minutes: number): Promise<number> {
    await app.close();
    ahead += minutes * 60_000;
    const offset = ahead;
    const startsAt = Date.now() + offset;

    app = await openApp(model, dataDir, () => Date.now() + offset);

    return startsAt;
}

async function say(id: ConversationId, text: string, user = owner(app)): Promise<void> {
    const { submissionId } = await app.commands.submit(id, user, {
        text,
        requestId: crypto.randomUUID(),
    });

    await (await app.harness.submission(submissionId, context))!.wait(context);
}

async function userTexts(id: ConversationId): Promise<string[]> {
    const page = await (await app.harness.conversation(id, context))!.entries(
        {},
        100,
        undefined,
        context,
    );

    return page.items
        .filter((entry) => entry.kind === "pi.user")
        .map((entry) => JSON.stringify(entry.model));
}

const items = async (id: ConversationId) =>
    Object.values((await app.harness.snapshot(ScheduleDoc, id, context))?.items ?? {});

test("a scheduled message goes out at its time, also after a restart, once; a repeat goes back to sleep", async () => {
    const id = await newSession(app);
    const once = await app.commands.schedule(id, owner(app), {
        when: "in 10m check the build",
        zone: "UTC",
    });

    assert.equal(once.text, "check the build");
    assert.equal(once.content, "[scheduled] check the build");
    const repeat = await app.commands.schedule(id, owner(app), {
        when: "every 20m ping",
        zone: "UTC",
    });
    const chat = (await app.harness.snapshot(ChatDoc, id, context))!.messages.map(
        (message) => message.text,
    );

    assert.match(chat[0]!, /^scheduled “check the build” for \w{3} \d\d:\d\d$/);
    assert.equal(chat[1], "scheduled “ping” every 20 minutes");

    // Eleven minutes on, after a restart: the first goes out, the repeat waits.
    await restartLater(11);
    await until(
        async () =>
            (await userTexts(id)).some((text) => text.includes("[scheduled] check the build")),
        "the scheduled message to go out",
    );
    await until(async () => (await items(id)).length === 1, "the sent one to be done");
    assert.equal((await items(id))[0]?.id, repeat.id);
    // It went out as the owner's message: who set it up.
    const page = await (await app.harness.conversation(id, context))!.entries(
        {},
        100,
        undefined,
        context,
    );
    const sent = page.items.find(
        (entry) =>
            entry.kind === "pi.user" && JSON.stringify(entry.model).includes("check the build"),
    )!;

    await until(
        async () =>
            (await app.harness.snapshot(AuthorsDoc, id, context))?.entries[String(sent.id)] ===
            owner(app).id,
        "the owner to be its author",
    );
    // A restart in the middle of sending runs that phase again, and it sends with the same request id: Pi Durable
    // takes that message once.
    const conversation = (await app.harness.conversation(id, context))!;

    await conversation.submit(
        {
            type: "input",
            content: once.content,
            whenBusy: "followUp",
            requestId: `u:${owner(app).id}:schedule-${String(once.taskId)}-0`,
        },
        context,
    );
    assert.equal(
        (await userTexts(id)).filter((text) => text.includes("[scheduled] check the build")).length,
        1,
    );

    // Ten minutes later: the repeat goes out once and sleeps until 20 minutes after it went out.
    const sentAt = await restartLater(10);

    await until(async () => (await items(id))[0]?.runs === 1, "the repeat to go out");
    const [next] = await items(id);

    assert.ok(
        next!.next >= sentAt + 20 * 60_000,
        "20 minutes after it went out, not after when it was due",
    );
    // Sent while Pi may still be answering, it waits in the queue a moment before it is in the transcript.
    await until(
        async () => (await userTexts(id)).some((text) => text.includes("[scheduled] ping")),
        "the repeat's message",
    );
    assert.equal(
        (await userTexts(id)).filter((text) => text.includes("[scheduled] ping")).length,
        1,
    );
    assert.equal(
        (await userTexts(id)).filter((text) => text.includes("[scheduled] check the build")).length,
        1,
        "never twice",
    );
    await app.commands.cancelSchedule(id, owner(app), repeat.id);
    assert.deepEqual(await items(id), []);
    await assert.rejects(app.commands.cancelSchedule(id, owner(app), repeat.id), { status: 404 });
});

test("Pi schedules, lists, and cancels its own messages with its tool", async () => {
    const id = await newSession(app);

    await say(id, "remind yourself");
    const [mine] = await items(id);

    assert.equal(mine?.text, "look at the deploy again");
    assert.equal(mine?.by, undefined, "Pi set it");
    await say(id, "list them");
    await say(id, `cancel ${mine!.id}`);
    assert.deepEqual(await items(id), []);
    const said = (await userTexts(id)).join("\n");

    assert.doesNotMatch(said, /\[scheduled\]/);
    const answers = (await (await app.harness.conversation(id, context))!.context(context)).messages
        .map((message) => JSON.stringify(message.content))
        .join("\n");

    assert.match(
        answers,
        new RegExp(`tool said: ${mine!.id}: \\w{3} \\d\\d:\\d\\d · look at the deploy again`),
    );
    assert.match(answers, new RegExp(`tool said: Cancelled ${mine!.id}\\.`));
});

test("a schedule Pi sets up is the work of whom it worked for, and is cancelled once they may not steer", async () => {
    const id = await newSession(app);
    const hal = app.config.addUser("Hal", "guest").user;
    const ida = app.config.addUser("Ida", "guest").user;

    await say(id, "remind yourself", hal);
    await say(id, "remind yourself", ida);
    await say(id, "something else");
    // In no order: the schedules are kept by their ids, which are random.
    const whose = [hal.id, ida.id];

    assert.deepEqual(
        (await items(id))
            .map((each) => [each.by, each.requestedBy])
            .sort((a, b) => whose.indexOf(String(a[1])) - whose.indexOf(String(b[1]))),
        [
            [undefined, hal.id],
            [undefined, ida.id],
        ],
        "Pi's, for Hal and for Ida",
    );
    app.config.updateUser(ida.id, { role: "viewer" });

    await restartLater(16);
    await until(
        async () => (await items(id)).length === 0,
        "Hal's to go out and Ida's to be cancelled",
    );
    await until(() => !app.isBusy(id), "Pi to answer");
    assert.equal(
        app.attribution.requesterOf(id),
        hal.id,
        "the owner wrote last, but Pi works for Hal now",
    );
    const authors = (await app.harness.snapshot(AuthorsDoc, id, context))!;
    const sent = Object.keys(authors.requesters ?? {}).find(
        (entry) => authors.requesters![entry] === hal.id,
    );

    assert.ok(
        sent !== undefined && authors.entries[sent] === undefined,
        "it shows as Pi's message",
    );
    const chat = (await app.harness.snapshot(ChatDoc, id, context))!.messages.map(
        (message) => `${message.name} ${message.text}`,
    );

    assert.ok(
        chat.includes(
            "Pi scheduled “look at the deploy again”, which was cancelled: Ida can no longer steer here.",
        ),
        chat.join("\n"),
    );
});

test("people need the right to steer and a session, and schedules need their extension", async () => {
    const id = await newSession(app);
    const viewer = app.config.addUser("Vee", "viewer").user;

    await assert.rejects(app.commands.schedule(id, viewer, { when: "in 10m x" }), { status: 403 });
    await assert.rejects(app.commands.schedule(id, owner(app), { when: "in 10m" }), {
        status: 400,
        message: /Say what Pi should get/,
    });
    await assert.rejects(
        app.commands.schedule(id, owner(app), { when: "in 10m x", zone: "Mars/Olympus" }),
        { status: 400 },
    );
    const other = await app.harness.createConversation(
        { ownership: { kind: "ownerless" } },
        context,
    );

    await assert.rejects(app.commands.schedule(other.id, owner(app), { when: "in 10m x" }), {
        status: 400,
    });
    await app.setExtensionEnabled(owner(app), "schedules.ts", false);

    try {
        await assert.rejects(app.commands.schedule(id, owner(app), { when: "in 10m x" }), {
            status: 409,
            message: /turned off in Extensions/,
        });
    } finally {
        await app.setExtensionEnabled(owner(app), "schedules.ts", true);
    }
});

test("a schedule is cancelled, with a line in the chat, once its person may not steer anymore or a limit is reached", async () => {
    const id = await newSession(app);
    const gus = app.config.addUser("Gus", "guest").user;

    await app.commands.schedule(id, gus, { when: "in 10m from Gus", zone: "UTC" });
    await app.commands.schedule(id, owner(app), { when: "in 10m from the owner", zone: "UTC" });
    app.config.updateUser(gus.id, { role: "viewer" });
    await app.spend.setSessionBudget(owner(app), id, 1);
    await recordCost(app, id, 2);
    await until(() => app.spend.sessionSpent(id) === 2, "the spend to be known");
    await assert.rejects(app.commands.schedule(id, owner(app), { when: "in 10m one more" }), {
        status: 409,
        message: /spend limit/,
    });

    await restartLater(11);
    await until(async () => (await items(id)).length === 0, "both to be cancelled");
    const chat = (await app.harness.snapshot(ChatDoc, id, context))!.messages.map(
        (message) => `${message.name} ${message.text}`,
    );

    assert.ok(
        chat.includes(
            "Gus scheduled “from Gus”, which was cancelled: they can no longer steer here.",
        ),
        chat.join("\n"),
    );
    assert.ok(
        chat.includes(
            `${owner(app).name} scheduled “from the owner”, which was cancelled: this session reached its $1.00 spend limit.`,
        ),
        chat.join("\n"),
    );
    assert.deepEqual(
        (await userTexts(id)).filter((text) => text.includes("[scheduled]")),
        [],
        "neither went out",
    );
});
