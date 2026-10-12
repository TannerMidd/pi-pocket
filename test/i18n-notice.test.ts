// Optional locale metadata changes presentation only: English notices, reach and raw errors remain intact.
import { cleanUp, fakeTab, newSession, openApp, owner, scriptedModel } from "./helpers.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import { setUiLocales, t } from "../web/i18n.js";

test("server notice locale metadata is additive, scoped, and preserves parameters", async () => {
    const app = await openApp(scriptedModel());
    const id = await newSession(app);
    const otherId = await newSession(app);
    const tab = fakeTab(id, owner(app));
    const other = fakeTab(otherId, owner(app));
    const params = { name: "Menu {{name}} <img> /file", error: "EXTERNAL RAW {{name}}" };
    const key = "Could not attach {{name}}: {{error}}";
    const message = `Could not attach ${params.name}: ${params.error}`;

    try {
        await app.attach(tab.client);
        await app.attach(other.client);
        app.notice("warning", message, id, { key, params });
        assert.deepEqual(tab.last("notice"), { level: "warning", message, ui: { key, params } });
        assert.equal(other.last("notice"), undefined);
        setUiLocales([
            { locale: "zh-CN", strings: {}, templates: { [key]: "无法附加 {{name}}：{{error}}" } },
        ]);
        assert.equal(t(key, params), `无法附加 ${params.name}：${params.error}`);
        setUiLocales([]);
        assert.equal(t(key, params), message);
        app.notice("error", "EXTERNAL RAW {{name}}", id);
        assert.deepEqual(tab.last("notice"), { level: "error", message: "EXTERNAL RAW {{name}}" });
    } finally {
        setUiLocales([]);
        app.detach(tab.client);
        app.detach(other.client);
        await app.close();
        cleanUp();
    }
});
