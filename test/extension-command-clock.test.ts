// The documented clock is a real drop-in: a person changes its preference, and its model tool reads the same state.
import {
    cleanUp,
    lastText,
    modelTexts,
    newSession,
    openApp,
    owner,
    say,
    scriptedModel,
    type App,
} from "./helpers.ts";
import assert from "node:assert/strict";
import { copyFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import type { ConversationId } from "@earendil-works/pi-durable";
import { createHandler } from "../src/server/http.ts";

const requests: string[] = [];
let app: App;
let server: Server;
let base = "";

before(async () => {
    app = await openApp(
        scriptedModel((request) => {
            requests.push(JSON.stringify(request));
            const { role, text } = lastText(request as never);

            if (role === "toolResult") {
                return fauxAssistantMessage([fauxText(text)]);
            }

            return fauxAssistantMessage(
                [fauxToolCall("clock", text.includes("explicit") ? { zone: "UTC" } : {})],
                { stopReason: "toolUse" },
            );
        }),
    );
    copyFileSync(
        new URL("../docs/examples/clock.ts", import.meta.url),
        join(app.dataDir, "extensions", "clock.ts"),
    );
    await app.setExtensionEnabled(owner(app), "clock.ts", true);
    server = createServer(
        createHandler({
            app,
            listen: { host: "127.0.0.1", port: 0 },
            restart: () => {},
        }),
    );
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();

    assert.ok(address !== null && typeof address !== "string");
    base = `http://127.0.0.1:${address.port}`;
});

after(async () => {
    server?.closeAllConnections();
    await new Promise<void>((resolve) => server?.close(() => resolve()) ?? resolve());
    await app?.close();
    cleanUp();
});

async function zone(id: ConversationId, args: string) {
    const command = app.loader.commands().find((command) => command.name === "clock-zone");

    assert.ok(command, "the documented clock declares a native clock-zone command");
    const response = await fetch(`${base}/api/c/${id}/extension-commands`, {
        method: "POST",
        headers: {
            authorization: `Bearer ${app.config.ownerToken}`,
            "content-type": "application/json",
            "x-pocket": "1",
        },
        body: JSON.stringify({ commandId: command.id, args, requestId: crypto.randomUUID() }),
    });

    assert.equal(response.status, 200, await response.clone().text());

    return await response.json();
}

test("the clock command changes a preference without a model request and the real clock tool uses it", async () => {
    const id = await newSession(app);
    const before = requests.length;
    const changed = await zone(id, "Europe/Berlin");
    const shown = await zone(id, "");

    assert.equal(changed.status, "done");
    assert.equal(changed.type, "toast");
    assert.equal(shown.type, "card");
    assert.equal(shown.output, "Clock time zone: Europe/Berlin");
    assert.equal(requests.length, before);
    await say(app, id, "Read the clock with its preferred zone.");
    assert.match((await modelTexts(app, id)).at(-1) ?? "", /\(Europe\/Berlin\)/);
    assert.equal(
        requests.slice(before).some((request) => request.includes("Clock time zone:")),
        false,
    );
});

test("clock preferences are conversation-local and explicit tool arguments still take precedence", async () => {
    const first = await newSession(app);
    const second = await newSession(app);

    await zone(first, "Europe/Berlin");
    await zone(second, "America/Chicago");
    await say(app, first, "Read the preferred time.");
    await say(app, second, "Read the preferred time.");
    assert.match((await modelTexts(app, first)).at(-1) ?? "", /\(Europe\/Berlin\)/);
    assert.match((await modelTexts(app, second)).at(-1) ?? "", /\(America\/Chicago\)/);
    await say(app, first, "Read the explicit time.");
    assert.match((await modelTexts(app, first)).at(-1) ?? "", /\(UTC\)/);
});

test("an invalid clock preference fails without replacing the saved value", async () => {
    const id = await newSession(app);

    await zone(id, "Europe/Berlin");
    const result = await zone(id, "not-a-time-zone");

    assert.equal(result.status, "failed");
    assert.equal(result.type, "toast");
    assert.equal((await zone(id, "")).output, "Clock time zone: Europe/Berlin");
});
