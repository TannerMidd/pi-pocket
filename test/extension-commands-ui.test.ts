// Native commands in the real phone-sized app: both tapping a suggestion and submitting arguments reach the server.
import {
    type App,
    cleanUp,
    fakeTab,
    newSession,
    openApp,
    owner,
    root,
    scriptedModel,
    until,
    work,
} from "./helpers.ts";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { fauxAssistantMessage, fauxText } from "@earendil-works/pi-ai";
import { type ConversationId, defineDoc } from "@earendil-works/pi-durable";
import { Browsers } from "../src/server/browser.ts";
import { findBrowser } from "../src/server/browser/discovery.ts";
import type { BrowserPage } from "../src/server/browser/page.ts";
import { VIEWPORTS } from "../src/server/browser/viewport.ts";
import { createHandler } from "../src/server/http.ts";

const chromium = findBrowser();
const real = {
    skip: chromium === undefined ? "no Chromium-based browser on this machine" : false,
} as const;
const context = BACKGROUND_CONTEXT;
const requests: string[] = [];
const UiCommandDoc = defineDoc<{ count: number; value: string }>({
    kind: "test.native-ui-command",
    version: 1,
    scope: "conversation",
    history: "latest",
    fork: "current",
    initial: () => ({ count: 0, value: "" }),
});

let app: App;
let server: Server;
let browsers: Browsers;
let page: BrowserPage;
let base = "";
let id: ConversationId;

async function inPage<T>(script: string): Promise<T> {
    return JSON.parse(await page.evaluate(script)) as T;
}

async function type(text: string): Promise<void> {
    await page.evaluate(`
        const box = document.querySelector(".composer textarea");
        box.value = ${JSON.stringify(text)};
        box.dispatchEvent(new Event("input", { bubbles: true }));
        await new Promise(requestAnimationFrame);
    `);
}

async function suggestions(): Promise<string[]> {
    return inPage<string[]>(`
        return JSON.stringify(Array.from(document.querySelectorAll(".composer-wrap .command"),
            (button) => button.textContent.trim()));
    `);
}

async function pick(name: string): Promise<void> {
    await page.evaluate(`
        const button = Array.from(document.querySelectorAll(".composer-wrap .command"))
            .find((each) => each.textContent.includes(${JSON.stringify(`/${name}`)}));
        button.click();
    `);
}

const state = () => app.harness.snapshot(UiCommandDoc, id, context);

before(async () => {
    if (chromium === undefined) {
        return;
    }

    app = await openApp(
        scriptedModel((request) => {
            requests.push(JSON.stringify(request));

            return fauxAssistantMessage([fauxText("A model reply.")]);
        }),
    );
    const file = "native-ui.ts";

    writeFileSync(
        join(app.dataDir, "extensions", file),
        `/** Native commands used by the UI tests. */
import { defineDoc } from "@earendil-works/pi-durable";
const Settings = defineDoc({
    kind: "test.native-ui-command", version: 1, scope: "conversation", history: "latest", fork: "current",
    initial: () => ({ count: 0, value: "" }),
});
export default (host) => {
    const change = async (ctx, value) => ctx.commit(async (tx) => {
        const settings = await tx.doc(Settings, ctx.conversationId);
        settings.count++;
        if (value !== undefined) { settings.value = value; }
    });
    host.commands.register({
        name: "ui-status", description: "Show the native extension status", scope: "conversation",
        async handler(_args, ctx) {
            await change(ctx);
            return {
                type: "card",
                output: 'Native status\\n<img src=x onerror="globalThis.commandInjected=true">',
            };
        },
    });
    host.commands.register({
        name: "ui-set", args: "<value>", description: "Set the extension value", scope: "conversation",
        async handler(args, ctx) {
            await change(ctx, args);
            return { type: "toast", level: "info", message: "Value is " + args };
        },
    });
    host.commands.register({
        name: "ui-toast", description: "Save a setting", scope: "conversation",
        async handler(_args, ctx) {
            await change(ctx, _args);
            if (_args === "hold") {
                await new Promise((resolve) => ctx.signal.addEventListener("abort", resolve, { once: true }));
            }
            return { type: "toast", level: "info", message: "Native setting saved." };
        },
    });
    host.commands.register({
        name: "ui-global", description: "Change an owner setting", scope: "global",
        async handler(_args, ctx) {
            await change(ctx, "global setting");
            return { type: "toast", level: "info", message: "Global setting saved." };
        },
    });
    return [];
};
`,
    );
    await app.setExtensionEnabled(owner(app), file, true);
    id = await newSession(app);
    server = createServer(
        createHandler({
            app,
            listen: { host: "127.0.0.1", port: 0 },
            restart: () => {},
        }),
    );
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    browsers = new Browsers({
        dataDir: mkdtempSync(join(root, "native-commands-ui-")),
        load: async () => undefined,
        save: () => {},
    });
    page = await browsers.open(1);
    await page.setViewport(VIEWPORTS.mobile);
    await page.navigate(`${base}/login?token=${encodeURIComponent(app.config.ownerToken)}`);
    await until(
        async () =>
            await inPage<boolean>(`
        return JSON.stringify(document.querySelector(".home-list") !== null);
    `),
        "the authenticated app",
        20_000,
    );
    await page.navigate(`${base}/s/${id}`);
    await until(
        async () =>
            await inPage<boolean>(`
        const { store } = await import("/store.js");
        return JSON.stringify(document.querySelector(".composer textarea") !== null &&
            store.state.server.extensionCommands?.some((command) => command.name === "ui-status"));
    `),
        "the command metadata and composer",
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
    "tapping a native suggestion executes it once and renders a plain-text card without a model call",
    real,
    async () => {
        const before = (await state())?.count ?? 0;

        await type("/ui");
        assert.ok((await suggestions()).some((text) => text.includes("/ui-status")));
        await pick("ui-status");
        await until(async () => (await state())?.count === before + 1, "the native handler");
        await until(
            async () =>
                await inPage<boolean>(`
        return JSON.stringify(document.querySelector(".command-card") !== null);
    `),
            "the command card",
        );
        const card = await inPage<{
            text: string;
            images: number;
            injected: boolean;
            overflow: boolean;
        }>(`
        const card = document.querySelector(".command-card");
        return JSON.stringify({
            text: card.textContent,
            images: card.querySelectorAll("img").length,
            injected: globalThis.commandInjected === true,
            overflow: document.documentElement.scrollWidth > innerWidth,
        });
    `);

        assert.match(card.text, /Native status/);
        assert.match(card.text, /<img src=x/);
        assert.equal(card.images, 0);
        assert.equal(card.injected, false);
        assert.equal(card.overflow, false);
        assert.equal(requests.length, 0);
    },
);

test("a command with arguments fills the box before its Run button executes it", real, async () => {
    const before = (await state())?.count ?? 0;

    await type("/ui");
    assert.ok((await suggestions()).some((text) => text.includes("/ui-set")));
    await pick("ui-set");
    assert.equal(
        await inPage<string>(`
        return JSON.stringify(document.querySelector(".composer textarea").value);
    `),
        "/ui-set ",
    );
    assert.equal((await state())?.count ?? 0, before);
    await type("/ui-set chosen value");
    await page.evaluate(`document.querySelector(".composer .send").click()`);
    await until(async () => (await state())?.value === "chosen value", "the command arguments");

    assert.equal((await state())?.count, before + 1);
    assert.equal(requests.length, 0);
    assert.equal(
        await inPage<boolean>(`
        return JSON.stringify(document.body.textContent.includes("Value is chosen value"));
    `),
        true,
    );
});

test("another browser sees the persisted card but not the caller's toast", real, async () => {
    const peer = new Browsers({
        dataDir: mkdtempSync(join(root, "native-commands-reader-")),
        load: async () => undefined,
        save: () => {},
    });
    const viewer = app.config.addUser("Reader", "viewer");

    try {
        const reader = await peer.open(1);

        await reader.setViewport(VIEWPORTS.mobile);
        await reader.navigate(`${base}/login?token=${encodeURIComponent(viewer.token)}`);
        await until(
            async () =>
                JSON.parse(
                    await reader.evaluate(`
            return JSON.stringify(document.querySelector(".home-list") !== null);
        `),
                ) === true,
            "the reader's login",
            20_000,
        );
        await reader.navigate(`${base}/s/${id}`);
        await until(
            async () =>
                JSON.parse(
                    await reader.evaluate(`
            return JSON.stringify(document.querySelector(".command-card")?.textContent.includes("Native status") === true);
        `),
                ) === true,
            "the card in another browser",
            20_000,
        );
        const before = (await state())?.count ?? 0;
        const modelCalls = requests.length;

        await type("/ui-toast");
        await pick("ui-toast");
        await until(async () => (await state())?.count === before + 1, "the private toast handler");
        await until(
            async () =>
                await inPage<boolean>(`
            return JSON.stringify(document.body.textContent.includes("Native setting saved."));
        `),
            "the caller's toast",
        );
        assert.equal(
            JSON.parse(
                await reader.evaluate(`
            const { store } = await import("/store.js");
            return JSON.stringify(store.state.notices.some((notice) => notice.message === "Native setting saved."));
        `),
            ),
            false,
        );
        assert.equal(requests.length, modelCalls);
    } finally {
        await peer.closeAll({ final: true });
    }
});

test("an unknown longer command token still goes to Pi, not to the extension", real, async () => {
    const before = (await state())?.count ?? 0;
    const modelCalls = requests.length;

    await type("/ui-status-extra ordinary text");
    await page.evaluate(`document.querySelector(".composer .send").click()`);
    await until(
        () =>
            requests
                .slice(modelCalls)
                .some((request) => request.includes("/ui-status-extra ordinary text")),
        "the ordinary slash message",
    );
    assert.equal((await state())?.count ?? 0, before);
});

test(
    "a same-name prompt template keeps its normal model path instead of invoking the extension",
    real,
    async () => {
        mkdirSync(join(work, ".pi", "prompts"), { recursive: true });
        writeFileSync(join(work, ".pi", "prompts", "ui-set.md"), "Template branch: $ARGUMENTS\n");
        await page.navigate(`${base}/s/${id}`);
        await until(
            async () =>
                await inPage<boolean>(`
        return JSON.stringify(document.querySelector(".composer textarea") !== null);
    `),
            "the reloaded composer",
            20_000,
        );
        await type("/ui-set from template");
        await until(
            async () =>
                await inPage<boolean>(`
        const { store } = await import("/store.js");
        return JSON.stringify(store.state.templates?.list.some((template) => template.name === "ui-set") === true);
    `),
            "the real prompt template",
        );
        const before = (await state())?.count ?? 0;
        const modelCalls = requests.length;

        await page.evaluate(`document.querySelector(".composer .send").click()`);
        await until(
            async () =>
                await inPage<boolean>(`
        return JSON.stringify(document.querySelector(".composer textarea").value === "");
    `),
            "the submitted command or template",
        );
        assert.equal(
            (await state())?.count ?? 0,
            before,
            "a prompt template must not run an extension handler",
        );
        await until(
            () =>
                requests
                    .slice(modelCalls)
                    .some((request) => request.includes("Template branch: from template")),
            "the expanded prompt",
        );
    },
);

test(
    "a native invocation does not reuse a pre-submission lookup for its collision check",
    real,
    async () => {
        const before = (await state())?.count ?? 0;
        const modelCalls = requests.length;
        const prompt = join(work, ".pi", "prompts", "ui-toast.md");

        mkdirSync(join(work, ".pi", "prompts"), { recursive: true });
        await page.evaluate(`
        const { store } = await import("/store.js");
        const { loadTemplates } = await import("/commands.js");
        await loadTemplates(true);
        const original = globalThis.fetch;
        globalThis.restoreTemplateFetch = () => { globalThis.fetch = original; };
        globalThis.templateGets = 0;
        const released = new Promise((resolve) => { globalThis.releaseOldTemplates = resolve; });
        globalThis.fetch = async (input, ...rest) => {
            const held = String(input).endsWith("/prompts") && ++globalThis.templateGets === 1;
            const response = await original(input, ...rest);
            if (held) {
                globalThis.heldTemplateList = await response.clone().json();
                globalThis.templateResponseHeld = true;
                await released;
            }
            return response;
        };
        store.set({ templates: null });
        globalThis.oldTemplateLookup = loadTemplates();
    `);

        try {
            await until(
                async () =>
                    await inPage<boolean>(`
                return JSON.stringify(globalThis.templateResponseHeld === true);
            `),
                "the already-received template response",
            );
            assert.equal(
                await inPage<boolean>(`
            return JSON.stringify(globalThis.heldTemplateList.some((template) => template.name === "ui-toast"));
        `),
                false,
            );
            writeFileSync(prompt, "NEW_TEMPLATE_BEFORE_NATIVE_SUBMISSION\n");
            await type("/ui-toast");
            await page.evaluate(`
            document.querySelector(".composer .send").click();
            globalThis.releaseOldTemplates();
            await globalThis.oldTemplateLookup;
        `);
            await until(async () => {
                const changed = ((await state())?.count ?? 0) !== before;
                const warned = await inPage<boolean>(`
                const { store } = await import("/store.js");
                return JSON.stringify(store.state.notices.some((notice) =>
                    notice.message.includes("A prompt template now has that command name")));
            `);

                return changed || warned;
            }, "the invocation's collision-check result");
            assert.deepEqual(
                {
                    nativeInvocations: ((await state())?.count ?? 0) - before,
                    modelRequests: requests.length - modelCalls,
                },
                { nativeInvocations: 0, modelRequests: 0 },
                "a template that exists before submission must not run the native handler or silently call Pi",
            );
            assert.equal(
                await inPage<number>(`
            return JSON.stringify(globalThis.templateGets);
        `),
                2,
            );
            assert.equal(
                await inPage<boolean>(`
            const { store } = await import("/store.js");
            return JSON.stringify(store.state.templates.list.some((template) => template.name === "ui-toast"));
        `),
                true,
                "the older response cannot overwrite the fresh list",
            );
        } finally {
            await page.evaluate(`
            globalThis.releaseOldTemplates();
            await globalThis.oldTemplateLookup;
            globalThis.restoreTemplateFetch();
            delete globalThis.restoreTemplateFetch;
            delete globalThis.releaseOldTemplates;
            delete globalThis.oldTemplateLookup;
            delete globalThis.heldTemplateList;
            delete globalThis.templateResponseHeld;
            delete globalThis.templateGets;
        `);
            rmSync(prompt, { force: true });
            await page.evaluate(`
            const { loadTemplates } = await import("/commands.js");
            await loadTemplates(true);
        `);
        }
    },
);

test("a failed template lookup does not guess which slash action to execute", real, async () => {
    const before = (await state())?.count ?? 0;
    const modelCalls = requests.length;

    await page.evaluate(`
        globalThis.savedFetch = fetch;
        globalThis.fetch = (input, ...rest) => String(input).endsWith("/prompts")
            ? Promise.reject(new TypeError("simulated prompt lookup failure"))
            : globalThis.savedFetch(input, ...rest);
    `);

    try {
        await type("/ui-toast");
        await page.evaluate(`document.querySelector(".composer .send").click()`);
        await until(async () => {
            const changed = ((await state())?.count ?? 0) !== before;
            const warned = await inPage<boolean>(`
                const { store } = await import("/store.js");
                return JSON.stringify(store.state.notices.some((notice) => notice.message.includes("simulated prompt lookup failure")));
            `);

            return changed || warned;
        }, "a command result or lookup error");
        assert.equal((await state())?.count ?? 0, before);
        assert.equal(requests.length, modelCalls);
    } finally {
        await page.evaluate(
            `globalThis.fetch = globalThis.savedFetch; delete globalThis.savedFetch;`,
        );
        await page.navigate(`${base}/s/${id}`);
        await until(
            async () =>
                await inPage<boolean>(`
            return JSON.stringify(document.querySelector(".composer textarea") !== null);
        `),
            "the restored composer",
            20_000,
        );
    }
});

test(
    "a lost reply survives a browser reload and module rebuild without repeating the operation",
    real,
    async () => {
        const before = (await state())?.count ?? 0;
        const modelCalls = requests.length;

        await page.evaluate(`
        const original = fetch;
        let lose = true;
        globalThis.fetch = async (...args) => {
            const response = await original(...args);
            if (lose && String(args[0]).endsWith("/extension-commands")) {
                lose = false;
                await response.clone().text();
                throw new TypeError("simulated lost command reply");
            }
            return response;
        };
    `);
        await type("/ui-toast retry");
        await page.evaluate(`document.querySelector(".composer .send").click()`);
        await until(
            async () =>
                await inPage<boolean>(`
        const { store } = await import("/store.js");
        return JSON.stringify(store.state.notices.some((notice) => notice.message.includes("simulated lost command reply")));
    `),
            "the lost reply",
        );
        assert.equal(
            (await state())?.count,
            before + 1,
            "the server already performed the operation",
        );
        await app.loader.reload("native-ui.ts");
        await page.navigate(`${base}/s/${id}`);
        await until(
            async () =>
                await inPage<boolean>(`
        const { store } = await import("/store.js");
        return JSON.stringify(document.querySelector(".composer textarea")?.value === "/ui-toast retry" &&
            store.state.server.extensionCommands.some((command) => command.name === "ui-toast"));
    `),
            "the pending draft after reload",
            20_000,
        );
        await page.evaluate(`document.querySelector(".composer .send").click()`);
        await until(
            async () =>
                await inPage<boolean>(`
        return JSON.stringify(document.body.textContent.includes("Native setting saved."));
    `),
            "the retried command receipt",
        );
        assert.equal(
            (await state())?.count,
            before + 1,
            "a retry must reuse the original registration and request id",
        );
        assert.equal(requests.length, modelCalls);

        await type("/ui-toast retry");
        await page.evaluate(`document.querySelector(".composer .send").click()`);
        await until(
            async () => (await state())?.count === before + 2,
            "an explicit new invocation after the receipt",
        );
    },
);

test(
    "an invalid successful HTTP response is not an acknowledgement of the command",
    real,
    async () => {
        const before = (await state())?.count ?? 0;

        await page.evaluate(`
        const original = fetch;
        let replace = true;
        globalThis.fetch = async (...args) => {
            const response = await original(...args);
            if (replace && String(args[0]).endsWith("/extension-commands")) {
                replace = false;
                await response.clone().text();
                return new Response("<html>intermediary error</html>", { status: 200 });
            }
            return response;
        };
    `);
        await type("/ui-toast invalid-reply");
        await page.evaluate(`document.querySelector(".composer .send").click()`);
        await until(
            async () =>
                await inPage<boolean>(`
        const { store } = await import("/store.js");
        return JSON.stringify(document.querySelector(".composer textarea").value === "" ||
            store.state.notices.some((notice) => notice.message.includes("command receipt")));
    `),
            "the invalid reply",
        );
        assert.equal((await state())?.count, before + 1);
        assert.equal(
            await inPage<string>(`
        return JSON.stringify(document.querySelector(".composer textarea").value);
    `),
            "/ui-toast invalid-reply",
            "an unacknowledged request stays available for retry",
        );
        await page.navigate(`${base}/s/${id}`);
        await until(
            async () =>
                await inPage<boolean>(`
        return JSON.stringify(document.querySelector(".composer textarea")?.value === "/ui-toast invalid-reply");
    `),
            "the retained request",
            20_000,
        );
        await page.evaluate(`document.querySelector(".composer .send").click()`);
        await until(
            async () =>
                await inPage<boolean>(`
        return JSON.stringify(document.body.textContent.includes("Native setting saved."));
    `),
            "the valid receipt after retry",
        );
        assert.equal((await state())?.count, before + 1);
    },
);

test("rapid duplicate submissions start one operation and one command request", real, async () => {
    const before = (await state())?.count ?? 0;

    await page.evaluate(`
        globalThis.savedFetch = fetch;
        globalThis.nativeRequests = 0;
        globalThis.activeNativeRequests = 0;
        globalThis.nativeReplies = 0;
        globalThis.fetch = async (...args) => {
            const native = String(args[0]).endsWith("/extension-commands");
            if (native) { globalThis.nativeRequests++; globalThis.activeNativeRequests++; }
            try {
                const response = await globalThis.savedFetch(...args);
                if (native) {
                    await response.clone().text();
                    globalThis.nativeReplies++;
                }
                return response;
            } finally {
                if (native) { globalThis.activeNativeRequests--; }
            }
        };
    `);

    try {
        await type("/ui-toast duplicate");
        await page.evaluate(`
            const button = document.querySelector(".composer .send");
            button.click();
            button.click();
        `);
        await until(
            async () =>
                await inPage<boolean>(`
            return JSON.stringify(globalThis.nativeReplies > 0 && globalThis.activeNativeRequests === 0);
        `),
            "the duplicate submissions settling",
        );
        assert.equal((await state())?.count, before + 1);
        assert.equal(await inPage<number>(`return JSON.stringify(globalThis.nativeRequests)`), 1);
    } finally {
        await page.evaluate(
            `globalThis.fetch = globalThis.savedFetch; delete globalThis.savedFetch;`,
        );
    }
});

test("a command reply does not erase text typed while it was pending", real, async () => {
    const before = (await state())?.count ?? 0;
    const notice = await inPage<number>(`
        const { store } = await import("/store.js");
        return JSON.stringify(Math.max(0, ...store.state.notices.map((notice) => notice.id)));
    `);

    await page.evaluate(`
        globalThis.savedFetch = fetch;
        globalThis.fetch = async (...args) => {
            const response = await globalThis.savedFetch(...args);
            if (String(args[0]).endsWith("/extension-commands")) {
                await response.clone().text();
                await new Promise((resolve) => { globalThis.releaseNativeReply = resolve; });
            }
            return response;
        };
    `);

    try {
        await type("/ui-toast slow-reply");
        await page.evaluate(`document.querySelector(".composer .send").click()`);
        await until(
            async () =>
                await inPage<boolean>(`
            return JSON.stringify(typeof globalThis.releaseNativeReply === "function");
        `),
            "the held command reply",
        );
        await type("Keep this new draft");
        await page.evaluate(`globalThis.releaseNativeReply()`);
        await until(
            async () =>
                await inPage<boolean>(`
            const { store } = await import("/store.js");
            return JSON.stringify(store.state.notices.some((entry) => entry.id > ${notice} && entry.message === "Native setting saved."));
        `),
            "the late command reply",
        );
        assert.equal((await state())?.count, before + 1);
        assert.equal(
            await inPage<string>(`
            return JSON.stringify(document.querySelector(".composer textarea").value);
        `),
            "Keep this new draft",
        );
    } finally {
        await page.evaluate(`
            globalThis.releaseNativeReply?.();
            delete globalThis.releaseNativeReply;
            globalThis.fetch = globalThis.savedFetch;
            delete globalThis.savedFetch;
        `);
    }
});

test("Running now stops a native command without sending anything to the model", real, async () => {
    const before = (await state())?.count ?? 0;
    const modelCalls = requests.length;

    try {
        await type("/ui-toast hold");
        await page.evaluate(`document.querySelector(".composer .send").click()`);
        await until(
            async () => (await state())?.count === before + 1,
            "the running native command",
        );
        await page.evaluate(
            `const { openSheet } = await import("/store.js"); openSheet({ type: "running" });`,
        );
        await until(
            async () =>
                await inPage<boolean>(`
            return JSON.stringify(Array.from(document.querySelectorAll(".running-task"))
                .some((row) => row.textContent.includes("running /ui-toast")));
        `),
            "the native command in Running now",
        );
        const canStop = await inPage<boolean>(`
            const row = Array.from(document.querySelectorAll(".running-task"))
                .find((row) => row.textContent.includes("running /ui-toast"));
            return JSON.stringify(Array.from(row.querySelectorAll("button"))
                .some((button) => button.textContent.trim() === "Stop"));
        `);

        assert.equal(canStop, true, "Running now offers Stop for the native task");
        await page.evaluate(`
            const row = Array.from(document.querySelectorAll(".running-task"))
                .find((row) => row.textContent.includes("running /ui-toast"));
            Array.from(row.querySelectorAll("button")).find((button) => button.textContent.trim() === "Stop").click();
        `);
        await until(
            async () =>
                await inPage<boolean>(`
            const { store } = await import("/store.js");
            return JSON.stringify(store.state.notices.some((notice) => notice.message.startsWith("The command was stopped;")));
        `),
            "the stopped command receipt",
        );
        assert.equal((await state())?.count, before + 1);
        assert.equal(requests.length, modelCalls);
    } finally {
        const graph = await app.harness.taskGraph(context);

        try {
            for (const task of Object.values(graph.value.tasks)) {
                if (task.kind === "pocket.command" && task.conversationId === id) {
                    await app.extensionCommands.stop(id, owner(app), Number(task.id));
                }
            }
        } finally {
            graph.dispose();
        }

        await page.evaluate(`const { closeSheet } = await import("/store.js"); closeSheet();`);
    }
});

test(
    "an unreadable saved request cannot fall through to the model after its module is disabled",
    real,
    async () => {
        const before = (await state())?.count ?? 0;
        const modelCalls = requests.length;

        await page.evaluate(`
        globalThis.savedFetch = fetch;
        globalThis.fetch = async (...args) => {
            const response = await globalThis.savedFetch(...args);
            if (String(args[0]).endsWith("/extension-commands")) {
                await response.clone().text();
                throw new Error("Intentionally lost before storage fault");
            }
            return response;
        };
    `);

        try {
            await type("/ui-toast storage-failure");
            await page.evaluate(`document.querySelector(".composer .send").click()`);
            await until(
                async () =>
                    await inPage<boolean>(`
            const { store } = await import("/store.js");
            return JSON.stringify(store.state.notices.some((notice) => notice.message === "Intentionally lost before storage fault"));
        `),
                "the lost reply before corrupting the saved request",
            );
            assert.equal((await state())?.count, before + 1);
            await page.evaluate(`
            globalThis.fetch = globalThis.savedFetch;
            const key = Object.keys(sessionStorage).find((key) => key.startsWith("pocket.extension-command."));
            if (!key) { throw new Error("No unacknowledged command request to corrupt"); }
            sessionStorage.setItem(key, "{}");
            return "corrupted";
        `);
            await app.setExtensionEnabled(owner(app), "native-ui.ts", false);
            await until(
                async () =>
                    await inPage<boolean>(`
            const { store } = await import("/store.js");
            return JSON.stringify(store.state.server.extensionCommands.length === 0);
        `),
                "the disabled command list",
            );
            await page.evaluate(`document.querySelector(".composer .send").click()`);
            await until(
                async () =>
                    requests.length > modelCalls ||
                    (await inPage<boolean>(`
            const { store } = await import("/store.js");
            return JSON.stringify(store.state.notices.some((notice) => notice.message.startsWith("The saved command request is invalid.")));
        `)),
                "the retry refusing to guess",
            );
            assert.equal(requests.length, modelCalls);
            assert.equal((await state())?.count, before + 1);
        } finally {
            await page.evaluate(`
            globalThis.fetch = globalThis.savedFetch;
            delete globalThis.savedFetch;
            for (const key of Object.keys(sessionStorage)) {
                if (key.startsWith("pocket.extension-command.")) { sessionStorage.removeItem(key); }
            }
        `);
            await app.setExtensionEnabled(owner(app), "native-ui.ts", true);
            await type("");
        }
    },
);

for (const input of ["a partial suggestion", "a long paste"] as const) {
    for (const hidden of ["disabled", "shadowed"] as const) {
        test(`a lost reply from ${input} survives a ${hidden} command`, real, async () => {
            const before = (await state())?.count ?? 0;
            const modelCalls = requests.length;
            const argument = "PRIVATE_PASTED_ARGUMENT_" + "x".repeat(2400);
            const prompt = join(work, ".pi", "prompts", "ui-toast.md");

            await page.navigate(`${base}/s/${id}`);
            await page.waitFor({ selector: ".composer textarea" });
            await page.evaluate(`
                const original = fetch;
                globalThis.canonicalOriginalFetch = original;
                globalThis.fetch = async (...args) => {
                    const response = await original(...args);
                    if (String(args[0]).endsWith("/extension-commands")) {
                        await response.clone().text();
                        throw new Error("Intentionally lost the canonical command reply");
                    }
                    return response;
                };
            `);

            try {
                if (input === "a partial suggestion") {
                    await type("/ui");
                    await pick("ui-toast");
                } else {
                    await type("/ui-toast ");
                    await page.evaluate(`
                        const box = document.querySelector(".composer textarea");
                        box.focus();
                        box.setSelectionRange(box.value.length, box.value.length);
                        const clipboard = new DataTransfer();
                        clipboard.setData("text/plain", ${JSON.stringify(argument)});
                        box.dispatchEvent(new ClipboardEvent("paste", {
                            clipboardData: clipboard, bubbles: true, cancelable: true,
                        }));
                        await new Promise(requestAnimationFrame);
                    `);
                    assert.match(
                        await inPage<string>(
                            `return JSON.stringify(document.querySelector(".composer textarea").value);`,
                        ),
                        /\[Pasted text #/,
                        "the real paste handler abbreviates the argument",
                    );
                    await page.evaluate(`document.querySelector(".composer .send").click()`);
                }

                await until(
                    async () =>
                        await inPage<boolean>(`
                        const { store } = await import("/store.js");
                        return JSON.stringify(store.state.notices.some((notice) =>
                            notice.message === "Intentionally lost the canonical command reply"));
                    `),
                    "the lost reply after the server performed the operation",
                );
                assert.equal((await state())?.count, before + 1);

                if (input === "a long paste") {
                    assert.equal(
                        (await state())?.value,
                        argument,
                        "the handler received the expanded argument",
                    );
                }

                if (hidden === "disabled") {
                    await app.setExtensionEnabled(owner(app), "native-ui.ts", false);
                } else {
                    mkdirSync(join(work, ".pi", "prompts"), { recursive: true });
                    writeFileSync(prompt, "A new template: $ARGUMENTS\n");
                }

                await page.navigate(`${base}/s/${id}`);
                await until(
                    async () =>
                        await inPage<boolean>(`
                        return JSON.stringify(document.querySelector(".composer textarea") !== null);
                    `),
                    "the retained draft after reload",
                    20_000,
                );
                await page.evaluate(`
                    const { loadTemplates } = await import("/commands.js");
                    await loadTemplates(true);
                `);
                const notice = await inPage<number>(`
                    const { store } = await import("/store.js");
                    return JSON.stringify(Math.max(0, ...store.state.notices.map((notice) => notice.id)));
                `);

                await page.evaluate(`document.querySelector(".composer .send").click()`);
                await until(
                    async () =>
                        requests.length > modelCalls ||
                        (await inPage<boolean>(`
                        const { store } = await import("/store.js");
                        return JSON.stringify(store.state.notices.some((entry) =>
                            entry.id > ${notice} && entry.message === "Native setting saved."));
                    `)),
                    "the retry receipt or an unintended model request",
                );
                assert.equal(
                    requests.length,
                    modelCalls,
                    "a native retry must never become a model request",
                );
                assert.equal(
                    (await state())?.count,
                    before + 1,
                    "retrying does not repeat the operation",
                );
                await until(
                    async () =>
                        await inPage<boolean>(`
                        return JSON.stringify(document.querySelector(".composer textarea").value === "");
                    `),
                    "the acknowledged draft being cleared",
                );
            } finally {
                if (hidden === "shadowed") {
                    rmSync(prompt, { force: true });
                }

                await page.evaluate(`
                    if (globalThis.canonicalOriginalFetch) {
                        globalThis.fetch = globalThis.canonicalOriginalFetch;
                        delete globalThis.canonicalOriginalFetch;
                    }
                `);
                await app.setExtensionEnabled(owner(app), "native-ui.ts", true);
                await type("");
            }
        });
    }
}

test("an owner can run only global commands while another person drives", real, async () => {
    const before = (await state())?.count ?? 0;
    const modelCalls = requests.length;
    const driver = app.config.addUser("Other driver", "guest").user;
    const tab = fakeTab(id, driver);

    await app.attach(tab.client);

    try {
        await app.collab.turns(id, driver, { action: "on" });
        await until(
            async () =>
                await inPage<boolean>(`
                const { store } = await import("/store.js");
                return JSON.stringify(store.state.view.turns?.driver === ${JSON.stringify(driver.id)});
            `),
            "the other driver",
        );
        assert.equal(
            await inPage<boolean>(
                `return JSON.stringify(document.querySelector(".composer textarea") !== null);`,
            ),
            true,
            "owner-global commands need an input even without the wheel",
        );
        await type("/ui");
        const offered = await suggestions();

        assert.ok(offered.some((text) => text.includes("/ui-global")));
        assert.equal(
            offered.some((text) => /\/ui-(status|set|toast)/.test(text)),
            false,
        );

        for (const text of ["Do not send this to Pi", "/ui-toast", "/model"]) {
            await type(text);
            assert.equal(
                await inPage<boolean>(
                    `return JSON.stringify(document.querySelector(".composer .send").disabled);`,
                ),
                true,
                "the global-only input does not enable conversation actions",
            );
            await page.evaluate(`document.querySelector(".composer .send").click()`);
        }

        await type("/ui-global");
        await pick("ui-global");
        await until(async () => (await state())?.count === before + 1, "the global command");
        assert.equal((await state())?.value, "global setting");
        assert.equal(requests.length, modelCalls);
        assert.equal(
            await inPage<string>(`
                const { store } = await import("/store.js");
                return JSON.stringify(store.state.view.turns.driver);
            `),
            driver.id,
            "the owner did not take the wheel to run a global operation",
        );
    } finally {
        await app.collab.turns(id, owner(app), { action: "off" });
        app.detach(tab.client);
        await until(
            async () =>
                await inPage<boolean>(`
                return JSON.stringify(document.querySelector(".composer textarea") !== null);
            `),
            "the normal composer",
        );
        await type("");
    }
});

test(
    "Find in session searches command names and card output with the recorded author",
    real,
    async () => {
        await page.navigate(`${base}/s/${id}`);
        await page.waitFor({ selector: ".composer textarea" });
        const before = (await state())?.count ?? 0;

        await type("/ui-status");
        await pick("ui-status");
        await until(async () => (await state())?.count === before + 1, "the searchable card");
        await until(
            async () =>
                await inPage<boolean>(`
            return JSON.stringify(document.querySelector(".composer textarea").value === "");
        `),
            "the completed card command",
        );
        await page.waitFor({ selector: ".command-card" });
        await page.evaluate(
            `const { openSheet } = await import("/store.js"); openSheet({ type: "find" });`,
        );

        try {
            await page.waitFor({ selector: ".find-input" });

            for (const query of ["ui-status", "Native status"]) {
                await page.evaluate(`
                const box = document.querySelector(".find-input");
                box.value = ${JSON.stringify(query)};
                box.dispatchEvent(new Event("input", { bubbles: true }));
                await new Promise(requestAnimationFrame);
            `);
                await until(
                    async () =>
                        await inPage<boolean>(`
                        return JSON.stringify(Array.from(document.querySelectorAll(".find-snippet")).some((row) =>
                            row.textContent.includes(${JSON.stringify(query)}) && row.textContent.includes("Native status")));
                    `),
                    "the matching card search result",
                );
                const results = await inPage<{ text: string; author: string }[]>(`
                return JSON.stringify(Array.from(document.querySelectorAll(".find-result"), (row) => ({
                    text: row.querySelector(".find-snippet").textContent,
                    author: row.querySelector(".find-who").textContent,
                })));
            `);

                assert.ok(
                    results.some((result) => result.text.includes(query)),
                    "the saved card is searchable",
                );
                const cards = results.filter((result) => result.text.includes("Native status"));

                assert.ok(cards.length > 0);
                assert.ok(cards.every((result) => result.author === owner(app).name));
            }

            await page.evaluate(`document.querySelector(".find-result").click()`);
            await until(
                async () =>
                    await inPage<boolean>(
                        `return JSON.stringify(document.querySelector(".find-input") === null);`,
                    ),
                "jumping from the result back to the transcript",
            );
        } finally {
            await page.evaluate(`const { closeSheet } = await import("/store.js"); closeSheet();`);
        }
    },
);
