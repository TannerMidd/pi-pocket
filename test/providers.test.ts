// Provider sign-ins must not store an empty API key, even when a client bypasses the form.
import { cleanUp, fakeTab, openApp, owner, scriptedModel, until } from "./helpers.ts";
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { HttpError } from "../src/server/errors.ts";

after(cleanUp);

test("an empty API key is refused without consuming the prompt or storing a credential", async () => {
    const app = await openApp(scriptedModel());
    const user = owner(app);
    const tab = fakeTab(undefined, user);

    app.attach(tab.client);

    try {
        const flowId = app.providers.startLogin(user, "ant-ling", "api_key");

        await until(() => tab.last("auth")?.step === "prompt", "the API key prompt");
        const promptId = tab.last("auth")!.promptId as string;

        assert.throws(
            () => app.providers.answerLogin(user, flowId, promptId, " \t "),
            (error: unknown) => error instanceof HttpError && error.status === 400,
        );
        assert.equal(app.models.getProviderAuthStatus("ant-ling").source, undefined);
        app.providers.answerLogin(user, flowId, promptId, "test-key");
        await until(() => tab.last("auth")?.step === "done", "the sign-in to finish");
        assert.equal(tab.last("auth")?.ok, true);
        assert.equal(app.models.getProviderAuthStatus("ant-ling").source, "stored");
    } finally {
        await app.close();
    }
});
