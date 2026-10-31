// The desktop bridge in a real page, with the host and Window Controls Overlay supplied before the app starts.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { join } from "node:path";
import { after, before, test } from "node:test";
import type { ConversationId } from "@earendil-works/pi-durable";
import { Browsers } from "../src/server/browser.ts";
import { findBrowser } from "../src/server/browser/discovery.ts";
import type { BrowserPage } from "../src/server/browser/page.ts";
import { createHandler } from "../src/server/http.ts";
import {
    type App,
    cleanUp,
    newSession,
    openApp,
    root,
    say,
    scriptedModel,
    until,
} from "./helpers.ts";

const chromium = findBrowser();
const real = {
    skip: chromium === undefined ? "no Chromium-based browser on this machine" : false,
} as const;

// A desktop app installs its bridge before the page's modules run. Keep the calls so the test can inspect them.
const preload = `<script>
    const desktop = globalThis.desktopTest = {
        notifications: [], badges: [], pinned: [], invoked: [], visible: true, listener: null,
        emit(event) { this.listener(event); },
    };
    globalThis.pocketHost = {
        apiVersion: 1,
        capabilities: ["menu", "badge", "notify", "visibility", "pinned", "open"],
        subscribe(listener) { desktop.listener = listener; },
        visible() { return desktop.visible; },
        notify(message) { desktop.notifications.push(message); },
        setBadge(count) { desktop.badges.push(count); },
        setPinned(sessions) { desktop.pinned.push(sessions); },
        menuItems() { return [{ id: "settings", label: "Server settings…" }]; },
        invoke(id) { desktop.invoked.push(id); },
    };
    const overlay = globalThis.overlayTest = Object.assign(new EventTarget(), {
        visible: false,
        side: "right",
        height: 32,
        getTitlebarAreaRect() {
            return { x: this.side === "left" ? 140 : 0, y: 0, width: innerWidth - 140, height: this.height };
        },
    });
    Object.defineProperty(navigator, "windowControlsOverlay", { value: overlay });
</script>`;
const index = readFileSync(new URL("../web/index.html", import.meta.url), "utf8").replace(
    "<head>",
    `<head>${preload}`,
);
let app: App;
let server: Server;
let browsers: Browsers;
let page: BrowserPage;
let base = "";
let session: ConversationId;
const queries: URLSearchParams[] = [];
const inPage = async <T>(script: string): Promise<T> =>
    JSON.parse(await page.evaluate(script)) as T;

before(async () => {
    if (chromium === undefined) {
        return;
    }

    app = await openApp(scriptedModel());
    session = await newSession(app);
    const handler = createHandler({
        app,
        listen: { host: "127.0.0.1", port: 0 },
        restart: () => {},
    });

    server = createServer((request, response) => {
        const url = new URL(request.url ?? "/", "http://localhost");

        if (url.pathname === "/api/events" || url.pathname === "/api/poll") {
            queries.push(url.searchParams);
        }

        if (url.pathname === "/" || /^\/s\/\d+$/.test(url.pathname)) {
            response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
            response.end(index);
        } else {
            void handler(request, response);
        }
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    browsers = new Browsers({
        dataDir: mkdtempSync(join(root, "desktop-ui-")),
        load: async () => undefined,
        save: () => {},
    });
    page = await browsers.open(1);
    await page.setViewport({ width: 1440, height: 900, scale: 1, mobile: false });
    await page.navigate(`${base}/login?token=${encodeURIComponent(app.config.ownerToken)}`);
    await until(
        () =>
            inPage<boolean>(
                `return JSON.stringify((await import("/store.js")).store.state.sessionsLoaded)`,
            ),
        "the signed-in desktop page",
        20_000,
    );
});

after(async () => {
    await browsers?.closeAll({ final: true });
    server?.closeAllConnections();
    server?.close();
    await app?.close();
    cleanUp();
});

test(
    "the host receives notifications, badge and pinned states, and its menu and visibility work",
    real,
    async () => {
        const query = queries.at(-1);

        assert.equal(query?.get("host"), "notify");
        assert.equal(query?.get("p"), "6");
        await until(
            () => [...app.clients].some((client) => client.desktop),
            "the desktop connection",
        );
        const message = {
            title: "Pi finished",
            body: "done",
            url: `/s/${session}`,
            tag: "desktop-ui",
        };

        for (const client of app.clients) {
            if (client.desktop) {
                client.send("desktop-notify", message);
            }
        }

        await until(
            () => inPage<boolean>(`return JSON.stringify(desktopTest.notifications.length === 1)`),
            "the native notification",
        );
        assert.deepEqual(
            await inPage(`return JSON.stringify(desktopTest.notifications[0])`),
            message,
        );
        await page.evaluate(`
        const { store } = await import("/store.js");
        store.set({ pinned: [${session}] });
        const [item] = (await import("/desktop.js")).hostMenuItems();
        item.run();
    `);
        assert.deepEqual(await inPage(`return JSON.stringify(desktopTest.invoked)`), ["settings"]);
        assert.equal(
            await inPage(`return JSON.stringify(desktopTest.pinned.at(-1)[0].state)`),
            "seen",
            "the bridge keeps its shape names, not the row's new idle theme state",
        );
        assert.equal(await inPage(`return JSON.stringify(desktopTest.badges.at(-1))`), 0);
        await page.evaluate(`
        desktopTest.visible = false;
        desktopTest.emit({ type: "visibility", visible: false });
    `);
        assert.equal(
            await inPage(`return JSON.stringify((await import("/host.js")).pageVisible())`),
            false,
        );
        await until(
            () => [...app.clients].some((client) => client.desktop && client.visible === false),
            "the hidden desktop connection",
        );
        await page.evaluate(`
        desktopTest.visible = true;
        desktopTest.emit({ type: "visibility", visible: true });
        desktopTest.emit({ type: "open", url: "/s/${session}" });
    `);
        await until(
            () =>
                inPage<boolean>(`
                const { store } = await import("/store.js");
                return JSON.stringify(store.state.view.conversation?.id === ${session});
            `),
            "the host-opened session",
        );
        await say(app, session, "a kept transcript");
        await until(
            () =>
                inPage<boolean>(`
                const { store } = await import("/store.js");
                return JSON.stringify(store.state.view.order.length > 0 &&
                    [...store.state.view.entries.values()].every((entry) => !entry.partial));
            `),
            "the kept transcript",
        );
        await page.evaluate(`(await import("/store.js")).connect()`);
        await until(() => queries.at(-1)?.has("have") === true, "the kept session query");
        assert.equal(queries.at(-1)?.get("host"), "notify");
        assert.equal(queries.at(-1)?.get("p"), "6");
    },
);

test(
    "session tabs make room for window controls on either side and release it when hidden",
    real,
    async () => {
        await page.evaluate(`
        localStorage.setItem("pocket.appearance", JSON.stringify({ sessionTabs: true, sidebar: "rail" }));
    `);
        await page.navigate(`${base}/s/${session}`);
        await until(
            () =>
                inPage<boolean>(
                    `return JSON.stringify(document.querySelector(".tabstrip") !== null)`,
                ),
            "the session tabs",
        );

        for (const [side, height] of [
            ["right", 32],
            ["left", 32],
            ["right", 60],
            ["left", 60],
        ] as const) {
            await page.evaluate(`
            overlayTest.visible = true;
            overlayTest.side = ${JSON.stringify(side)};
            overlayTest.height = ${height};
            overlayTest.dispatchEvent(new Event("geometrychange"));
        `);
            await until(
                () =>
                    inPage<boolean>(`
                    const strip = document.querySelector(".tabstrip");
                    const box = strip.getBoundingClientRect();
                    const room = ${side === "left" ? "140 - box.left" : "box.right - (innerWidth - 140)"};
                    const bar = document.querySelector(".topbar");
                    const touchesBar = bar.getBoundingClientRect().top <= ${height + 1};
                    return JSON.stringify(document.documentElement.dataset.windowControls === ${JSON.stringify(side)} &&
                        strip.dataset.underControls === "bar" &&
                        parseFloat(getComputedStyle(strip).${side === "left" ? "paddingLeft" : "paddingRight"}) >= Math.round(room) &&
                        (bar.dataset.underControls === "bar") === touchesBar);
                `),
                `${side} window controls (${height}px) beside each bar they cover`,
            );
        }

        await page.evaluate(`
        overlayTest.visible = false;
        overlayTest.dispatchEvent(new Event("geometrychange"));
    `);
        await until(
            () =>
                inPage<boolean>(`
                return JSON.stringify(document.documentElement.dataset.windowControls === "none" &&
                    document.querySelector("[data-under-controls]") === null);
            `),
            "no room without window controls",
        );
    },
);

test(
    "a tiled window is cut around window controls, and a window that opens has its room in its first frame",
    real,
    async () => {
        await page.evaluate(`
        localStorage.setItem("pocket.appearance", JSON.stringify({ sessionTabs: false, sidebar: "open", tiling: true }));
    `);
        await page.navigate(`${base}/s/${session}`);
        await until(
            () =>
                inPage<boolean>(
                    `return JSON.stringify(document.querySelector(".topbar") !== null)`,
                ),
            "the conversation's top bar",
        );

        // On the left, the sidebar is under the buttons. It has no bar: it starts below them, and is not cut.
        await page.evaluate(`
        overlayTest.visible = true;
        overlayTest.side = "left";
        overlayTest.height = 32;
        overlayTest.dispatchEvent(new Event("geometrychange"));
    `);
        await until(
            () =>
                inPage<boolean>(`
                const sidebar = document.querySelector(".sidebar");
                return JSON.stringify(sidebar.dataset.underControls === "push" &&
                    document.querySelector("[data-controls-notch]") === null);
            `),
            "the sidebar starts below left window controls",
        );

        // On the right, the conversation's top bar is: its window is cut around them. A window cut on the left is
        // the same, mirrored.
        await page.evaluate(`
        overlayTest.side = "right";
        overlayTest.dispatchEvent(new Event("geometrychange"));
    `);
        await until(
            () =>
                inPage<boolean>(`
                const window = document.querySelector(".topbar").closest(".layout > .window");
                const box = window.getBoundingClientRect();
                const w = Math.round(box.right - (innerWidth - 140) + 6);
                return JSON.stringify(document.documentElement.dataset.tiling !== "on" ||
                    (window.hasAttribute("data-controls-notch") &&
                        window.style.getPropertyValue("--notch-w") === w + "px" &&
                        window.style.getPropertyValue("--notch-h") === Math.round(32 - box.top + 6) + "px" &&
                        (!CSS.supports("corner-shape", "notch") ||
                            getComputedStyle(window).borderTopRightRadius.startsWith(w + "px"))));
            `),
            "the window under right window controls is cut around them",
        );

        // The subagents board takes the conversation's place: its bar makes room before the frame that shows it.
        const frames = await inPage<string[]>(`
            const seen = [];
            const look = () => {
                const head = document.querySelector(".board-head");
                seen.push(head === null ? "none" : head.dataset.underControls ?? "no room");
            };
            await new Promise((done) => requestAnimationFrame(done));
            (await import("/sessions.js")).toggleBoard();
            for (let frame = 0; frame < 4; frame += 1) {
                await new Promise((done) => requestAnimationFrame(done));
                look();
            }
            (await import("/sessions.js")).toggleBoard();
            return JSON.stringify(seen);
        `);

        assert.deepEqual(
            frames.filter((each) => each !== "none"),
            frames.filter((each) => each !== "none").map(() => "bar"),
        );
        assert.ok(frames.includes("bar"), `the board showed: ${frames.join(", ")}`);

        await page.evaluate(`
        overlayTest.visible = false;
        overlayTest.dispatchEvent(new Event("geometrychange"));
    `);
        await until(
            () =>
                inPage<boolean>(
                    `return JSON.stringify(document.querySelector("[data-controls-notch]") === null)`,
                ),
            "no cut without window controls",
        );
    },
);

test(
    "with window controls, every window's top bar moves the window by its empty room, and what is in it takes clicks",
    real,
    async () => {
        await page.evaluate(`
        localStorage.setItem("pocket.appearance", JSON.stringify({ sessionTabs: false, sidebar: "open", tiling: true }));
    `);
        await page.navigate(`${base}/s/${session}`);
        await until(
            () =>
                inPage<boolean>(
                    `return JSON.stringify(document.querySelector(".topbar") !== null && document.querySelector(".sessions-head") !== null)`,
                ),
            "the top bar and the sidebar",
        );

        const regions = `
            const region = (selector) => getComputedStyle(document.querySelector(selector)).appRegion;
            return JSON.stringify({
                topbar: region(".topbar"),
                sessions: region(".sessions-head"),
                title: region(".topbar > .title"),
                titleFits: document.querySelector(".topbar > .title").getBoundingClientRect().right <
                    [...document.querySelectorAll(".topbar > .icon-button")]
                        .filter((each) => each.getBoundingClientRect().width > 0)[0].getBoundingClientRect().left - 12,
                button: region(".sessions-head .new-button"),
                search: region(".search input"),
            });
        `;

        // In a browser tab there is no window to move: nothing is a drag region.
        const tab = await inPage<Record<string, string | boolean>>(regions);

        assert.equal(tab.topbar, "none");
        assert.equal(tab.sessions, "none");

        for (const side of ["right", "left"] as const) {
            await page.evaluate(`
            overlayTest.visible = true;
            overlayTest.side = ${JSON.stringify(side)};
            overlayTest.height = 32;
            overlayTest.dispatchEvent(new Event("geometrychange"));
        `);
            await until(
                () =>
                    inPage<boolean>(
                        `return JSON.stringify(document.documentElement.dataset.windowControls === ${JSON.stringify(side)})`,
                    ),
                `${side} window controls`,
            );

            assert.deepEqual(await inPage(regions), {
                topbar: "drag",
                sessions: "drag",
                title: "no-drag",
                titleFits: true,
                button: "no-drag",
                search: "no-drag",
            });
        }

        await page.evaluate(`
        overlayTest.visible = false;
        overlayTest.dispatchEvent(new Event("geometrychange"));
    `);
        await until(
            () =>
                inPage<boolean>(
                    `return JSON.stringify(getComputedStyle(document.querySelector(".topbar")).appRegion === "none")`,
                ),
            "no drag regions without window controls",
        );
    },
);
