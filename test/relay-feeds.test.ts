import assert from "node:assert/strict";
import { after, describe, test } from "node:test";
import http from "../src/server/extensions/pocket-relay/connectors/http.ts";
import rss, { parseFeed } from "../src/server/extensions/pocket-relay/connectors/rss.ts";
import {
    type RelayContext,
    type RelayError,
    type RelayEvent,
    type RelayValues,
} from "../src/server/extensions/pocket-relay/types.ts";
import { mockServer } from "./relay-ws-mock.ts";

type Handle = Parameters<typeof mockServer>[0];

const servers: Awaited<ReturnType<typeof mockServer>>[] = [];

async function serve(handle: Handle) {
    const mock = await mockServer(handle);

    servers.push(mock);

    return mock;
}

after(() => {
    for (const { server } of servers) {
        server.close();
        server.closeAllConnections();
    }
});

/** A fake context: `state` follows `save`, so the next poll sees it. */
function fake(values: RelayValues) {
    const controller = new AbortController();
    const events: RelayEvent[] = [];
    let state: Record<string, unknown> = {};
    const context: RelayContext = {
        values,
        get state() {
            return state;
        },
        save: (next) => {
            state = next;
        },
        emit: async (batch) => {
            events.push(...batch);
        },
        signal: controller.signal,
        status: () => {},
        log: () => {},
        sleep: async () => {},
    };

    return { context, events, controller, state: () => state };
}

const ids = (events: RelayEvent[]) => events.map((event) => event.id);

describe("http connector", () => {
    test("baseline emits nothing, then each new item once, with the template", async () => {
        let items = [
            { id: "1", body: "one", who: { id: "u1", name: "Ann" }, room: "r1" },
            { id: "2", body: "two", who: { id: "u2", name: "Bob" }, room: "r1" },
        ];
        const mock = await serve(() => ({ json: { data: { list: items } } }));
        const { context, events } = fake({
            url: `${mock.url}/api`,
            itemsPath: "data.list",
            textTemplate: "{{who.name}}: {{body}}",
            authorIdField: "who.id",
            authorNameField: "who.name",
            channelField: "room",
        });

        await http.poll!(context);
        assert.deepEqual(events, []);
        items = [...items, { id: "3", body: "three", who: { id: "u1", name: "Ann" }, room: "r2" }];
        await http.poll!(context);
        await http.poll!(context);
        assert.equal(events.length, 1);
        assert.deepEqual(events[0], {
            id: "3",
            text: "Ann: three",
            author: { id: "u1", name: "Ann" },
            channel: "r2",
        });
    });

    test("the cursor parameter carries the last item's field", async () => {
        const queries: (string | null)[] = [];
        const mock = await serve((request) => {
            const cursor = new URL(request.url ?? "/", "http://x").searchParams.get("after");

            queries.push(cursor);

            return {
                json:
                    cursor === null
                        ? [{ id: "a", text: "old", seq: 5 }]
                        : cursor === "5"
                          ? [
                                { id: "b", text: "new1", seq: 6 },
                                { id: "c", text: "new2", seq: 7 },
                            ]
                          : [],
            };
        });
        const { context, events, state } = fake({
            url: mock.url,
            cursorParam: "after",
            cursorField: "seq",
        });

        await http.poll!(context);
        assert.equal(state().cursor, "5");
        await http.poll!(context);
        await http.poll!(context);
        assert.deepEqual(queries, [null, "5", "7"]);
        assert.deepEqual(ids(events), ["b", "c"]);
    });

    test("secret headers are sent but never in an error message", async () => {
        const secret = "Bearer s3cr3t-token-value";
        let seen: string | undefined;
        let status = 200;
        const mock = await serve((request) => {
            seen = request.headers.authorization;

            return { status, json: [] };
        });
        const { context } = fake({
            url: mock.url,
            headers: `Authorization: ${secret}\n\nX-One: 1`,
        });

        await http.poll!(context);
        assert.equal(seen, secret);

        for (const code of [401, 403, 429, 500]) {
            status = code;
            const error = await http.poll!(context).then(
                () => undefined,
                (caught: unknown) => caught as RelayError,
            );

            assert.ok(error instanceof Error);
            assert.ok(!error.message.includes("s3cr3t"));
            assert.ok(!error.message.includes(mock.url));
            assert.equal(error.fatal === true, code === 401 || code === 403);
        }

        status = 429;
        const limited = await http.poll!(context).then(
            () => undefined,
            (caught: unknown) => caught as RelayError,
        );

        assert.equal(limited?.retryAfter, 60_000);
    });

    test("a reply fills the templates, sends the idempotency key, and needs a reply address", async () => {
        const received: {
            method?: string;
            url?: string;
            headers: Record<string, unknown>;
            body: string;
        }[] = [];
        const mock = await serve((request, body) => {
            received.push({
                method: request.method,
                url: request.url,
                headers: request.headers,
                body,
            });

            return { json: { id: 77 } };
        });
        const values = {
            url: mock.url,
            replyUrl: `${mock.url}/rooms/{{channel}}/threads/{{thread}}`,
            replyMethod: "PUT",
            replyHeaders: "X-Token: abc",
            replyBody: '{"msg": {{text}}, "to": {{replyTo}}, "k": {{key}}}',
        };
        const { context } = fake(values);
        const to: RelayEvent = {
            id: "m1",
            text: "hi",
            author: { id: "u", name: "U" },
            channel: "a b",
            thread: "t/1",
        };
        const result = await http.reply!(context, { text: 'say "hi" {{key}}', to, key: "key-1" });

        assert.deepEqual(result, { id: "77" });
        assert.equal(received[0]?.method, "PUT");
        assert.equal(received[0]?.url, "/rooms/a%20b/threads/t%2F1");
        assert.equal(received[0]?.headers["idempotency-key"], "key-1");
        assert.equal(received[0]?.headers["x-token"], "abc");
        assert.deepEqual(JSON.parse(received[0]?.body ?? ""), {
            msg: 'say "hi" {{key}}',
            to: "m1",
            k: "key-1",
        });
        assert.equal(http.check!(values), undefined);

        await assert.rejects(
            http.reply!(fake({ url: mock.url }).context, { text: "x", key: "k" }),
            /no reply address/,
        );
    });

    test("check refuses a broken body template, a bad address, and bad headers", () => {
        const good = { url: "https://example.com/x" };

        assert.equal(http.check!(good), undefined);
        assert.match(http.check!({ url: "ftp://example.com" }) ?? "", /http/);
        assert.match(http.check!({ ...good, headers: "no colon here" }) ?? "", /Name: value/);
        assert.match(
            http.check!({
                ...good,
                replyUrl: "https://e.com/{{channel}}",
                replyBody: '{"a": {{text}}',
            }) ?? "",
            /valid JSON/,
        );
        assert.match(http.check!({ ...good, cursorParam: "after" }) ?? "", /both/);
    });
});

const rssXml = `<?xml version="1.0"?>
<rss version="2.0" xmlns:dc="http://purl.org/dc/elements/1.1/"><channel>
<title>Fish &amp; Chips News</title>
<item>
  <title><![CDATA[Second <b>post</b> & more]]></title>
  <link>https://example.com/2</link>
  <guid>g-2</guid>
  <dc:creator>Ann</dc:creator>
  <pubDate>Tue, 02 Jan 2024 10:00:00 GMT</pubDate>
  <description><![CDATA[<p>Hello <b>world</b></p><p>Line two</p>]]></description>
</item>
<item>
  <title>First &lt;post&gt; &#8212; caf&#xE9; &apos;q&apos; &quot;d&quot;</title>
  <link>https://example.com/1</link>
  <pubDate>Mon, 01 Jan 2024 10:00:00 GMT</pubDate>
  <description>&lt;p&gt;Escaped &amp;amp; html&lt;/p&gt;</description>
</item>
</channel></rss>`;

const atomXml = `<?xml version="1.0"?>
<feed xmlns="http://www.w3.org/2005/Atom"><title>Atom Blog</title>
<entry>
  <title>Atom one</title>
  <id>tag:example.com,2024:1</id>
  <link rel="alternate" href="https://example.com/a1"/>
  <updated>2024-01-03T10:00:00Z</updated>
  <author><name>Bea</name></author>
  <summary type="html">&lt;i&gt;Short&lt;/i&gt; summary</summary>
</entry>
</feed>`;

describe("rss connector", () => {
    test("baseline emits nothing; RSS parsing: CDATA, entities, html removed, order", async () => {
        const mock = await serve(() => ({ text: rssXml }));
        const first = fake({ url: `${mock.url}/feed` });

        await rss.poll!(first.context);
        assert.deepEqual(first.events, []);
        assert.equal((first.state().seen as string[]).length, 2);

        const { context, events } = fake({ url: `${mock.url}/feed` });

        context.save({ seen: ["g-2"] });
        await rss.poll!(context);
        assert.equal(events.length, 1);
        assert.equal(events[0]?.id, "https://example.com/1");
        assert.equal(
            events[0]?.text,
            "First <post> \u2014 caf\u00e9 'q' \"d\"\n\nEscaped & html\n\nhttps://example.com/1",
        );
        assert.deepEqual(events[0]?.author, {
            id: new URL(mock.url).host,
            name: "Fish & Chips News",
        });

        context.save({ seen: [] });
        events.length = 0;
        await rss.poll!(context);
        assert.deepEqual(ids(events), ["https://example.com/1", "g-2"]);
        assert.equal(
            events[1]?.text,
            "Second post & more\n\nHello world\nLine two\n\nhttps://example.com/2",
        );
        assert.equal(events[1]?.author.name, "Ann");
    });

    test("parses Atom entries", async () => {
        const mock = await serve(() => ({ text: atomXml }));
        const { context, events } = fake({ url: mock.url });

        context.save({ seen: ["other"] });
        await rss.poll!(context);
        assert.equal(events[0]?.id, "tag:example.com,2024:1");
        assert.equal(events[0]?.text, "Atom one\n\nShort summary\n\nhttps://example.com/a1");
        assert.equal(events[0]?.author.name, "Bea");
        assert.equal(events[0]?.at, Date.parse("2024-01-03T10:00:00Z"));
    });

    test("sends the validators and emits nothing on 304", async () => {
        const requests: Record<string, unknown>[] = [];
        const mock = await serve((request) => {
            requests.push(request.headers);

            return request.headers["if-none-match"] === '"v1"'
                ? { status: 304 }
                : {
                      text: atomXml,
                      headers: { etag: '"v1"', "last-modified": "Wed, 03 Jan 2024 10:00:00 GMT" },
                  };
        });
        const { context, events, state } = fake({ url: mock.url });

        await rss.poll!(context);
        assert.equal(state().etag, '"v1"');
        await rss.poll!(context);
        assert.equal(requests[1]?.["if-none-match"], '"v1"');
        assert.equal(requests[1]?.["if-modified-since"], "Wed, 03 Jan 2024 10:00:00 GMT");
        assert.deepEqual(events, []);
        assert.equal((state().seen as string[]).length, 1);
    });

    test("an unterminated <item> list parses in linear time", () => {
        const started = Date.now();

        assert.throws(() => parseFeed("<item>".repeat(40_000)));
        assert.ok(Date.now() - started < 200, `took ${Date.now() - started} ms`);
    });

    test("the seen ids stay under the 64 KB the relay keeps, and no old item comes twice", async () => {
        const links = Array.from(
            { length: 900 },
            (_, i) => `https://example.com/blog/${i}/${"s".repeat(80)}`,
        );
        const items = links.map((link) => `<item><link>${link}</link></item>`).join("");
        const mock = await serve(() => ({ text: `<rss><channel>${items}</channel></rss>` }));
        const { context, events, state } = fake({ url: mock.url });

        await rss.poll!(context);
        assert.ok(JSON.stringify(state()).length < 64 * 1024);
        await rss.poll!(context);
        assert.deepEqual(events, []);
    });
});

test("the headers of the http connector take several lines", () => {
    const lines = http.fields.filter((field) => field.name.toLowerCase().endsWith("headers"));

    assert.equal(lines.length, 2);
    assert.ok(lines.every((field) => field.multiline === true));
});
