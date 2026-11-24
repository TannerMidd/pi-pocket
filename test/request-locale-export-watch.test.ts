// Optional rendering locales through concurrent real HTTP requests; no language is kept between requests.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { test } from "node:test";
import type { TaskId } from "@earendil-works/pi-durable";
import type { PrWatch } from "../src/server/docs.ts";
import { transcriptMarkdown } from "../src/server/export.ts";
import { escapeHtml } from "../src/server/http/io.ts";
import { localeCookie, requestLocale, type UiLocaleSnapshot } from "../src/server/ui-locales.ts";
import { endedText } from "../src/server/watches.ts";
import { EN } from "../web/locales/en.js";

const keys = {
    compacted: "server.export.context-compacted",
    failed: "server.watches.ended.failed",
    reason: "server.watches.ended.unknown-reason",
};
const snapshot: UiLocaleSnapshot = Object.freeze({
    revision: 1,
    locales: Object.freeze([
        Object.freeze({ id: "en", label: "English", messages: EN }),
        Object.freeze({
            id: "zh-CN",
            label: "简体中文",
            messages: Object.freeze({
                [keys.compacted]: "上下文已压缩",
                [keys.failed]: "直到不得不停下：{reason}",
                [keys.reason]: "出现了问题",
            }),
        }),
    ]),
});
const input = {
    title: "Literal user title",
    cwd: "/tmp/project",
    exportedAt: new Date("2026-01-02T03:04:00Z"),
    entries: [{ id: 1, kind: "compaction" as const, summary: "Literal user summary" }],
    authors: {},
};
const watch: PrWatch = {
    repo: "owner/repo",
    number: 1,
    url: "https://github.com/owner/repo/pull/1",
    title: "Literal PR title",
    branch: "main",
    by: "owner",
    createdAt: 0,
    taskId: 0 as TaskId,
    status: "failed",
    next: 0,
    sent: 0,
    max: 10,
    since: "2026-01-02T03:04:00Z",
    seen: [],
    lastNewsAt: 0,
    errors: 1,
};

test("export and watch errors use each overlapping request locale", async () => {
    let entered = 0;
    let release!: () => void;
    const barrier = new Promise<void>((resolve) => (release = resolve));
    const server = createServer(async (request, response) => {
        const locale = requestLocale(snapshot, localeCookie(request.headers.cookie));

        entered++;

        if (entered === 2) {
            release();
        }

        await barrier;

        // Reflect keeps the pre-change call executable: an old implementation ignores the optional argument.
        const markdown = Reflect.apply(transcriptMarkdown, undefined, [input, locale]) as string;
        const error = Reflect.apply(endedText, undefined, [watch, locale]) as string;

        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ lang: locale.lang, markdown, error }));
    });

    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const base = `http://127.0.0.1:${(server.address() as { port: number }).port}/render`;

    try {
        const responses = await Promise.all(
            ["en", "zh-CN"].map((locale) =>
                fetch(base, { headers: { cookie: `pocket_locale=${locale}` } }),
            ),
        );
        const [english, chinese] = await Promise.all(responses.map((response) => response.json()));

        assert.equal(entered, 2, "both HTTP requests reached the barrier before rendering");
        assert.deepEqual(
            responses.map((response) => response.status),
            [200, 200],
        );
        assert.equal(chinese.lang, "zh-CN");
        assert.ok(
            chinese.markdown.includes("<summary>上下文已压缩</summary>"),
            "Chinese request gets its translated export heading",
        );
        assert.equal(chinese.error, "直到不得不停下：出现了问题");
        assert.equal(english.lang, "en");
        assert.ok(english.markdown.includes("<summary>Context compacted</summary>"));
        assert.equal(english.error, "until it had to stop: something went wrong");
        assert.ok(chinese.markdown.startsWith("# Literal user title\n"));
        assert.ok(chinese.markdown.includes("Literal user summary"));
    } finally {
        release();
        server.closeAllConnections();
        await new Promise<void>((resolve, reject) =>
            server.close((error) => (error ? reject(error) : resolve())),
        );
    }
});

test("old rendering calls stay English and translated HTML remains escaped", () => {
    const locale = requestLocale(snapshot, "zh-CN");
    const hostile = '<img src=x onerror=alert(1)> " &';
    const hostileLocale = requestLocale(
        {
            revision: 2,
            locales: [{ id: "zh-CN", label: "简体中文", messages: { [keys.compacted]: hostile } }],
        },
        "zh-CN",
    );
    const markdown = Reflect.apply(transcriptMarkdown, undefined, [input, hostileLocale]) as string;

    assert.ok(transcriptMarkdown(input).includes("<summary>Context compacted</summary>"));
    assert.equal(endedText(watch), "until it had to stop: something went wrong");
    assert.ok(markdown.includes(`<summary>${escapeHtml(hostile)}</summary>`));
    assert.ok(!markdown.includes(`<summary>${hostile}</summary>`));
    const reason = Reflect.apply(endedText, undefined, [
        { ...watch, note: hostile },
        locale,
    ]) as string;

    assert.equal(
        reason,
        `直到不得不停下：${hostile}`,
        "the raw watch reason is not translated or treated as code",
    );
    assert.ok(
        !escapeHtml(reason).includes("<img"),
        "HTML callers can keep using the existing escaper",
    );
});
