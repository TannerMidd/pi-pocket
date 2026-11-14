// Goal's extension routes and controls use a throwaway app, never the running server or its data.
import {
    cleanUp,
    context,
    newSession,
    openApp,
    owner,
    root,
    scriptedModel,
    until,
    type App,
} from "./helpers.ts";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { fauxAssistantMessage } from "@earendil-works/pi-ai/providers/faux";
import type { ConversationId } from "@earendil-works/pi-durable";
import { Browsers } from "../src/server/browser.ts";
import { findBrowser } from "../src/server/browser/discovery.ts";
import type { BrowserPage } from "../src/server/browser/page.ts";
import { createHandler } from "../src/server/http.ts";
import { ObjectiveGoalDoc } from "../src/server/objective-goals.ts";

let app: App;
let server: Server;
let base: string;
let browsers: Browsers;
let page: BrowserPage;
let viewerToken: string;
let restrictedToken: string;
let workTurns = 0;

before(async () => {
    app = await openApp(
        scriptedModel((request) => {
            const evaluator = request.messages.some(
                (message) =>
                    message.role === "system" &&
                    JSON.stringify(message.content).includes("[Pi Pocket Goal Evaluator]"),
            );

            if (evaluator) {
                return fauxAssistantMessage(
                    JSON.stringify({
                        verdict: "blocked",
                        reason: "A test credential is required.",
                    }),
                );
            }

            workTurns++;

            return fauxAssistantMessage(
                "The fixture needs a test credential to run the final check.",
            );
        }),
    );
    viewerToken = app.config.addUser("Goal viewer", "viewer").token;
    restrictedToken = app.config.addUser("Restricted viewer", "viewer", []).token;
    server = createServer(
        createHandler({ app, listen: { host: "127.0.0.1", port: 0 }, restart: () => {} }),
    );
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});

after(async () => {
    await browsers?.closeAll({ final: true });
    server?.closeAllConnections();
    server?.close();
    await app?.close();
    cleanUp();
});

async function session() {
    const id = await newSession(app);

    await app.commands.updateSession(id, owner(app), { title: "Goal UI fixture" });

    return id;
}

const goalRequest = (
    id: ConversationId,
    body?: unknown,
    token = app.config.ownerToken,
    header = true,
) =>
    fetch(`${base}/api/x/objective-goal/goals/${id}`, {
        method: body === undefined ? "GET" : "POST",
        headers: {
            authorization: `Bearer ${token}`,
            "content-type": "application/json",
            ...(header ? { "x-pocket": "1" } : {}),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
const command = (args: string, revision: string | null) => ({
    args,
    revision,
    requestId: crypto.randomUUID(),
});

async function idle(id: ConversationId) {
    await (await app.conversation(id)).waitForIdle(context);
}

test("the extension exposes only authorized goal state and rejects invalid and stale mutations", async () => {
    const id = await session();
    const empty = await goalRequest(id);

    assert.equal(empty.status, 200);
    assert.deepEqual(await empty.json(), { goal: null, canSteer: true });
    assert.equal((await goalRequest(id, undefined, app.config.ownerToken, false)).status, 403);
    assert.equal((await goalRequest(id, undefined, restrictedToken)).status, 404);
    assert.equal((await goalRequest(id, { args: "pause", requestId: "no-revision" })).status, 400);
    assert.equal((await goalRequest(id, command("pause", null), viewerToken)).status, 405);
    assert.equal((await goalRequest(id, command("--budget off pause", null))).status, 200);
    await idle(id);
    const shown = await (await goalRequest(id)).json();

    assert.equal(
        shown.goal.objective,
        "pause",
        "an objective that is a command word still starts correctly",
    );
    assert.equal(shown.goal.status, "blocked");
    assert.equal(shown.goal.reason, "A test credential is required.");
    assert.deepEqual(
        Object.keys(shown.goal).sort(),
        [
            "revision",
            "objective",
            "status",
            "budget",
            "tokens",
            "turns",
            "activeMs",
            "evaluator",
            "reason",
        ].sort(),
    );
    assert.equal((await (await goalRequest(id, undefined, viewerToken)).json()).canSteer, false);
    const edited = await goalRequest(
        id,
        command("edit Verify the new outcome", shown.goal.revision),
    );

    assert.equal(edited.status, 200);
    assert.equal((await edited.json()).goal.objective, "Verify the new outcome");
    const stale = await goalRequest(id, command("clear", shown.goal.revision));

    assert.equal(stale.status, 409);
    assert.match((await stale.json()).error, /changed in another tab/);
    assert.equal((await (await goalRequest(id)).json()).goal.objective, "Verify the new outcome");
});

test("the UI route replays a start once, honors take-turns, and goes away with its extension", async () => {
    const id = await session();
    const body = command("--budget off Verify the fixture", null);
    const before = workTurns;

    assert.equal((await goalRequest(id, body)).status, 200);
    await idle(id);
    assert.equal((await goalRequest(id, body)).status, 200);
    await idle(id);
    assert.equal(workTurns, before + 1);
    const guest = app.config.addUser("Goal driver", "guest");

    await app.collab.turns(id, owner(app), { action: "on" });
    const guestView = await (await goalRequest(id, undefined, guest.token)).json();

    assert.equal(guestView.canSteer, false);
    assert.equal(
        (await goalRequest(id, command("clear", guestView.goal.revision), guest.token)).status,
        409,
    );
    await app.collab.turns(id, owner(app), { action: "off" });
    await app.setExtensionEnabled(owner(app), "objective-goal.ts", false);
    assert.equal((await goalRequest(id)).status, 404);
    await app.setExtensionEnabled(owner(app), "objective-goal.ts", true);
});

const browserTest = { skip: findBrowser() === undefined ? "no Chromium browser" : false };
const evaluate = <T>(script: string) =>
    page.evaluate(`return JSON.stringify(${script})`).then((text) => JSON.parse(text) as T);
const has = (selector: string) =>
    evaluate<boolean>(`!!document.querySelector(${JSON.stringify(selector)})`);
const contents = (selector: string) =>
    evaluate<string>(`document.querySelector(${JSON.stringify(selector)})?.textContent ?? ""`);

const button = async (label: string) => {
    await until(
        () =>
            evaluate<boolean>(
                `[...document.querySelectorAll(".x-goal-sheet button")].some((b) => b.textContent.trim() === ${JSON.stringify(label)} && !b.disabled)`,
            ),
        `enabled ${label}`,
    );
    await page.evaluate(
        `document.querySelectorAll(".x-goal-sheet button").forEach((b) => { if (b.textContent.trim() === ${JSON.stringify(label)}) b.click(); }); return "null";`,
    );
};

async function settled() {
    await until(
        () =>
            evaluate<boolean>(
                `document.getAnimations().filter((a) => a.effect?.getTiming().iterations !== Infinity).every((a) => a.playState === "finished")`,
            ),
        "sheet animations",
    );
}

test(
    "a phone can create, edit, pause, resume, summarize, and delete a visible goal without losing the conversation",
    browserTest,
    async () => {
        const id = await session();

        browsers = new Browsers({
            dataDir: mkdtempSync(join(root, "goal-ui-browser-")),
            load: async () => undefined,
            save: () => {},
        });
        page = await browsers.open(1);
        await page.setViewport({ width: 390, height: 844, scale: 1, mobile: true });
        await page.navigate(
            `${base}/login?token=${encodeURIComponent(app.config.ownerToken)}&next=/s/${id}`,
        );
        await until(() => has('.composer-row button[title="Goal"]'), "Goal composer button");
        await page.click({ selector: '.composer-row button[title="Goal"]' });
        await until(() => has("#x-goal-objective"), "new objective field");
        await settled();
        await page.fill(
            { selector: "#x-goal-objective" },
            "Verify mobile authentication without regressions",
        );
        await button("Start goal");
        await idle(id);
        await until(
            async () => (await contents(".x-goal-bar")).includes("Blocked"),
            "blocked goal bar",
        );
        assert.match(await contents(".x-goal-bar"), /Verify mobile authentication/);
        assert.equal(
            await evaluate<boolean>(`document.documentElement.scrollWidth <= innerWidth`),
            true,
        );
        await button("Edit goal");
        await page.fill(
            { selector: "#x-goal-objective" },
            "Verify the revised authentication flow",
        );
        await button("Save goal");
        await until(
            async () => (await contents(".x-goal-bar")).includes("revised authentication"),
            "saved objective in the bar",
        );
        await button("Edit goal");
        await page.fill({ selector: "#x-goal-objective" }, "My unsaved edit");
        await app.objectiveGoals.command(
            id,
            owner(app),
            "edit Another tab changed the objective",
            crypto.randomUUID(),
        );
        await until(
            async () =>
                (await contents(".x-goal-sheet")).includes("changed while you were editing"),
            "edit conflict",
        );
        assert.equal(
            await evaluate<string>('document.querySelector("#x-goal-objective").value'),
            "My unsaved edit",
        );
        assert.equal(
            await evaluate<boolean>(
                '[...document.querySelectorAll("button")].find((b) => b.textContent.trim() === "Save goal").disabled',
            ),
            true,
        );
        await button("Cancel");
        await page.click({ selector: ".x-goal-settings summary" });
        await page.fill({ selector: "#x-goal-budget" }, "12000");
        await button("Save budget");
        await until(
            async () => (await app.objectiveGoals.view(id, owner(app))).goal?.budget === 12000,
            "saved budget",
        );
        await app.harness.commit(async (tx) => {
            const doc = await tx.doc(ObjectiveGoalDoc, id);

            doc.goal!.status = "budget";
            doc.goal!.tokens = 12000;
        }, context);
        await until(
            async () => (await contents(".x-goal-sheet")).includes("Adjust budget"),
            "budget review action",
        );
        assert.equal(await has('.x-goal-bar button[aria-label="Resume goal"]'), false);
        await button("Adjust budget");
        assert.equal(
            await evaluate<boolean>('document.querySelector(".x-goal-settings").open'),
            true,
        );
        await page.fill({ selector: "#x-goal-budget" }, "24000");
        await button("Save budget");
        await until(
            async () => (await contents(".x-goal-sheet")).includes("Resume goal"),
            "resume enabled after raising the budget",
        );
        await button("Summarize progress in PiP");
        await until(
            async () => (await contents(".x-goal-sheet")).includes("summary request is ready"),
            "summary draft in PiP",
        );
        // Close PiP, which the summary action opened as a draft, without sending it.
        await page.evaluate(`(await import("/pip.js")).closePip(); return "null";`);
        await settled();
        await page.press("Escape");
        await until(async () => !(await has(".x-goal-sheet")), "goal sheet closed");
        await app.harness.commit(async (tx) => {
            const doc = await tx.doc(ObjectiveGoalDoc, id);

            doc.goal!.status = "active";
            doc.goal!.activeSince = app.now();
        }, context);
        await until(() => has('.x-goal-bar button[aria-label="Pause goal"]'), "pause control");
        await page.click({ selector: '.x-goal-bar button[aria-label="Pause goal"]' });
        await until(async () => (await contents(".x-goal-bar")).includes("Paused"), "paused loop");
        const turns = workTurns;

        await page.click({ selector: '.x-goal-bar button[aria-label="Resume goal"]' });
        await until(() => workTurns > turns, "resumed work turn");
        await idle(id);
        await until(
            async () => (await contents(".x-goal-bar")).includes("Blocked"),
            "new evaluator result",
        );
        await page.click({ selector: ".x-goal-overview" });
        await until(() => has(".x-goal-sheet"), "goal details reopened");
        await settled();
        await button("Delete goal");
        assert.ok(
            (await app.objectiveGoals.view(id, owner(app))).goal,
            "deletion needs confirmation",
        );
        await button("Keep goal");
        await button("Delete goal");
        await button("Confirm delete goal");
        await until(async () => !(await has(".x-goal-bar")), "goal bar removed");
        assert.equal((await app.objectiveGoals.view(id, owner(app))).goal, null);
        assert.ok(
            (await (await app.conversation(id)).context(context)).messages.length > 0,
            "the conversation stays",
        );
    },
);
