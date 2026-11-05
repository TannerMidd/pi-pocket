// Actual export, sign-in and public-link routes use the built-in catalog, not a test rendering route.
import {
    type App,
    cleanUp,
    newSession,
    openApp,
    owner,
    root,
    say,
    scriptedModel,
    until,
} from "./helpers.ts";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { join } from "node:path";
import { after, before, test } from "node:test";
import type { ConversationId, TaskId } from "@earendil-works/pi-durable";
import { createHandler } from "../src/server/http.ts";
import { endedText } from "../src/server/watches.ts";
import { describeWatch } from "../src/server/extensions/triggers.ts";
import { prWatchLine } from "../src/server/extensions/pip.ts";
import type { PrWatch } from "../src/server/docs.ts";

let app: App;
let server: Server;
let base = "";
let session: ConversationId;
let guestToken = "";
const data = join(root, "real-route-locales");
const hostile = '<img src=x onerror="globalThis.injected=true"> & user words';

before(async () => {
    app = await openApp(scriptedModel(), data);
    session = await newSession(app);
    guestToken = app.config.addUser("Locale guest", "guest").token;
    await app.commands.updateSession(session, owner(app), { title: hostile });
    app.settings.applyOverrides({ compaction: { enabled: true, keepRecentTokens: 50 } });
    await say(app, session, `Keep the exact user words: ${hostile}`);
    await say(app, session, "Earlier context to compact. ".repeat(300));
    await say(app, session, "A newer message that remains after compaction.");
    await app.commands.compact(session, owner(app), undefined);
    await until(
        async () =>
            (await app.transcripts.allEntries(session, true)).some(
                (entry) => entry.kind === "compaction",
            ),
        "a real compaction entry",
    );
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

function exportFile(cookie?: string, query = "") {
    return fetch(`${base}/api/c/${session}/export${query}`, {
        headers: { authorization: `Bearer ${guestToken}`, ...(cookie ? { cookie } : {}) },
    });
}

test("the real guest export route isolates overlapping built-in Chinese and English requests", async () => {
    const results = await Promise.all(
        Array.from({ length: 20 }, async (_, index) => {
            const chinese = index % 2 === 0;
            const response = await exportFile(`pocket_locale=${chinese ? "zh-CN" : "en"}`);

            return { chinese, response, body: await response.text() };
        }),
    );

    for (const { chinese, response, body } of results) {
        assert.equal(response.status, 200);
        assert.match(response.headers.get("content-type") ?? "", /^text\/markdown/);
        assert.ok(
            body.includes(
                chinese
                    ? "<summary>上下文已压缩</summary>"
                    : "<summary>Context compacted</summary>",
            ),
        );
        assert.ok(body.includes(hostile), "the user's title and message remain literal Markdown");
        assert.ok(body.includes("Keep the exact user words:"));
    }
});

test("real exports fall back to English for missing, invalid, unavailable and wrong-name cookies", async () => {
    for (const cookie of [
        undefined,
        "pocket_locale=invalid_tag",
        "pocket_locale=fr-CA",
        "pi_locale=zh-CN",
    ]) {
        const response = await exportFile(cookie);

        assert.equal(response.status, 200);
        assert.match(await response.text(), /<summary>Context compacted<\/summary>/);
    }

    const safe = await exportFile("pocket_locale=zh-CN", "?noext=1");

    assert.match(await safe.text(), /<summary>Context compacted<\/summary>/);
    assert.equal(safe.headers.get("set-cookie"), null);
});

test("a real export escapes a hostile translated HTML heading, but preserves the stored content", async () => {
    const extensions = join(data, "extensions");

    mkdirSync(extensions, { recursive: true });
    writeFileSync(
        join(extensions, "zz-export-escape.ts"),
        `/** Hostile translation data for the real route. */\nexport default (_host, web) => web.uiLocales([{ id: "zh-CN", label: "简体中文", messages: { "server.export.context-compacted": ${JSON.stringify(hostile)} } }]);\n`,
    );
    await app.setExtensionEnabled(owner(app), "zz-export-escape.ts", true);

    try {
        const response = await exportFile("pocket_locale=zh-CN");
        const body = await response.text();

        assert.equal(response.status, 200);
        assert.ok(!body.includes(`<summary>${hostile}</summary>`));
        assert.match(body, /<summary>&#60;img/);
        assert.ok(body.includes(`Keep the exact user words: ${hostile}`));
    } finally {
        await app.setExtensionEnabled(owner(app), "zz-export-escape.ts", false);
    }
});

test("the real public-link fallback and login use built-in Chinese with English fallback", async () => {
    for (const [cookie, lang] of [
        ["pocket_locale=zh-CN", "zh-CN"],
        ["pi_locale=zh-CN", "en"],
        ["pocket_locale=xx", "en"],
    ]) {
        const response = await fetch(`${base}/l/${"0".repeat(32)}`, {
            headers: { cookie: cookie! },
        });
        const body = await response.text();

        assert.equal(response.status, 404);
        assert.ok(body.includes(`<html lang="${lang}">`));
        assert.ok(body.includes(lang === "zh-CN" ? "此链接未开放" : "This link is not open"));
        assert.ok(response.headers.get("content-security-policy")?.includes("sandbox"));
        const login = await fetch(`${base}/login?token=invalid`, { headers: { cookie: cookie! } });

        assert.equal(login.status, 401);
        assert.ok((await login.text()).includes(`<html lang="${lang}">`));
    }
});

test("PR-watch text for background tasks and model tools remains English without a request", () => {
    const watch: PrWatch = {
        repo: "owner/repo",
        number: 1,
        url: "https://github.com/owner/repo/pull/1",
        title: hostile,
        branch: "main",
        by: owner(app).id,
        createdAt: 0,
        taskId: 0 as TaskId,
        status: "failed",
        next: 0,
        sent: 0,
        max: 10,
        since: "2026-01-01T00:00:00Z",
        seen: [],
        lastNewsAt: 0,
        errors: 1,
    };

    assert.equal(endedText(watch), "until it had to stop: something went wrong");
    assert.ok(describeWatch(watch).includes("watched until it had to stop: something went wrong"));
    assert.ok(prWatchLine(watch).includes("watched until it had to stop: something went wrong"));
});
