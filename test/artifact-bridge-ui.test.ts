// What an artifact's page may ask of the app (#88, #89), in a real Chromium: its saved state, and a follow-up in the
// message box, only after the person taps the page (not after `window.focus()`), marked as the artifact's, unsent;
// nothing from a frame inside it, or once it navigates elsewhere (not even before that page's load event, and no answer
// held back reaches it); one follow-up every 2 seconds; and a notice, not a message, for a viewer.
import {
    type App,
    cleanUp,
    context,
    openApp,
    owner,
    root,
    say,
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
import type { BrowserPage } from "../src/server/browser/page.ts";
import { ArtifactStateDoc } from "../src/server/docs.ts";
import createArtifacts from "../src/server/extensions/artifacts.ts";
import type { PocketHost } from "../src/server/host.ts";
import { createHandler } from "../src/server/http.ts";

const chromium = findBrowser();
const real = {
    skip: chromium === undefined ? "no Chromium-based browser on this machine" : false,
} as const;

/**
 * Counts its opens in its saved state; offers a follow-up at once (refused: nobody tapped it) and again when tapped
 * anywhere; and has a frame of its own inside that tries to save state for it (refused: not the artifact's page).
 */
const CALC = `<!doctype html><html><body style="margin:0">
<button id="go" style="position:fixed;inset:0;width:100%;height:100%">Ask</button>
<script>
let count = 0;
const ask = (message) => new Promise((resolve) => {
    const requestId = String(Math.random()).slice(2);
    addEventListener("message", function hear(event) {
        if (event.source === parent && event.data && event.data.requestId === requestId) {
            removeEventListener("message", hear);
            resolve(event.data);
        }
    });
    parent.postMessage({ ...message, requestId }, "*");
});
(async () => {
    const got = await ask({ type: "pocket-state-get", schema: "v1" });
    count = ((got.state && got.state.count) || 0) + 1;
    await ask({ type: "pocket-state-set", schema: "v1", state: { count } });
    parent.postMessage({ type: "pocket-follow-up", text: "at load" }, "*");
    const inner = document.createElement("iframe");
    inner.src = "data:text/html," + encodeURIComponent("<script>for (const win of [top, parent]) { try { win.postMessage({ type: 'pocket-state-set', requestId: 'inner', schema: 'v1', state: { inner: true } }, '*'); } catch {} } try { parent.parent.postMessage({ type: 'pocket-state-set', requestId: 'inner', schema: 'v1', state: { inner: true } }, '*'); } catch {}<" + "/script>");
    document.body.append(inner);
})();
// Tells the test server each click it sees (see tapPage).
addEventListener("click", () => fetch("__TAPS__/tap", { mode: "no-cors" }), true);
document.getElementById("go").onclick = () =>
    parent.postMessage({ type: "pocket-follow-up", text: "Tell me about option " + count, selection: { option: count } }, "*");
</script></body></html>`;

/** Calls `window.focus()`, then asks for a follow-up with no tap; saves what it was told for the test to read. */
const FOCUS = `<!doctype html><html><body><script>
setTimeout(() => {
    window.focus();
    const requestId = "focus";
    addEventListener("message", function hear(event) {
        if (event.source === parent && event.data && event.data.type === "pocket-follow-up") {
            removeEventListener("message", hear);
            parent.postMessage({ type: "pocket-state-set", requestId, state: { answer: event.data } }, "*");
        }
    });
    parent.postMessage({ type: "pocket-follow-up", text: "FOCUS_NO_TAP" }, "*");
}, 700);
</script></body></html>`;

/** Names its schema with a number, for a get and for a set: both are refused the same way, with no request made. */
const SCHEMA = `<!doctype html><html><body><script>
const ask = (message) => new Promise((resolve) => {
    const requestId = String(Math.random()).slice(2);
    addEventListener("message", function hear(event) {
        if (event.source === parent && event.data && event.data.requestId === requestId) {
            removeEventListener("message", hear);
            resolve(event.data);
        }
    });
    parent.postMessage({ ...message, requestId }, "*");
});
(async () => {
    const got = await ask({ type: "pocket-state-get", schema: 1 });
    const set = await ask({ type: "pocket-state-set", schema: 1, state: { n: 1 } });
    await ask({ type: "pocket-state-set", schema: "v1", state: { got: got.error, set: set.error } });
})();
</script></body></html>`;

/** Asks for its state (the test holds the answer back), then goes to the page DEST 0.6 seconds on. */
const NAV = `<!doctype html><html><body><script>
parent.postMessage({ type: "pocket-state-get", requestId: "held", schema: "v1" }, "*");
setTimeout(() => { location.href = "__THERE__"; }, 600);
</script></body></html>`;

/**
 * The page NAV goes to (published Markdown, which has no bridge of its own): its scripts run while a slow image holds up its load
 * event. It tries every way in, and reports to the test server what it hears.
 */
const DEST = (base: string) => `<script>
const log = (what) => fetch("${base}/report?" + encodeURIComponent(what), { mode: "no-cors" });
addEventListener("error", (event) => log("error " + event.message));
addEventListener("message", (event) => log("heard " + JSON.stringify(event.data)));
const channel = new MessageChannel();
parent.postMessage({ type: "pocket-bridge" }, "*", [channel.port2]);
parent.postMessage({ type: "pocket-state-set", requestId: "x", schema: "v1", state: { hijacked: true } }, "*");
window.focus();
parent.postMessage({ type: "pocket-follow-up", text: "FROM_DEST" }, "*");
parent.postMessage({ type: "pocket-state-get", requestId: "y", schema: "v1" }, "*");
log("ready");
</script>
<img src="${base}/slow">
`;

/**
 * Goes elsewhere at once (to a published page, of the app's own address: the app lets a frame go nowhere else, and the
 * frame's sandbox sends it no cookie); the page there
 * tries to save state, and to offer a follow-up when tapped. It is Markdown, which has no bridge of its own.
 */
const AWAY = `<!doctype html><html><body><script>
location.href = "__THERE__";
</script></body></html>`;

const ELSEWHERE = `<button style="position:fixed;inset:0;width:100%;height:100%" onclick="parent.postMessage({ type: 'pocket-follow-up', text: 'from elsewhere' }, '*')">x</button>
<script>
parent.postMessage({ type: "pocket-state-set", requestId: "away", state: { away: true } }, "*");
</script>
`;

let app: App;
let server: Server;
let browsers: Browsers;
let page: BrowserPage;
let base = "";
let session: ConversationId;
let calls = 0;
/** A server of its own for the page NAV goes to: a slow image, and where that page reports. */
let elsewhere: Server;
let elsewhereBase = "";
let heard: string[] = [];
let taps = 0;
let slow: { end: () => void }[] = [];
/** What a busy machine (the whole suite at once) may take to open a viewer and load its page. */
const SLOW = 30_000;

async function inPage<T>(script: string): Promise<T> {
    return JSON.parse(await page.evaluate(script)) as T;
}

const boxText = () =>
    inPage<string>(
        `return JSON.stringify(document.querySelector(".composer textarea")?.value ?? "")`,
    );

const setBox = (text: string) =>
    inPage(`
        const box = document.querySelector(".composer textarea");
        box.value = ${JSON.stringify(text)};
        box.dispatchEvent(new Event("input", { bubbles: true }));
        return "null";
    `);

const notices = () =>
    inPage<string[]>(
        `const { store } = await import("/store.js"); return JSON.stringify(store.state.notices.map((each) => each.message))`,
    );

/** Open an artifact's viewer as the app does, once the one before has gone (a sheet stays for its fade). */
async function openViewer(id: string) {
    await until(
        async () =>
            !(await inPage<boolean>(
                `return JSON.stringify(Boolean(document.querySelector(".viewer")))`,
            )),
        "no viewer open",
        SLOW,
    );
    await inPage(`
        const { openSheet } = await import("/store.js");
        openSheet({ type: "viewer", id: ${JSON.stringify(id)} });
        return "null";
    `);
    await until(
        async () =>
            await inPage<boolean>(
                `return JSON.stringify(Boolean(document.querySelector(".viewer iframe")))`,
            ),
        "the viewer's frame",
        SLOW,
    );
}

const closeSheet = () =>
    inPage(`const { closeSheet } = await import("/store.js"); closeSheet(); return "null";`);

/** Tap the middle of a frame, as a person does: the frame takes the focus, and its page the click. */
async function tapFrame(selector: string) {
    // A viewer slides in: wait until the frame has held still for five frames, or the tap lands on a moving frame.
    await inPage(`
        const frame = document.querySelector(${JSON.stringify(selector)});
        const place = () => JSON.stringify(frame.getBoundingClientRect());
        let held = 0;
        let last = place();

        while (held < 5) {
            await new Promise((resolve) => requestAnimationFrame(resolve));

            const now = place();

            held = now === last ? held + 1 : 0;
            last = now;
        }

        return "null";
    `);

    const box = await inPage<{ x: number; y: number }>(`
        const box = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();
        return JSON.stringify({ x: box.x + box.width / 2, y: box.y + box.height / 2 });
    `);

    await page.click({ x: Math.round(box.x), y: Math.round(box.y) });
}

/**
 * Chromium routes a pointer to a just-opened frame by hit-test data that arrives after the frame is drawn, so on a busy
 * machine the first tap can go to nothing: tap again until the page reports a click.
 */
async function tapPage(selector: string) {
    for (let attempt = 0; attempt < 8; attempt += 1) {
        const seen = taps;

        await tapFrame(selector);

        try {
            await until(() => taps > seen, "the page to see the tap", 4000);

            return;
        } catch {
            // Not routed to the page: tap again.
        }
    }

    throw new Error("The calculator's page never saw a tap");
}

const savedFor = async (artifact: string) =>
    (await app.harness.snapshot(ArtifactStateDoc, session, context))?.items[artifact]?.[
        owner(app).id
    ]?.value;

async function publish(id: string, content: string, type?: string) {
    await createArtifacts({} as PocketHost).tools![0]!.execute(
        { id, title: id === "calc" ? "Calculator" : id, content, type } as never,
        {
            conversationId: session,
            taskId: 9000 + (calls += 1),
            callId: "publish",
            agent: async () => ({ cwd: work }),
            snapshot: app.harness.snapshot.bind(app.harness),
            commit: app.harness.commit.bind(app.harness),
        } as never,
        context,
    );
}

before(async () => {
    if (chromium === undefined) {
        return;
    }

    app = await openApp(scriptedModel());
    app.config.lastModel ??= { provider: "faux", modelId: "faux-1", thinkingLevel: "off" };
    ({ id: session } = await app.commands.createSession(owner(app), { cwd: work }));
    await publish("focus", FOCUS);
    await publish("schema", SCHEMA);
    elsewhere = createServer((request, response) => {
        const url = new URL(request.url ?? "/", "http://x");

        if (url.pathname === "/slow") {
            slow.push(response);

            return;
        }

        if (url.pathname === "/tap") {
            taps += 1;
            response.writeHead(204).end();

            return;
        }

        if (url.pathname === "/report") {
            heard.push(decodeURIComponent(url.search.slice(1)));
            response.writeHead(204).end();

            return;
        }

        response.writeHead(404).end();
    });
    await new Promise<void>((resolve) => elsewhere.listen(0, "127.0.0.1", resolve));
    elsewhereBase = `http://127.0.0.1:${(elsewhere.address() as { port: number }).port}`;
    // A frame goes nowhere but a page of the app's own address, and signed out (its sandbox sends no cookie): a
    // published page.
    await publish("calc", CALC.replace("__TAPS__", elsewhereBase));
    await publish("elsewhere", ELSEWHERE, "markdown");
    await publish("dest", DEST(elsewhereBase), "markdown");

    const there = async (id: string) => (await app.shares.create(session, owner(app), { id })).path;

    await publish("away", AWAY.replace("__THERE__", await there("elsewhere")));
    await publish("nav", NAV.replace("__THERE__", await there("dest")));
    server = createServer(
        createHandler({ app, listen: { host: "127.0.0.1", port: 0 }, restart: () => {} }),
    );
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    browsers = new Browsers({
        dataDir: mkdtempSync(join(root, "artifact-bridge-ui-")),
        load: async () => undefined,
        save: () => {},
    });
    page = await browsers.open(1);
    await page.setViewport({ width: 1440, height: 900, scale: 1, mobile: false });
    await page.navigate(`${base}/login?token=${encodeURIComponent(app.config.ownerToken)}`);
    await page.navigate(`${base}/s/${session}`);
    await until(
        async () =>
            await inPage<boolean>(
                `return JSON.stringify(Boolean(document.querySelector(".composer textarea")))`,
            ),
        "the message box",
        SLOW,
    );
});

after(async () => {
    for (const response of slow) {
        response.end();
    }

    elsewhere?.closeAllConnections();
    elsewhere?.close();
    await browsers?.closeAll({ final: true });
    server?.closeAllConnections();
    server?.close();
    await app?.close();
    cleanUp();
});

test(
    "a tap's follow-up joins the draft, the artifact named first; nothing before a tap, and nothing is sent",
    real,
    async () => {
        await setBox("my draft");
        await openViewer("calc");
        await until(
            async () => (await savedFor("calc")) !== undefined,
            "the page's saved state",
            SLOW,
        );
        await new Promise((resolve) => setTimeout(resolve, 500));
        assert.equal(await boxText(), "my draft", "the follow-up at load, with no tap, is refused");
        assert.deepEqual(await savedFor("calc"), { count: 1 }, "the frame inside it saved nothing");

        await tapPage(".viewer iframe");
        await until(
            async () => (await boxText()).includes("option 1"),
            "the follow-up in the box",
            SLOW,
        );
        assert.equal(
            await boxText(),
            'my draft\n\nFrom the artifact “Calculator”:\nTell me about option 1\n\n```json\n{\n  "option": 1\n}\n```',
        );
        assert.equal(
            (await app.transcripts.allEntries(session, false)).length,
            0,
            "the page made Pi do nothing",
        );
    },
);

test("its saved state comes back when it opens again", real, async () => {
    await closeSheet();
    await setBox("");
    await openViewer("calc");
    await until(
        async () =>
            (await savedFor("calc")) !== undefined &&
            ((await savedFor("calc")) as { count: number }).count === 2,
        "the count saved again",
        SLOW,
    );
    await tapPage(".viewer iframe");
    await until(
        async () => (await boxText()).includes("option 2"),
        "the second open's follow-up",
        SLOW,
    );
    assert.match(
        await boxText(),
        /^From the artifact “Calculator”:/,
        "never a command: the box starts with what it is from",
    );
});

test("a frame that went elsewhere is not heard", real, async () => {
    await closeSheet();
    await setBox("");
    await openViewer("away");
    await new Promise((resolve) => setTimeout(resolve, 1500));
    assert.equal(await savedFor("away"), undefined, "the page elsewhere saved nothing");
    await tapFrame(".viewer iframe");
    await new Promise((resolve) => setTimeout(resolve, 800));
    assert.equal(await boxText(), "", "nor offered a follow-up");
    await closeSheet();
});

test("focus is not a tap: window.focus() before a follow-up gets none", real, async () => {
    await closeSheet();
    await setBox("");
    await openViewer("focus");
    await until(async () => (await savedFor("focus")) !== undefined, "the page's note", SLOW);
    assert.deepEqual(await savedFor("focus"), {
        answer: {
            type: "pocket-follow-up",
            ok: false,
            error: "Only after the person taps the page",
        },
    });
    assert.equal(await boxText(), "", "the draft stays as it was");
    await closeSheet();
});

test(
    "a page it goes to, before its load event, gets no line; nor does a held answer",
    real,
    async () => {
        await closeSheet();
        await setBox("");
        heard = [];
        // The state is saved, and the answer to the first page's ask is held back until the page has gone.
        await inPage(`
        const { api, store } = await import("/store.js");
        await api("c/" + store.state.conversationId + "/artifact-state/nav", { state: { secret: 1 }, schema: "v1" });
        const real = window.fetch;
        window.__realFetch = real;
        window.__held = [];
        window.fetch = (url, init) =>
            String(url).includes("artifact-state/nav") && (init?.method ?? "GET") === "GET"
                ? new Promise((resolve, reject) => window.__held.push(() => real(url, init).then(resolve, reject)))
                : real(url, init);
        return "null";
    `);
        await openViewer("nav");
        await until(async () => heard.includes("ready"), "the page it goes to", SLOW);
        // That page is still loading (its image is slow): it has tried everything meanwhile.
        await new Promise((resolve) => setTimeout(resolve, 800));
        assert.deepEqual(await savedFor("nav"), { secret: 1 }, "it saved nothing");
        assert.equal(await boxText(), "", "it offered no follow-up");
        assert.equal(slow.length > 0, true, "its image was still loading");

        // Now the first page's answer comes.
        const held = await inPage<number>(
            `const held = window.__held.splice(0); held.forEach((go) => go()); return JSON.stringify(held.length)`,
        );

        assert.equal(held, 1, "the first page's ask was held");
        await new Promise((resolve) => setTimeout(resolve, 1000));
        assert.deepEqual(
            heard.filter((each) => each !== "ready"),
            [],
            "the page it goes to heard nothing",
        );
        await inPage(
            `window.fetch = (await import("/store.js")).api && window.fetch; return "null"`,
        );
        await closeSheet();
    },
);

test("a schema that is not a string is refused for a get and a set alike", real, async () => {
    await closeSheet();
    await openViewer("schema");
    await until(async () => (await savedFor("schema")) !== undefined, "the page's note", SLOW);
    assert.deepEqual(await savedFor("schema"), {
        got: "A schema is a string",
        set: "A schema is a string",
    });
    await closeSheet();
});

test("a selection cannot end the follow-up's JSON fence", real, async () => {
    const selection = { a: "x```\n# not data ```` end" };
    const text = await inPage<string>(`
        const { followUpText } = await import("/artifact-bridge.js");
        return JSON.stringify(followUpText("hi", ${JSON.stringify(selection)}, "the page"));
    `);
    const lines = text.split("\n");
    const open = lines.find((line) => line.endsWith("json"))!;
    const fence = open.slice(0, -4);

    assert.ok(fence.length >= 5, "longer than the longest run inside");
    assert.equal(lines.at(-1), fence);
    assert.equal(
        lines.filter((line) => line.startsWith(fence)).length,
        2,
        "the fence opens once and closes once",
    );
    assert.equal(
        await inPage<string>(
            `const { followUpText } = await import("/artifact-bridge.js"); return JSON.stringify(followUpText("hi", { a: 1 }, "x"))`,
        ),
        'From x:\nhi\n\n```json\n{\n  "a": 1\n}\n```',
        "an ordinary selection keeps three",
    );
});

test("HTML run from a reply: one follow-up every 2 seconds", real, async () => {
    const button = `<button id=b style="position:fixed;inset:0;width:100%;height:100%" onclick="parent.postMessage({type:'pocket-follow-up',text:'ran'},'*')">x</button>`;

    await say(
        app,
        session,
        `here:\n\`\`\`html\n<!doctype html><html><body style="margin:0">${button}</body></html>\n\`\`\``,
    );
    await until(
        async () =>
            await inPage<boolean>(
                `return JSON.stringify([...document.querySelectorAll(".rich-run")].length > 0)`,
            ),
        "the reply's Run",
        SLOW,
    );
    await page.click({ selector: ".rich-run" });
    await until(
        async () =>
            await inPage<boolean>(
                `return JSON.stringify(Boolean(document.querySelector("iframe.run-frame")))`,
            ),
        "the running frame",
        SLOW,
    );
    await new Promise((resolve) => setTimeout(resolve, 800));
    await setBox("");
    await tapFrame("iframe.run-frame");
    await tapFrame("iframe.run-frame");
    await until(async () => (await boxText()).includes("ran"), "the first follow-up", SLOW);
    await new Promise((resolve) => setTimeout(resolve, 500));
    assert.equal(
        await boxText(),
        "From the page in Pi's reply:\nran",
        "the second, too soon, is refused",
    );
});

test(
    "a page that hides a script in an odd comment before the bridge still needs a real tap",
    real,
    async () => {
        await closeSheet();
        await setBox("");
        // A browser ends the comment at "<!-->": the script after it runs, and tries to call the bridge's tap listener.
        await publish(
            "odd-comment",
            `<!--><script>
      const listen = window.addEventListener.bind(window);
      window.addEventListener = (type, callback, ...rest) => {
        if (type === "mousedown") { callback({ isTrusted: true }); }
        return listen(type, callback, ...rest);
      };
    </script><!-- -->
    <!doctype html><script>
      setTimeout(() => parent.postMessage({ type: "pocket-follow-up", text: "NO_TAP" }, "*"), 300);
    </script>`,
        );
        await until(
            () =>
                inPage<boolean>(
                    "return (await import('/store.js')).store.state.view.artifacts.some((each) => each.id === 'odd-comment')",
                ),
            "the artifact listed",
        );
        await openViewer("odd-comment");
        await new Promise((resolve) => setTimeout(resolve, 1200));
        assert.equal(await boxText(), "", "nobody tapped the page");
    },
);

test("a viewer gets a notice, not a message", real, async () => {
    const viewer = app.config.addUser("Vee", "viewer");
    // A browser of their own: this one is signed in as the owner.
    const theirs = new Browsers({
        dataDir: mkdtempSync(join(root, "artifact-bridge-viewer-")),
        load: async () => undefined,
        save: () => {},
    });

    page = await theirs.open(1);
    await page.setViewport({ width: 1440, height: 900, scale: 1, mobile: false });

    try {
        await page.navigate(`${base}/login?token=${encodeURIComponent(viewer.token)}`);
        await page.navigate(`${base}/s/${session}`);
        await until(
            async () =>
                await inPage<boolean>(
                    `return JSON.stringify(Boolean(document.querySelector(".transcript")))`,
                ),
            "the session, as a viewer",
            SLOW,
        );
        await openViewer("calc");
        await new Promise((resolve) => setTimeout(resolve, 800));
        await tapPage(".viewer iframe");
        await until(
            async () => (await notices()).some((each) => each.includes("you can only view here")),
            "the notice",
            SLOW,
        );
        assert.ok(
            await inPage<boolean>(
                `return JSON.stringify(Boolean(document.querySelector(".viewer")))`,
            ),
            "the viewer stays open",
        );
    } finally {
        await theirs.closeAll({ final: true });
        app.config.removeUser(viewer.user.id);
    }
});
