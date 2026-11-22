// Surfaces, slice 3: live patches in open tabs, components that extension modules add, and the A2UI adapter.
import {
    type App,
    cleanUp,
    context,
    fakeTab,
    lastText,
    loadTools,
    newSession,
    openApp,
    owner,
    root,
    scriptedModel,
    until,
} from "./helpers.ts";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import type { ConversationId } from "@earendil-works/pi-durable";
import { SurfacesDoc } from "../src/server/docs.ts";
import { createHandler } from "../src/server/http.ts";
import { fromA2ui, toA2uiAction } from "../src/server/surfaces/a2ui.ts";
import { checkComponentSpec } from "../src/server/surfaces/components.ts";
import { toText } from "../src/server/surfaces/text.ts";
import type { Surface } from "../src/server/surfaces/types.ts";

const dataDir = join(root, "data");
const script = new Map<string, Record<string, unknown>>();
const model = scriptedModel((request) => {
    const { role, text } = lastText(request as never);
    const call = script.get(text.replace(/^\[from: [^\]]*\] /, ""));

    if (role === "toolResult") {
        return fauxAssistantMessage([fauxText(`got: ${text}`)]);
    }

    return call === undefined
        ? fauxAssistantMessage([fauxText(`ok: ${text}`)])
        : fauxAssistantMessage([fauxToolCall("ui", call as never)], { stopReason: "toolUse" });
});
let app: App;
let server: Server;
let base = "";
let counter = 0;

before(async () => {
    mkdirSync(join(dataDir, "extensions"), { recursive: true });
    writeFileSync(
        join(dataDir, "extensions", "stars.ts"),
        `/** Stars: a rating component for surfaces. */
import { int, obj, opt, str } from "@earendil-works/pi-schema";
export default (_host, web) => {
    web.surfaceComponent({
        type: "x.stars.Rating",
        props: obj({ label: str({ maxLength: 40 }), max: opt(int({ minimum: 1, maximum: 10 })) }),
        bind: int({ minimum: 0, maximum: 10 }),
        text: (props, data) => props.label + ": " + String(data.rating ?? 0) + " of " + String(props.max ?? 5),
    });
};
`,
    );
    app = await openApp(model, dataDir);
    server = createServer(
        createHandler({ app, listen: { host: "127.0.0.1", port: 0 }, restart: () => {} }),
    );
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    await app.setExtensionEnabled(owner(app), "stars.ts", true);
});

after(async () => {
    server.closeAllConnections();
    server.close();
    await app.close();
    cleanUp();
});

const surfaces = async (id: ConversationId) =>
    (await app.harness.snapshot(SurfacesDoc, id, context))?.items ?? {};
const stored = async (id: ConversationId) =>
    JSON.stringify(await app.transcripts.allEntries(id as never, true));

/** Pi calls `ui` with `args` in a session with the tool; the result is stored when Pi has answered. */
async function ui(id: ConversationId, args: Record<string, unknown>, answer = "got: ") {
    const text = `call ${(counter += 1)}`;
    const count = async () => (await stored(id)).split(answer).length;
    const had = await count();

    script.set(text, args);
    await app.commands.submit(id, owner(app), { text, requestId: `ui-${counter}` });
    await until(async () => (await count()) > had && !app.isBusy(id), `the result of ${text}`);
}

async function fresh() {
    const id = await newSession(app);

    await loadTools(app, id, "ui");

    return id;
}

async function act(id: ConversationId, sid: string, body: unknown) {
    const response = await fetch(`${base}/api/c/${id}/surfaces/${sid}/act`, {
        method: "POST",
        headers: {
            authorization: `Bearer ${app.config.ownerToken}`,
            "x-pocket": "1",
            "content-type": "application/json",
        },
        body: JSON.stringify(body),
    });

    return { status: response.status, json: (await response.json()) as Record<string, unknown> };
}

test("a patch reaches open tabs at once, as that one surface's new revision", async () => {
    const id = await fresh();

    await ui(id, {
        action: "show",
        title: "One",
        components: [{ type: "Text", id: "t", text: "first" }],
    });
    await ui(id, {
        action: "show",
        title: "Two",
        components: [{ type: "Text", text: "other" }],
    });

    const tab = fakeTab(id, owner(app));

    await app.attach(tab.client);
    await until(() => tab.field("surfaces") !== undefined, "the first view");
    assert.deepEqual(Object.keys(tab.field("surfaces") as object).sort(), ["s1", "s2"]);

    const before = tab.events.length;

    await ui(id, {
        action: "patch",
        id: "s1",
        ops: [{ op: "props", id: "t", props: { text: "second" } }],
    });
    await until(
        () =>
            tab.events
                .slice(before)
                .some((each) => each.event === "view" && "surfaces" in each.data),
        "the patch in the tab",
    );

    const update = tab.events
        .slice(before)
        .findLast((each) => each.event === "view" && "surfaces" in each.data)!.data
        .surfaces as Record<string, { components: Record<string, { text: string }>; rev: number }>;

    assert.deepEqual(Object.keys(update), ["s1"], "only the surface that changed");
    assert.equal(update.s1!.components.t!.text, "second");
    assert.ok(update.s1!.rev > 1);
});

test("a component an extension added: checked on show, bound and checked on set, text for the rest", async () => {
    const id = await fresh();

    await ui(id, {
        action: "show",
        title: "Rate",
        data: { rating: 0 },
        components: [
            {
                type: "Column",
                children: [
                    { type: "x.stars.Rating", id: "stars", label: "Quality", bind: "/rating" },
                ],
            },
        ],
    });

    const card = (await surfaces(id)).s1!;

    assert.equal(card.components.stars!.type, "x.stars.Rating");
    assert.match(toText(card, "transcript"), /Quality: 0 of 5/);

    // The schema of the props and of the binding is the module's.
    await ui(
        id,
        {
            action: "show",
            title: "Bad",
            components: [{ type: "x.stars.Rating", label: "x", max: 99 }],
        },
        "props do not fit",
    );
    await ui(
        id,
        { action: "show", title: "Unknown", components: [{ type: "x.nobody.Thing" }] },
        "the module for this one is not on",
    );

    assert.equal((await act(id, "s1", { pv: card.pv, set: { "/rating": 3 } })).status, 200);
    assert.equal((await surfaces(id)).s1!.data.rating, 3);
    assert.equal((await act(id, "s1", { pv: card.pv, set: { "/rating": 11 } })).status, 400);
    assert.equal((await act(id, "s1", { pv: card.pv, set: { "/rating": "x" } })).status, 400);

    // A tab gets the module's text for browsers that do not draw it.
    const tab = fakeTab(id, owner(app));

    await app.attach(tab.client);
    await until(() => tab.field("surfaces") !== undefined, "the view");
    assert.equal(
        (tab.field("surfaces") as Record<string, { fallbacks: Record<string, string> }>).s1!
            .fallbacks.stars,
        "Quality: 3 of 5",
    );

    // With the module off, the stored card stays valid: Pi's patches to other parts still work, and it shows the text.
    await app.setExtensionEnabled(owner(app), "stars.ts", false);
    await ui(id, {
        action: "patch",
        id: "s1",
        ops: [{ op: "add", parent: "c1", component: { type: "Text", text: "note" } }],
    });
    assert.equal(Object.keys((await surfaces(id)).s1!.components).length, 3);
    await app.setExtensionEnabled(owner(app), "stars.ts", true);
});

test("a module's component spec is checked: its own prefix, schemas, a text function", () => {
    const text = () => "x";

    assert.throws(
        () => checkComponentSpec("stars", { type: "Rating", props: {}, text } as never),
        /x\.stars\./,
    );
    assert.throws(
        () => checkComponentSpec("stars", { type: "x.other.Rating", props: {}, text } as never),
        /x\.stars\./,
    );
    assert.throws(
        () => checkComponentSpec("stars", { type: "x.stars.Rating", props: {} } as never),
        /text/,
    );
    assert.ok(
        checkComponentSpec("stars", {
            type: "x.stars.Rating",
            props: { type: "object" },
            text,
        } as never),
    );
});

test("A2UI messages become a card, change it, and close it; what the adapter cannot map is refused", async () => {
    const messages = [
        {
            version: "v1.0",
            createSurface: {
                surfaceId: "form",
                catalogId: "https://a2ui.org/specification/v1_0/basic_catalog.json",
            },
        },
        {
            updateComponents: {
                surfaceId: "form",
                components: [
                    { id: "root", component: "Column", children: ["name", "go"] },
                    { id: "name", component: "TextField", label: "Name", value: { path: "/name" } },
                    { id: "go-label", component: "Text", text: "Send" },
                    {
                        id: "go",
                        component: "Button",
                        child: "go-label",
                        variant: "primary",
                        action: { event: { name: "send", context: { who: { path: "/name" } } } },
                    },
                ],
            },
        },
        { updateDataModel: { surfaceId: "form", path: "/name", value: "Ada" } },
    ];
    const read = fromA2ui(messages);

    assert.deepEqual(read.refused, []);
    assert.equal(read.plan!.components["go-label"], undefined, "a button's label Text is consumed");
    assert.equal(read.plan!.components.go!.label, "Send");
    assert.deepEqual(read.plan!.components.name!.bind, "/name");

    const refused = fromA2ui([
        {
            createSurface: {
                surfaceId: "x",
                catalogId: "https://example.com/other.json",
                sendDataModel: true,
            },
        },
        {
            updateComponents: {
                surfaceId: "x",
                components: [
                    { id: "root", component: "Column", children: ["v", "m", "b"] },
                    { id: "v", component: "Video", url: "https://example.com/v.mp4" },
                    { id: "m", component: "Modal" },
                    {
                        id: "b",
                        component: "Button",
                        label: "Hi",
                        action: { functionCall: { call: "callAgentFunction" } },
                    },
                ],
            },
        },
    ]);

    assert.equal(refused.plan, undefined);
    assert.equal(
        refused.refused.filter((reason) =>
            /catalog|sendDataModel|Video|Modal|functionCall|openUrl/.test(reason),
        ).length,
        5,
    );

    // Through the tool: a card, an update, and the action as A2UI's message.
    const id = await fresh();

    await ui(id, { action: "a2ui", title: "Form", messages });
    const card = Object.values(await surfaces(id))[0]!;

    assert.equal(card.a2ui, "form");
    assert.equal(card.data.name, "Ada");
    assert.equal(card.components.go!.type, "Button");
    await ui(id, {
        action: "a2ui",
        messages: [{ updateDataModel: { surfaceId: "form", path: "/name", value: "Grace" } }],
    });
    assert.equal((await surfaces(id))[card.id]!.data.name, "Grace");
    assert.ok((await surfaces(id))[card.id]!.pv > card.pv, "Pi changed it: pv rose");
    await ui(
        id,
        {
            action: "a2ui",
            messages: [
                { createSurface: { surfaceId: "v" } },
                {
                    updateComponents: {
                        surfaceId: "v",
                        components: [{ id: "root", component: "Video" }],
                    },
                },
            ],
        },
        "A2UI refused",
    );
    await ui(
        id,
        { action: "a2ui", messages: [{ deleteSurface: { surfaceId: "form" } }] },
        "closed",
    );
    assert.equal((await surfaces(id))[card.id]!.status, "closed");

    assert.deepEqual(
        toA2uiAction("form", { name: "send", by: "Ada", at: 0, values: { who: "Ada" } }),
        {
            action: {
                name: "send",
                surfaceId: "form",
                context: { who: "Ada" },
                timestamp: "1970-01-01T00:00:00.000Z",
            },
        },
    );
    assert.ok(card as Surface);
});
