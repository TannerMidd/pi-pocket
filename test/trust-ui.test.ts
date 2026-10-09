// Project trust in a real browser at phone size, where this machine has Chromium: the owner is asked above the message
// box when a session's project has skills of its own, answers there or with /trust, and a guest is never asked.
import { type App, cleanUp, newSession, openApp, root, scriptedModel, until } from "./helpers.ts";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { ProjectTrustStore } from "@earendil-works/pi-coding-agent";
import type { ConversationId } from "@earendil-works/pi-durable";
import { Browsers } from "../src/server/browser.ts";
import { findBrowser } from "../src/server/browser/discovery.ts";
import type { BrowserPage } from "../src/server/browser/page.ts";
import { VIEWPORTS } from "../src/server/browser/viewport.ts";
import { createHandler } from "../src/server/http.ts";

const chromium = findBrowser();
const real = {
    skip: chromium === undefined ? "no Chromium-based browser on this machine" : false,
} as const;

let app: App;
let server: Server;
let browsers: Browsers;
let page: BrowserPage;
let base = "";

/** Pi's saved decision for a folder: true, false, or null for none. */
const decision = (folder: string) =>
    new ProjectTrustStore(process.env.PI_CODING_AGENT_DIR!).get(folder);

/** A git repository with a skill of its own in `.agents/skills`, and a session working in it. */
async function project(
    skill: string,
    within = root,
): Promise<{ folder: string; id: ConversationId }> {
    const folder = realpathSync(mkdtempSync(join(within, "trust-ui-")));

    mkdirSync(join(folder, ".git"));
    mkdirSync(join(folder, ".agents", "skills", skill), { recursive: true });
    writeFileSync(
        join(folder, ".agents", "skills", skill, "SKILL.md"),
        `---\nname: ${skill}\ndescription: The ${skill} steps.\n---\nDo the ${skill} steps.\n`,
    );

    return { folder, id: await newSession(app, folder) };
}

/** Run a script in a page and read back the JSON it returns. */
async function inPage<T>(script: string, on = page): Promise<T> {
    return JSON.parse(await on.evaluate(script)) as T;
}

/** Wait until a script in the page returns true. */
const see = (script: string, what: string, on = page) =>
    until(async () => (await inPage<boolean>(script, on)) === true, what);

/**
 * Past a sheet's rise, as a person's next tap is: a tap right after something slid in under the finger is let go
 * (`back.js`), and its rows are still moving.
 */
const settled = () => new Promise((resolve) => setTimeout(resolve, 450));

/** The question bar's text, or null when it does not show. */
const bar = `return JSON.stringify(document.querySelector(".trust-bar")?.textContent ?? null)`;

/** Open a session at phone size, as its owner, and wait for its message box. */
async function open(id: ConversationId, on = page): Promise<void> {
    await on.setViewport(VIEWPORTS.mobile);
    await on.navigate(`${base}/s/${id}`);
    await see(
        `return JSON.stringify(document.querySelector(".composer textarea") !== null)`,
        "the message box",
        on,
    );
}

before(async () => {
    if (chromium === undefined) {
        return;
    }

    app = await openApp(scriptedModel());
    server = createServer(
        createHandler({ app, listen: { host: "127.0.0.1", port: 0 }, restart: () => {} }),
    );
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    browsers = new Browsers({
        dataDir: mkdtempSync(join(root, "trust-ui-browser-")),
        load: async () => undefined,
        save: () => {},
    });
    page = await browsers.open(1);
    await page.navigate(`${base}/login?token=${encodeURIComponent(app.config.ownerToken)}`);
    await see(
        `return JSON.stringify((await import("/store.js")).store.state.me?.role === "owner")`,
        "signed in",
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
    "the owner is asked above the message box, and trusting gives Pi the project's skills",
    real,
    async () => {
        const { folder, id } = await project("deploy");

        await open(id);
        await see(
            `return JSON.stringify(document.querySelector(".trust-bar")?.textContent.includes("deploy") === true)`,
            "the question",
        );
        assert.equal(
            await inPage<boolean>(
                `return JSON.stringify(document.documentElement.scrollWidth <= innerWidth)`,
            ),
            true,
            "the bar fits the phone's width",
        );

        await page.click({ label: "Review" });
        await see(
            `return JSON.stringify(document.querySelector(".sheet")?.textContent.includes("Its own skills, in .agents/skills: deploy.") === true)`,
            "the sheet, with what trusting it loads",
        );
        assert.equal(decision(folder), null, "looking decides nothing");
        await settled();
        await page.click({ label: "Trust this folder" });
        await see(
            `return JSON.stringify(document.querySelector(".sheet") === null)`,
            "the sheet closed",
        );
        await see(
            `return JSON.stringify(document.querySelector(".trust-bar") === null)`,
            "the bar gone",
        );
        assert.equal(decision(folder), true);
        assert.match(
            await inPage<string>(
                `return JSON.stringify((await import("/store.js")).store.state.notices.map((notice) => notice.message).join(" | "))`,
            ),
            /Trusted this project\. Pi has its skills from now on: deploy\./,
        );

        // The skill is among the slash commands at once.
        await settled();
        await page.type({ selector: ".composer textarea" }, "/skill");
        await see(
            `return JSON.stringify([...document.querySelectorAll("[role=option]")].some((option) => option.textContent.includes("/skill:deploy")))`,
            "the skill among the commands",
        );
        await page.type({ selector: ".composer textarea" }, "");
    },
);

test("Don't trust stops the question, and /trust changes the answer", real, async () => {
    const { folder, id } = await project("lint");

    await open(id);
    await see(
        `return JSON.stringify(document.querySelector(".trust-bar") !== null)`,
        "the question",
    );
    await page.click({ label: "Don't trust" });
    await see(
        `return JSON.stringify(document.querySelector(".trust-bar") === null)`,
        "the bar gone",
    );
    assert.equal(decision(folder), false);

    // At phone size Enter starts a new line: Send runs the command.
    await page.type({ selector: ".composer textarea" }, "/trust");
    await page.click({ label: "Send" });
    await see(
        `return JSON.stringify(document.querySelector(".sheet")?.textContent.includes("Not trusted.") === true)`,
        "the sheet, saying so",
    );
    assert.equal(
        await inPage<string>(
            `return JSON.stringify([...document.querySelectorAll(".sheet .list-item")].find((row) => row.textContent.startsWith("Don't trust"))?.textContent ?? "")`,
        ),
        "Don't trustcurrent",
        "the saved answer is marked",
    );
    await settled();
    await page.click({ label: "Trust this folder" });
    await see(
        `return JSON.stringify(document.querySelector(".sheet") === null)`,
        "the sheet closed",
    );
    assert.equal(decision(folder), true);
});

test("a guest is never asked, and has no /trust", real, async () => {
    const { folder, id } = await project("guest-skill");
    const { user, token } = app.config.addUser("Gus", "guest");
    const guest = await browsers.open(2);

    try {
        await guest.navigate(`${base}/login?token=${encodeURIComponent(token)}`);
        await open(id, guest);
        // The owner, in the same session, is asked: so the question is there to be asked.
        await open(id);
        await see(
            `return JSON.stringify(document.querySelector(".trust-bar") !== null)`,
            "the owner's question",
        );
        assert.equal(await inPage<string | null>(bar, guest), null);
        assert.equal(
            await inPage<boolean>(
                `return JSON.stringify((await import("/commands.js")).parseCommand("/trust") === null)`,
                guest,
            ),
            true,
        );
        assert.equal(
            await inPage<unknown>(
                `return JSON.stringify((await import("/store.js")).store.state.trust)`,
                guest,
            ),
            null,
            "a guest's app does not even ask the server",
        );
        assert.equal(decision(folder), null);
    } finally {
        await browsers.close(2);
        app.config.removeUser(user.id);
    }
});

test(
    "Not now puts the question off in this tab; the folder above, trusted, shows as such",
    real,
    async () => {
        // A folder of its own above the project, so trusting it reaches no other test's project.
        const above = realpathSync(mkdtempSync(join(root, "trust-ui-above-")));
        const { folder, id } = await project("later", above);

        await open(id);
        await see(
            `return JSON.stringify(document.querySelector(".trust-bar") !== null)`,
            "the question",
        );
        await page.click({ label: "Not now" });
        await see(
            `return JSON.stringify(document.querySelector(".trust-bar") === null)`,
            "the bar put off",
        );
        assert.equal(decision(folder), null, "putting it off decides nothing");
        await page.reload();
        await see(
            `return JSON.stringify(document.querySelector(".composer textarea") !== null)`,
            "the session again",
        );
        await new Promise((resolve) => setTimeout(resolve, 600));
        assert.equal(await inPage<string | null>(bar), null, "still put off after a reload");

        // The sheet still answers it: trust the folder above, and it says so.
        await page.evaluate(`(await import("/store.js")).openSheet({ type: "trust" })`);
        await see(
            `return JSON.stringify(document.querySelector(".sheet")?.textContent.includes("No decision yet") === true)`,
            "the sheet",
        );
        await settled();
        await page.click({ label: "Trust the folder above it" });
        await see(
            `return JSON.stringify(document.querySelector(".sheet") === null)`,
            "the sheet closed",
        );
        assert.equal(decision(folder), true);
        assert.equal(decision(above), true);
        await settled();
        await page.evaluate(`(await import("/store.js")).openSheet({ type: "trust" })`);
        await see(
            `return JSON.stringify(document.querySelector(".sheet")?.textContent.includes("Trusted, as the folder it is in") === true)`,
            "the sheet saying where the trust comes from",
        );
    },
);
