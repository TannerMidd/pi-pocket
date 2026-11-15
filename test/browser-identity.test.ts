// The browser's client hints name the real browser and this machine (src/server/browser/identity.ts).
import assert from "node:assert/strict";
import { test } from "node:test";
import { brandName, clientHints } from "../src/server/browser/identity.ts";

test("client hints name the real browser, its full version, and the platform", () => {
    assert.equal(brandName("Chrome/155.0.8059.84", "/usr/bin/chromium"), "Chromium");
    assert.equal(
        brandName("Chrome/155.0.8059.84", "/usr/bin/google-chrome-stable"),
        "Google Chrome",
    );
    assert.equal(brandName("Chrome/155.0.8059.84", "/opt/brave.com/brave/brave"), "Brave");
    assert.equal(
        brandName("HeadlessEdg/155.0.8059.84", "/usr/bin/microsoft-edge"),
        "Microsoft Edge",
    );

    const hints = clientHints("Brave", "155.0.8059.84", false, {
        platform: "linux",
        arch: "x64",
        release: "6.8.0-45-generic",
    });

    assert.deepEqual(
        hints.fullVersionList.map((entry) => `${entry.brand} ${entry.version}`),
        ["Not.A/Brand 8.0.0.0", "Chromium 155.0.8059.84", "Brave 155.0.8059.84"],
    );
    assert.deepEqual(
        [hints.platform, hints.platformVersion, hints.mobile],
        ["Linux", "6.8.0", false],
    );
});
