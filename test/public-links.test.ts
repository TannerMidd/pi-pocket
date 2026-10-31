// Public links (`public-links.ts`, `http/link-routes.ts`): pages an extension module shows at `/l/<token>` to anyone with
// the address, with no sign-in. What every page is sent with, uses that count once and come back when a post is
// refused, links that close, modules that see only their own, and a module turned off. Then Ask someone
// (`extensions/ask-someone.ts`), from Pi's draft to an answer through its link.
import {
    cleanUp,
    fakeTab,
    lastText,
    loadTools,
    newSession,
    openApp,
    owner,
    root,
    say,
    scriptedModel,
} from "./helpers.ts";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { join } from "node:path";
import { after, before, test } from "node:test";
import type { FauxResponseStep } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import type { ConversationId } from "@earendil-works/pi-durable";
import { createHandler } from "../src/server/http.ts";
import { linkReads } from "../src/server/http/link-routes.ts";

const dataDir = join(root, "data");
let app: Awaited<ReturnType<typeof openApp>>;
let server: Server;
let base = "";
let clock = Date.now();
const people: Record<string, string> = {};

/** "ask" makes Pi draft a question with ask_someone; anything else is echoed. */
const route: FauxResponseStep = (request) => {
    const { role, text } = lastText(request as never);

    if (role === "toolResult") {
        return fauxAssistantMessage([fauxText(`ok: ${text}`)]);
    }

    if (text.endsWith("ask")) {
        return fauxAssistantMessage(
            [
                fauxToolCall("ask_someone", {
                    title: "Which database <b>should</b> we use?",
                    question:
                        "We need **one** for the app.\n\n- Postgres\n- SQLite\n\nI suggest SQLite.",
                }),
            ],
            { stopReason: "toolUse" },
        );
    }

    return fauxAssistantMessage([fauxText(`echo: ${text}`)]);
};

before(async () => {
    mkdirSync(join(dataDir, "extensions"), { recursive: true });
    writeFileSync(
        join(dataDir, "extensions", "linker.ts"),
        `/** Linker: a public page for tests. */
export default (_host, web) => {
    web.route("POST", "make", (request) => web.links.create(request.body));
    web.route("POST", "end", async (request) => ({ ended: await web.links.end(request.body.token) }));
    web.route("GET", "list", () => web.links.list());
    web.publicPage((request) => {
        if (request.query.get("hang") === "1") {
            return new Promise(() => {});
        }

        if (request.method === "GET") {
            return "<p>page " + request.link.data.n + "</p>";
        }

        if (request.form.answer === "") {
            return { html: "<p>empty</p>", status: 400 };
        }

        if (request.form.answer === "boom") {
            throw new Error("secret words");
        }

        if (request.form.answer === "nope") {
            throw web.error(422, "Not that answer.");
        }

        return "<p>got " + request.form.answer.length + ", " + request.link.uses + " left</p>";
    });
};
`,
    );
    writeFileSync(
        join(dataDir, "extensions", "other.ts"),
        `/** Other: another module, which must not reach Linker's links. */
export default (_host, web) => {
    web.route("POST", "end", async (request) => ({ ended: await web.links.end(request.body.token) }));
    web.route("POST", "get", async (request) => ({ found: (await web.links.get(request.body.token)) ?? null }));
    web.route("GET", "list", () => web.links.list());
};
`,
    );
    app = await openApp(scriptedModel(route), dataDir, () => clock);
    server = createServer(
        createHandler({ app, listen: { host: "127.0.0.1", port: 0 }, restart: () => {} }),
    );
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    people.owner = app.config.ownerToken;
    people.viewer = app.config.addUser("Vic", "viewer").token;

    for (const file of ["linker.ts", "other.ts", "ask-someone.ts"]) {
        await app.setExtensionEnabled(owner(app), file, true);
    }
});

after(async () => {
    server.closeAllConnections();
    server.close();
    await app.close();
    cleanUp();
});

async function call(path: string, body?: unknown, method?: string, who = "owner") {
    const response = await fetch(`${base}${path}`, {
        method: method ?? (body === undefined ? "GET" : "POST"),
        headers: {
            authorization: `Bearer ${people[who]}`,
            "x-pocket": "1",
            ...(body === undefined ? {} : { "content-type": "application/json" }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });

    return { status: response.status, data: (await response.json()) as Record<string, unknown> };
}

/** A public page, as a stranger's browser asks for it: no sign-in, no header of the app's. */
async function open(path: string, form?: Record<string, string>) {
    const response = await fetch(`${base}${path}`, {
        method: form === undefined ? "GET" : "POST",
        ...(form === undefined
            ? {}
            : {
                  headers: { "content-type": "application/x-www-form-urlencoded" },
                  body: new URLSearchParams(form).toString(),
              }),
    });

    return { status: response.status, headers: response.headers, text: await response.text() };
}

const make = async (request: Record<string, unknown>) => {
    const made = await call("/api/x/linker/make", request);

    assert.equal(made.status, 200, JSON.stringify(made.data));

    return made.data as { token: string; path: string; url: string | null; uses: number | null };
};

test("a link's page needs no sign-in, and is sent in an opaque origin with no script", async () => {
    const link = await make({ hours: 1, data: { n: 7 } });

    assert.match(link.token, /^[0-9a-f]{32}$/);
    assert.equal(link.path, `/l/${link.token}`);

    const page = await open(link.path);

    assert.equal(page.status, 200);
    assert.equal(page.text, "<p>page 7</p>");

    const policy = page.headers.get("content-security-policy") ?? "";

    assert.match(policy, /sandbox allow-forms(;|$)/);
    assert.doesNotMatch(policy, /allow-scripts|allow-same-origin|script-src/);
    assert.match(policy, /default-src 'none'/);
    assert.equal(page.headers.get("referrer-policy"), "no-referrer");
    assert.equal(page.headers.get("cache-control"), "no-store");
    assert.match(page.headers.get("x-robots-tag") ?? "", /noindex/);
});

test("an address that names no open link answers the same, whatever it is", async () => {
    const link = await make({ hours: 1, data: { n: 1 } });

    for (const path of [
        `/l/${"0".repeat(32)}`,
        "/l/nothing",
        `/l/${link.token}/more`,
        "/l/",
        `/l/${link.token.toUpperCase()}`,
    ]) {
        const page = await open(path);

        assert.equal(page.status, 404, path);
        assert.match(page.text, /This link is not open/, path);
    }
});

test("a link for one answer takes one; a refused post gives its use back", async () => {
    const link = await make({ hours: 1, uses: 1, data: { n: 2 } });

    assert.equal(link.uses, 1);

    // Refused by the page: the use comes back, and the person can try again.
    assert.equal((await open(link.path, { answer: "" })).status, 400);
    assert.equal((await open(link.path, { answer: "nope" })).status, 422);
    assert.match((await open(link.path, { answer: "nope" })).text, /Not that answer\./);

    // Not a form: refused before the page sees it.
    const json = await fetch(`${base}${link.path}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
    });

    assert.equal(json.status, 415);

    const sent = await open(link.path, { answer: "yes" });

    assert.equal(sent.status, 200);
    assert.equal(sent.text, "<p>got 3, 0 left</p>");
    assert.equal((await open(link.path, { answer: "again" })).status, 404);
    assert.equal((await open(link.path)).status, 404);
});

test("two posts at once to a link for one answer: one gets in", async () => {
    const link = await make({ hours: 1, uses: 1, data: { n: 3 } });
    const both = await Promise.all([
        open(link.path, { answer: "first" }),
        open(link.path, { answer: "second" }),
    ]);

    const statuses = both.map((each) => each.status).sort();

    // The other is refused: while the first is read (410), or after the link closed (404).
    assert.equal(statuses[0], 200);
    assert.ok([404, 410].includes(statuses[1]!), String(statuses[1]));
});

test("a link that took its last use can still get it back, while other links are made", async () => {
    const link = await make({ hours: 1, uses: 1, data: { n: 9 } });

    assert.ok(await app.publicLinks.claim(link.token));
    // Making a link clears out closed ones: not one whose page may still refuse its post.
    await make({ hours: 1, data: { n: 10 } });
    await app.publicLinks.refund(link.token);
    assert.equal((await open(link.path)).status, 200);

    // Long after its last use, it goes.
    assert.ok(await app.publicLinks.claim(link.token));
    clock += 11 * 60 * 1000;
    await make({ hours: 1, data: { n: 11 } });
    await app.publicLinks.refund(link.token);
    assert.equal((await open(link.path)).status, 404);
});

test("a page that fails says so without its words, which only the log has", async () => {
    const link = await make({ hours: 1, data: { n: 4 } });
    const failed = await open(link.path, { answer: "boom" });

    assert.equal(failed.status, 500);
    assert.doesNotMatch(failed.text, /secret words/);
    assert.match(failed.text, /could not be shown/);
});

test("a page that never answers is given up at its time, and holds no place after", async () => {
    const link = await make({ hours: 1, data: { n: 12 } });
    const was = linkReads.handlerMs;

    linkReads.handlerMs = 100;

    try {
        // More than may run at once for one link: each is let go, so none is turned away as busy.
        for (let index = 0; index < 6; index++) {
            const page = await open(`${link.path}?hang=1`);

            assert.equal(page.status, 504, `try ${index}`);
            assert.match(page.text, /took too long/);
        }

        assert.equal((await open(link.path)).status, 200);
    } finally {
        linkReads.handlerMs = was;
    }
});

test("a form that arrives too slowly gets a page that says so, not a dropped connection", async () => {
    const link = await make({ hours: 1, data: { n: 13 } });
    const was = linkReads.timeoutMs;

    linkReads.timeoutMs = 150;

    try {
        const { request } = await import("node:http");
        const answer = await new Promise<{ status: number; text: string }>((resolve, reject) => {
            const post = request(
                `${base}${link.path}`,
                {
                    method: "POST",
                    headers: {
                        "content-type": "application/x-www-form-urlencoded",
                        "content-length": "100",
                    },
                },
                (response) => {
                    let text = "";

                    response.setEncoding("utf8");
                    response.on("data", (chunk: string) => (text += chunk));
                    response.on("end", () => resolve({ status: response.statusCode ?? 0, text }));
                },
            );

            post.on("error", reject);
            // A little of the body, and then nothing more.
            post.write("answer=slow");
        });

        assert.equal(answer.status, 408);
        assert.match(answer.text, /took too long to arrive/);
        // The link still takes its answer.
        assert.equal((await open(link.path)).status, 200);
    } finally {
        linkReads.timeoutMs = was;
    }
});

test("a link closes at its time", async () => {
    const link = await make({ hours: 2, data: { n: 5 } });

    clock += 60 * 60 * 1000;
    assert.equal((await open(link.path)).status, 200);
    clock += 60 * 60 * 1000;
    assert.equal((await open(link.path)).status, 404);
});

test("what a module asks for is checked", async () => {
    for (const request of [
        { hours: 0 },
        { hours: 721 },
        { hours: "1" },
        { hours: 1, uses: 0 },
        { hours: 1, uses: 1.5 },
        { hours: 1, conversation: -1 },
        { hours: 1, data: "x".repeat(5000) },
    ]) {
        assert.equal(
            (await call("/api/x/linker/make", request)).status,
            500,
            JSON.stringify(request).slice(0, 80),
        );
    }
});

test("a module sees and ends only its own links", async () => {
    const link = await make({ hours: 1, data: { n: 6 } });

    assert.deepEqual((await call("/api/x/other/get", { token: link.token })).data, {
        found: null,
    });
    assert.deepEqual((await call("/api/x/other/end", { token: link.token })).data, {
        ended: false,
    });
    assert.deepEqual((await call("/api/x/other/list")).data, []);
    assert.equal((await open(link.path)).status, 200);

    const listed = (await call("/api/x/linker/list")).data as unknown as { token: string }[];

    assert.ok(listed.some((each) => each.token === link.token));
    assert.deepEqual((await call("/api/x/linker/end", { token: link.token })).data, {
        ended: true,
    });
    assert.equal((await open(link.path)).status, 404);
});

test("while its module is off, a link answers nothing; on again, it is back", async () => {
    const link = await make({ hours: 1, data: { n: 8 } });

    await app.setExtensionEnabled(owner(app), "linker.ts", false);
    assert.equal((await open(link.path)).status, 404);
    await app.setExtensionEnabled(owner(app), "linker.ts", true);
    assert.equal((await open(link.path)).status, 200);
});

test("Ask someone: Pi drafts, a person shares it, a stranger answers once", async () => {
    const id: ConversationId = await newSession(app);

    // ask_someone waits for a search (`tool-search.ts`): Pi loads it first.
    await loadTools(app, id, "ask_someone");
    await say(app, id, "please ask");

    const list = async (who = "owner") =>
        call(`/api/x/ask-someone/questions/${id}`, undefined, "GET", who);
    const drafted = (await list()).data.questions as {
        id: string;
        title: string;
        text: string;
        status: string;
    }[];

    assert.equal(drafted.length, 1);
    assert.equal(drafted[0]!.status, "draft");
    assert.equal(drafted[0]!.title, "Which database <b>should</b> we use?");

    // Viewers do not read drafts.
    assert.equal((await list("viewer")).status, 404);

    const question = drafted[0]!.id;

    // A draft can be edited; an unknown one is not there.
    assert.equal(
        (
            await call(
                `/api/x/ask-someone/questions/${id}/${question}`,
                {
                    title: "Which database <b>should</b> we use?",
                    text: `${drafted[0]!.text}\n\nThanks!`,
                },
                "PUT",
            )
        ).status,
        200,
    );
    assert.equal(
        (
            await call(
                `/api/x/ask-someone/questions/${id}/${"0".repeat(16)}`,
                { title: "x", text: "y" },
                "PUT",
            )
        ).status,
        404,
    );
    assert.equal(
        (await call(`/api/x/ask-someone/questions/${id}/${question}/link`, { hours: 5 })).status,
        400,
    );

    const shared = await call(`/api/x/ask-someone/questions/${id}/${question}/link`, { hours: 24 });

    assert.equal(shared.status, 200);

    const link = (shared.data.link as { path: string }).path;
    const page = await open(link);

    assert.equal(page.status, 200);
    // The title is escaped; the few marks of Markdown show as HTML.
    assert.match(page.text, /Which database &#60;b&#62;should&#60;\/b&#62; we use\?/);
    assert.match(page.text, /<strong>one<\/strong>/);
    assert.match(page.text, /<li>Postgres<\/li>/);
    assert.match(page.text, /Thanks!/);
    assert.match(page.text, /<form method="post">/);
    assert.doesNotMatch(page.text, /<script/);

    // Shared: it stays as it was sent.
    assert.equal(
        (
            await call(
                `/api/x/ask-someone/questions/${id}/${question}`,
                { title: "x", text: "y" },
                "PUT",
            )
        ).status,
        409,
    );

    // An empty answer is refused, and the link still takes one.
    assert.equal((await open(link, { answer: "  ", name: "Tev" })).status, 400);

    // The notice of the answer goes to who shared it, not to everyone the module is for.
    const tabs = {
        owner: fakeTab(undefined, owner(app)),
        guest: fakeTab(undefined, app.config.addUser("Gus", "guest").user),
    };

    await app.attach(tabs.owner.client);
    await app.attach(tabs.guest.client);

    const answered = await open(link, {
        answer: "SQLite is fine.\n<script>x</script>",
        name: "Tevis",
    });

    assert.equal(answered.status, 200);
    assert.match(answered.text, /Thank you/);

    const notices = (tab: ReturnType<typeof fakeTab>) =>
        tab.events.filter((each) => each.event === "ext" && each.data.event === "answered");

    assert.equal(notices(tabs.owner).length, 1);
    assert.equal(notices(tabs.guest).length, 0);
    app.detach(tabs.owner.client);
    app.detach(tabs.guest.client);
    assert.equal((await open(link, { answer: "again" })).status, 404);
    assert.equal((await open(link)).status, 404);

    const after = (await list()).data.questions as {
        status: string;
        answer: { text: string; name: string };
        link?: unknown;
    }[];

    assert.equal(after[0]!.status, "answered");
    assert.equal(after[0]!.answer.name, "Tevis");
    assert.equal(after[0]!.answer.text, "SQLite is fine.\n<script>x</script>");
    assert.equal(after[0]!.link, undefined);

    assert.equal(
        (await call(`/api/x/ask-someone/questions/${id}/${question}/used`, {})).status,
        200,
    );
    assert.equal(
        (await call(`/api/x/ask-someone/questions/${id}/${question}`, undefined, "DELETE")).status,
        200,
    );
    assert.deepEqual((await list()).data.questions, []);
});

test("Ask someone: ending a link takes the page down, and the draft can be shared again", async () => {
    const id: ConversationId = await newSession(app);

    await loadTools(app, id, "ask_someone");
    await say(app, id, "ask");

    const [question] = (await call(`/api/x/ask-someone/questions/${id}`)).data.questions as {
        id: string;
    }[];
    const first = (
        (await call(`/api/x/ask-someone/questions/${id}/${question!.id}/link`, { hours: 168 })).data
            .link as { path: string }
    ).path;

    assert.equal(
        (await call(`/api/x/ask-someone/questions/${id}/${question!.id}/link`, { hours: 168 }))
            .status,
        409,
    );
    assert.equal(
        (await call(`/api/x/ask-someone/questions/${id}/${question!.id}/link`, undefined, "DELETE"))
            .status,
        200,
    );
    assert.equal((await open(first)).status, 404);

    const second = (
        (await call(`/api/x/ask-someone/questions/${id}/${question!.id}/link`, { hours: 24 })).data
            .link as { path: string }
    ).path;

    assert.notEqual(second, first);
    assert.equal((await open(second)).status, 200);

    // Deleting the question ends its link too.
    await call(`/api/x/ask-someone/questions/${id}/${question!.id}`, undefined, "DELETE");
    assert.equal((await open(second)).status, 404);
});
