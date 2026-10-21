import {
    type App,
    cleanUp,
    fakeTab,
    home,
    owner,
    root,
    say,
    scriptedModel,
    until,
    work,
} from "./helpers.ts";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, test } from "node:test";
import type { FauxResponseStep, OAuthCredential } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxProvider, fauxText } from "@earendil-works/pi-ai/providers/faux";
import { agentInfo, modelList } from "../src/server/models.ts";

const { PocketApp } = await import("../src/server/app.ts");

const route: FauxResponseStep = () => {
    return fauxAssistantMessage([fauxText("ok")]);
};

const faux = scriptedModel(route);

/** Why the provider refuses to renew the sign-in now; undefined: it renews it. */
let refusal: Error | undefined;
const renewed: string[] = [];
const core = fauxProvider({ provider: "expiring", models: [{ id: "exp-1" }] });

core.setResponses(Array.from({ length: 50 }, () => fauxAssistantMessage([fauxText("exp")])));
const expiring = {
    ...core.provider,
    name: "Expiring",
    auth: {
        oauth: {
            name: "Expiring",
            login: async () => {
                throw new Error("no sign-in in tests");
            },
            refresh: async (credential: OAuthCredential) => {
                renewed.push(credential.refresh);

                if (refusal !== undefined) {
                    throw refusal;
                }

                return { ...credential, access: "fresh", expires: Date.now() + 3_600_000 };
            },
            toAuth: async (credential: OAuthCredential) => ({ apiKey: credential.access }),
        },
    },
};

let app: App;

/** Store a sign-in of Expiring that has run out, as Pi keeps it in its `auth.json`. */
function expiredSignIn(): void {
    const agent = join(root, "agent");

    mkdirSync(agent, { recursive: true });
    writeFileSync(
        join(agent, "auth.json"),
        JSON.stringify({
            expiring: { type: "oauth", access: "old", refresh: "stale", expires: 0 },
        }),
    );
}

before(async () => {
    expiredSignIn();
    app = await PocketApp.open({
        dataDir: join(root, "signins-data"),
        defaultCwd: work,
        supervised: false,
        log: () => {},
        home,
        configureModels: (models) => {
            models.registerNativeProvider(faux.provider);
            models.registerNativeProvider(expiring as never);
        },
    });
});

after(async () => {
    await app?.close();
    cleanUp();
});

const listed = () => app.providers.list(true).find((provider) => provider.id === "expiring");
const marked = () => modelList(app.models, app.signInNeeded).find((model) => model.id === "exp-1");

test("a sign-in that cannot be renewed needs sign-in: the sheet, the models, and the owner say so", async () => {
    // A network that fails on the way changes nothing.
    refusal = new Error("token refresh error: fetch failed");
    await app.providers.checkAll();
    assert.equal(listed()?.needsSignIn, undefined);
    assert.equal(marked()?.signIn, undefined);
    assert.ok(renewed.length > 0, "the renewal was tried");

    const tab = fakeTab(undefined, owner(app));
    const guest = fakeTab(undefined, app.config.addUser("Guest", "guest").user);

    await app.attach(tab.client);
    await app.attach(guest.client);
    refusal = new Error('token refresh failed (400): {"error":"invalid_grant"}');
    await app.providers.checkAll();
    app.detach(tab.client);
    app.detach(guest.client);
    // Only the owner signs in again: only they are told.
    assert.equal(
        guest.events.some((event) => event.event === "notice"),
        false,
        "a guest is not told",
    );

    assert.match(String(listed()?.needsSignIn), /invalid_grant/);
    // Only the owner sees what the provider said.
    assert.doesNotMatch(
        String(app.providers.list().find((provider) => provider.id === "expiring")?.needsSignIn),
        /invalid_grant/,
    );
    assert.equal(marked()?.signIn, true);
    assert.ok(
        tab.events.some(
            (event) =>
                event.event === "models" &&
                (event.data as unknown as { id: string; signIn?: true }[]).some(
                    (model) => model.id === "exp-1" && model.signIn === true,
                ),
        ),
        "tabs get the models, marked",
    );
});

test("a run that fails on it marks it, and a sign-in that works again clears the mark", async () => {
    refusal = undefined;
    await app.providers.checkAll();
    assert.equal(listed()?.needsSignIn, undefined, "renewed: no mark");
    assert.equal(marked()?.signIn, undefined);

    // It runs out again, and a session on it fails.
    expiredSignIn();
    refusal = new Error('token refresh failed (400): {"error":"invalid_grant"}');
    const { id } = await app.commands.createSession(owner(app), { cwd: work });

    await app.commands.configure(id, owner(app), {
        model: { provider: "expiring", modelId: "exp-1" },
        thinkingLevel: "off",
    });
    await say(app, id, "hello");
    await until(() => listed()?.needsSignIn !== undefined, "the mark from the failed run");
    assert.match(String(listed()?.needsSignIn), /invalid_grant/);
    // The session shows its model as not available.
    assert.equal(
        agentInfo(app.models, (await app.agentState(id))!, work, app.signInNeeded).available,
        false,
    );

    // Signed in again outside the app (Pi's terminal app, say): the next answer from it clears the mark.
    refusal = undefined;
    await say(app, id, "hello again");
    await until(() => listed()?.needsSignIn === undefined, "the mark cleared by an answer");
});
