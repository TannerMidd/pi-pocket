// The real Chinese pack belongs to a separate repository. Copy it only into isolated test apps.
import assert from "node:assert/strict";
import { copyFileSync, mkdirSync } from "node:fs";
import { isAbsolute, join, relative, sep } from "node:path";
import { pathToFileURL } from "node:url";
import type { UiLocalePack } from "../src/server/ui-locales.ts";
import { type App, owner, root } from "./helpers.ts";

export const chinesePackPath = process.env.PI_POCKET_TEST_ZH_CN_PACK;
export const chineseModule = "zh-cn-semantic.ts";
export const chinesePackOptions = {
    skip: chinesePackPath === undefined ? "PI_POCKET_TEST_ZH_CN_PACK is not set" : false,
} as const;

if (chinesePackPath !== undefined && !isAbsolute(chinesePackPath)) {
    throw new Error("PI_POCKET_TEST_ZH_CN_PACK must be an absolute file path");
}

/** Import the named data export from the same entry that the app will load. */
export async function externalChinesePack(): Promise<UiLocalePack> {
    assert.ok(chinesePackPath, "PI_POCKET_TEST_ZH_CN_PACK is required");
    const module = await import(pathToFileURL(chinesePackPath).href);

    assert.equal(typeof module.default, "function", "the external entry exports its registrar");
    assert.ok(module.pack, "the external Chinese entry exports named pack data");

    return module.pack as UiLocalePack;
}

/** Install and enable the actual self-contained entry, never a generated substitute. */
export async function enableExternalChinese(app: App): Promise<void> {
    assert.ok(chinesePackPath, "PI_POCKET_TEST_ZH_CN_PACK is required");
    const location = relative(root, app.dataDir);

    assert.ok(
        location !== "" &&
            location !== ".." &&
            !location.startsWith(`..${sep}`) &&
            !isAbsolute(location),
        "the Chinese pack can only be copied to an isolated test app",
    );
    const extensions = join(app.dataDir, "extensions");
    const existing = (await app.extensions(owner(app))).modules.find(
        (each) => each.file === chineseModule,
    );

    if (!existing) {
        mkdirSync(extensions, { recursive: true });
        copyFileSync(chinesePackPath, join(extensions, chineseModule));
    }

    const before = (await app.extensions(owner(app))).modules.find(
        (each) => each.file === chineseModule,
    );

    assert.ok(before, "the actual Chinese entry is discovered");
    assert.equal(before.source, "drop-in");
    assert.equal(before.enabled, false, "the drop-in starts or remains off");
    assert.equal(
        app.webs.locales.snapshot().locales.some((each) => each.id === "zh-CN"),
        false,
        "the off drop-in does not publish Chinese",
    );
    await app.setExtensionEnabled(owner(app), chineseModule, true);
    const after = (await app.extensions(owner(app))).modules.find(
        (each) => each.file === chineseModule,
    );

    assert.ok(after);
    assert.equal(after.source, "drop-in");
    assert.equal(after.enabled, true);
    assert.equal(after.error, undefined);
    assert.deepEqual(after.web?.locales, ["zh-CN"]);
    const published = app.webs.locales.snapshot().locales.find((each) => each.id === "zh-CN");
    const pack = await externalChinesePack();

    assert.ok(published);
    assert.equal(published.label, pack.label);

    for (const [key, value] of Object.entries(published.messages)) {
        assert.equal(value, pack.messages[key], `published ${key} comes from the external pack`);
    }

    assert.equal(published.messages["ui.close"], pack.messages["ui.close"]);
}
