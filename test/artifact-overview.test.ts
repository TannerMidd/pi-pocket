// The artifacts overview: every artifact in every session a person can see, with its current version.
import {
    type App,
    cleanUp,
    context,
    openApp,
    owner,
    root,
    scriptedModel,
    until,
    work,
} from "./helpers.ts";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { join } from "node:path";
import { after, before, test } from "node:test";
import type { ConversationId } from "@earendil-works/pi-durable";
import { Browsers } from "../src/server/browser.ts";
import { findBrowser } from "../src/server/browser/discovery.ts";
import createArtifacts from "../src/server/extensions/artifacts.ts";
import type { PocketHost } from "../src/server/host.ts";
import { createHandler } from "../src/server/http.ts";

let app: App;
let server: Server;
let base: string;
let calls = 0;
const tools = createArtifacts({} as PocketHost).tools!;

async function publish(session: ConversationId, args: Record<string, unknown>) {
    // A version's time is the real one: wait, so that each has a time of its own and "newest first" has one answer.
    await new Promise((resolve) => setTimeout(resolve, 5));

    return tools[0]!.execute(
        args as never,
        {
            conversationId: session,
            taskId: 4321,
            callId: String(++calls),
            agent: async () => ({ cwd: work }),
            snapshot: app.harness.snapshot.bind(app.harness),
            commit: app.harness.commit.bind(app.harness),
        } as never,
        context,
    );
}

before(async () => {
    app = await openApp(scriptedModel());
    app.config.lastModel ??= { provider: "faux", modelId: "faux-1", thinkingLevel: "off" };
    server = createServer(
        createHandler({ app, listen: { host: "127.0.0.1", port: 0 }, restart: () => {} }),
    );
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});

after(async () => {
    server?.closeAllConnections();
    server?.close();
    await app?.close();
    cleanUp();
});

test("each artifact is one entry, with the number of its latest version and how many versions it has", async () => {
    const { id: first } = await app.commands.createSession(owner(app), { cwd: work });
    const { id: second } = await app.commands.createSession(owner(app), { cwd: work });

    await publish(first, { id: "chart", title: "Chart", content: "<p>1</p>" });
    await publish(first, { id: "chart", title: "Chart", content: "<p>2</p>" });
    await publish(first, { id: "chart", title: "Chart", content: "<p>3</p>" });
    await publish(second, { id: "notes", title: "Notes", type: "markdown", content: "# Hi" });

    const list = await app.artifactOverview(owner(app));
    const chart = list.find((entry) => entry.id === "chart" && entry.session === Number(first));
    const notes = list.find((entry) => entry.id === "notes" && entry.session === Number(second));

    assert.equal(chart?.current, 3);
    assert.equal(chart?.versions, 3);
    assert.equal(notes?.current, 1);
    assert.equal(notes?.type, "markdown");
    assert.equal(list.filter((entry) => entry.id === "chart").length, 1);
    // Newest first: notes was published last.
    assert.ok(list.indexOf(notes!) < list.indexOf(chart!));
});

test("a person sees only the artifacts of the sessions shared with them, over the route", async () => {
    const { id: shared } = await app.commands.createSession(owner(app), { cwd: work });
    const { id: hidden } = await app.commands.createSession(owner(app), { cwd: work });

    await publish(shared, { id: "open-one", title: "Open", content: "<p>o</p>" });
    await publish(hidden, { id: "closed-one", title: "Closed", content: "<p>c</p>" });

    const { token } = app.config.addUser("Guest", "guest", [String(shared)]);
    const response = await fetch(new URL("/api/artifacts", base), {
        headers: { authorization: `Bearer ${token}` },
    });
    const ids = ((await response.json()) as { id: string }[]).map((entry) => entry.id);

    assert.equal(response.status, 200);
    assert.deepEqual(ids, ["open-one"]);
});

test("a session whose artifacts cannot be read does not hide the others", async () => {
    const { id: good } = await app.commands.createSession(owner(app), { cwd: work });
    const { id: bad } = await app.commands.createSession(owner(app), { cwd: work });

    await publish(good, { id: "fine", title: "Fine", content: "<p>f</p>" });
    await publish(bad, { id: "doomed", title: "Doomed", content: "<p>d</p>" });

    const snapshot = app.harness.snapshot.bind(app.harness) as (...args: unknown[]) => unknown;
    const log = console.error;

    // The failing read is on purpose: the test keeps its message out of the output.
    console.error = () => {};

    app.harness.snapshot = (async (doc: unknown, id: ConversationId, ...rest: unknown[]) => {
        if (id === bad) {
            throw new Error("unreadable");
        }

        return snapshot(doc, id, ...rest);
    }) as never;

    try {
        const ids = (await app.artifactOverview(owner(app))).map((entry) => entry.id);

        assert.ok(ids.includes("fine"));
        assert.ok(!ids.includes("doomed"));
    } finally {
        app.harness.snapshot = snapshot as never;
        console.error = log;
    }
});

test(
    "the sheet frames each session's artifacts in a card of its own, with the session's name and count apart",
    { skip: findBrowser() === undefined ? "no Chromium-based browser on this machine" : false },
    async () => {
        const { id } = await app.commands.createSession(owner(app), { cwd: work });

        await publish(id, { id: "sheet-page", title: "Sheet page", content: "<p>one</p>" });

        const browsers = new Browsers({
            dataDir: mkdtempSync(join(root, "all-artifacts-ui-")),
            load: async () => undefined,
            save: () => {},
        });

        try {
            const page = await browsers.open(1);
            const inPage = async <T>(script: string) =>
                JSON.parse(await page.evaluate(script)) as T;

            await page.navigate(`${base}/login?token=${encodeURIComponent(app.config.ownerToken)}`);
            await page.navigate(`${base}/s/${id}`);
            await until(
                async () =>
                    await inPage<boolean>(
                        `return JSON.stringify(document.querySelector(".composer") !== null)`,
                    ),
                "the session",
            );
            await inPage(
                `(await import("/store.js")).openSheet({ type: "all-artifacts" }); return "null"`,
            );
            await until(
                async () =>
                    await inPage<boolean>(
                        `return JSON.stringify(document.querySelector(".overview-row") !== null)`,
                    ),
                "the list",
            );

            // Its styles are its own: Running now's sheet, whose frame it once borrowed, is gone.
            const look = await inPage<{ border: string; display: string; gap: string }>(`
                const group = getComputedStyle(document.querySelector(".overview-row").parentElement);
                const head = getComputedStyle(document.querySelector(".overview-row").parentElement.firstElementChild);

                return JSON.stringify({ border: group.borderTopWidth, display: head.display, gap: head.columnGap });
            `);

            assert.equal(look.border, "1px");
            assert.equal(look.display, "flex");
            assert.notEqual(look.gap, "normal");
        } finally {
            await browsers.closeAll({ final: true });
        }
    },
);
