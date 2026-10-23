// Extension UI locale metadata: validation and reload behavior in isolated temporary extension/data folders.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRegistry } from "@earendil-works/pi-durable";
import { test } from "node:test";
import type { PocketHost } from "../src/server/host.ts";
import { ExtensionLoader, prepareDropInFolder } from "../src/server/reload.ts";

interface Fixture {
    root: string;
    dropIn: string;
    loader: ExtensionLoader;
    registry: ReturnType<typeof createRegistry>;
    choices: Map<string, boolean>;
    changes: number;
    add(file: string, source: string): void;
    enable(file: string): Promise<void>;
}

async function isolated(run: (fixture: Fixture) => Promise<void>): Promise<void> {
    const root = mkdtempSync(join(tmpdir(), "pocket-ui-locales-"));
    const builtIn = join(root, "built-in");
    const dropIn = join(root, "data", "extensions");
    const choices = new Map<string, boolean>();
    let changes = 0;

    mkdirSync(builtIn, { recursive: true });
    prepareDropInFolder(dropIn, join(import.meta.dirname, "..", "node_modules"));

    const registry = createRegistry();
    const loader = new ExtensionLoader(
        registry,
        { notice: () => {} } as unknown as PocketHost,
        { builtIn, dropIn },
        (file) => choices.get(file),
        async () => {
            changes += 1;
        },
    );
    const fixture: Fixture = {
        root,
        dropIn,
        loader,
        registry,
        choices,
        get changes() {
            return changes;
        },
        add: (file, source) => writeFileSync(join(dropIn, file), source),
        enable: async (file) => {
            choices.set(file, true);
            await loader.apply(file);
        },
    };

    try {
        await run(fixture);
    } finally {
        loader.close();
        rmSync(root, { recursive: true, force: true });
    }
}

function moduleSource(name: string, locales: string): string {
    return `import { defineExtension } from "@earendil-works/pi-durable";
export default () => ({ ...defineExtension({ name: ${JSON.stringify(name)} }), uiLocales: ${locales} });`;
}

function pack(locale: string, strings = `{ Hello: "${locale}" }`, preferred = false): string {
    return `{ locale: ${JSON.stringify(locale)}, label: ${JSON.stringify(locale)}, ${preferred ? "default: true," : ""} strings: ${strings} }`;
}

async function waitFor(check: () => boolean, what: string): Promise<void> {
    const deadline = Date.now() + 5000;

    while (!check()) {
        if (Date.now() > deadline) {
            throw new Error(`Timed out waiting for ${what}`);
        }

        await new Promise((resolve) => setTimeout(resolve, 10));
    }
}

test("locale packs are copied, frozen, and returned as an isolated deterministic snapshot", async () => {
    await isolated(async ({ loader, choices, add }) => {
        const key = `__pocket_locale_${crypto.randomUUID().replaceAll("-", "")}`;
        const name = "copied-locale";

        add(
            "copy.ts",
            `import { defineExtension } from "@earendil-works/pi-durable";
const packs = [{ locale: "zh-CN", label: "简体中文", default: true, strings: { Hello: "你好" }, templates: { "{{count}}": "{{count}} 项" } }];
globalThis[${JSON.stringify(key)}] = packs;
export default () => ({ ...defineExtension({ name: ${JSON.stringify(name)} }), uiLocales: packs });`,
        );
        choices.set("copy.ts", true);
        await loader.apply("copy.ts");
        const installed = (await loader.reload("copy.ts"))[0]!;

        assert.equal(Object.getOwnPropertyDescriptor(installed, "uiLocales")?.writable, false);

        const original = (globalThis as unknown as Record<string, unknown>)[key] as {
            strings: Record<string, string>;
        }[];
        const exposed = loader.uiLocales();
        const registered = exposed[0]!;

        try {
            original[0]!.strings.Hello = "被改写";
            original.push({ strings: {} });

            assert.equal(loader.uiLocales()[0]?.strings.Hello, "你好");
            assert.equal(Object.isFrozen(registered), true);
            assert.equal(Object.isFrozen(registered.strings), true);
            assert.equal(Object.isFrozen(registered.templates), true);
            assert.equal(Object.isFrozen(loader.uiLocales()[0]?.templates), true);
            assert.throws(() => {
                (registered.strings as Record<string, string>).Hello = "改写";
            }, TypeError);

            exposed.pop();
            assert.equal(
                loader.uiLocales().length,
                1,
                "a caller cannot mutate the loader's collection",
            );
        } finally {
            delete (globalThis as unknown as Record<string, unknown>)[key];
        }
    });
});

test("a later registry validation error cannot leave earlier extensions from a reload installed", async () => {
    await isolated(async ({ loader, registry, choices, add }) => {
        add("existing.ts", moduleSource("existing", `[${pack("en", '{ Existing: "old" }')}]`));
        choices.set("existing.ts", true);
        await loader.apply("existing.ts");

        // Simulate a task collision detected by the real registry after an extension passed loader checks.
        const task = { definition: { name: "locale-regression-collision" } } as never;
        const colliding = {
            name: "already-installed",
            tasks: [task],
        } as never;

        registry.install(colliding);

        add(
            "partial.ts",
            `import { defineExtension } from "@earendil-works/pi-durable";
const task = { definition: { name: "locale-regression-collision" } };
export default () => [
    { ...defineExtension({ name: "first-in-partial" }), uiLocales: [${pack("fr", '{ First: "premier" }')}] },
    { ...defineExtension({ name: "second-in-partial" }), tasks: [task], uiLocales: [${pack("de", '{ Second: "zweite" }')}] },
];`,
        );
        choices.set("partial.ts", true);

        await assert.rejects(loader.apply("partial.ts"), /locale-regression-collision/);
        assert.equal(registry.snapshot().extension("first-in-partial"), undefined);
        assert.equal(registry.snapshot().extension("second-in-partial"), undefined);
        assert.deepEqual(
            loader.uiLocales().map((locale) => locale.locale),
            ["en"],
            "the failed module contributes no locale packs",
        );
    });
});

test("locale schema rejects noncanonical tags, accessors, sparse arrays, and excessive aggregate packs", async () => {
    await isolated(async ({ loader, choices, add }) => {
        add("noncanonical.ts", moduleSource("noncanonical", `[${pack("en-us")}]`));
        choices.set("noncanonical.ts", true);
        await assert.rejects(loader.apply("noncanonical.ts"), /canonical BCP 47/);
        add("empty-locale.ts", moduleSource("empty-locale", `[${pack("")}]`));
        choices.set("empty-locale.ts", true);
        await assert.rejects(loader.apply("empty-locale.ts"), /canonical BCP 47/);

        add(
            "accessor.ts",
            `import { defineExtension } from "@earendil-works/pi-durable";
const entry = { locale: "en", label: "English", strings: { Hello: "Hello" } };
Object.defineProperty(entry, "label", { enumerable: true, get() { globalThis.__localeGetterRan = true; return "English"; } });
export default () => ({ ...defineExtension({ name: "accessor" }), uiLocales: [entry] });`,
        );
        choices.set("accessor.ts", true);
        await assert.rejects(loader.apply("accessor.ts"), /enumerable data properties/);
        assert.equal(
            (globalThis as unknown as Record<string, unknown>).__localeGetterRan,
            undefined,
        );
        delete (globalThis as unknown as Record<string, unknown>).__localeGetterRan;

        add("sparse.ts", moduleSource("sparse", "Array(1)"));
        choices.set("sparse.ts", true);
        await assert.rejects(loader.apply("sparse.ts"), /dense array/);

        add(
            "bad-template.ts",
            moduleSource(
                "bad-template",
                '[{ locale: "en", label: "English", strings: {}, templates: { "Hello {{name}}": "Hello" } }]',
            ),
        );
        choices.set("bad-template.ts", true);
        await assert.rejects(loader.apply("bad-template.ts"), /template placeholders must match/);

        const tags = [
            "en",
            "fr",
            "de",
            "es",
            "it",
            "pt",
            "nl",
            "sv",
            "da",
            "no",
            "fi",
            "is",
            "pl",
            "cs",
            "sk",
            "hu",
        ];

        add("many.ts", moduleSource("many", `[${tags.map((locale) => pack(locale)).join(",")}]`));
        choices.set("many.ts", true);
        await loader.apply("many.ts");
        add("overflow.ts", moduleSource("overflow", `[${pack("ro")}]`));
        choices.set("overflow.ts", true);
        await assert.rejects(loader.apply("overflow.ts"), /maximum 16/);
        assert.equal(loader.uiLocales().length, 16);
    });
});

test("locale conflicts are explicit and multiple defaults use the smallest canonical tag", async () => {
    await isolated(async ({ loader, choices, add }) => {
        add("z-locale.ts", moduleSource("z-locale", `[${pack("zh-CN", undefined, true)}]`));
        add("a-locale.ts", moduleSource("a-locale", `[${pack("fr-FR", undefined, true)}]`));
        add("m-locale.ts", moduleSource("m-locale", `[${pack("de-DE")}]`));
        choices.set("z-locale.ts", true);
        await loader.apply("z-locale.ts");
        choices.set("a-locale.ts", true);
        await loader.apply("a-locale.ts");
        choices.set("m-locale.ts", true);
        await loader.apply("m-locale.ts");

        assert.deepEqual(
            loader
                .uiLocales()
                .map(({ locale, default: preferred }) => [locale, preferred === true]),
            [
                ["fr-FR", true],
                ["zh-CN", true],
                ["de-DE", false],
            ],
        );

        add("conflict.ts", moduleSource("conflict", `[${pack("zh-CN")}]`));
        choices.set("conflict.ts", true);
        await assert.rejects(
            loader.apply("conflict.ts"),
            /z-locale\.ts already registers the zh-CN UI locale/,
        );
        assert.equal(loader.uiLocales().length, 3);

        add(
            "duplicate.ts",
            `import { defineExtension } from "@earendil-works/pi-durable";
const locale = { locale: "en", label: "English", strings: {} };
export default () => [
    { ...defineExtension({ name: "duplicate-one" }), uiLocales: [locale] },
    { ...defineExtension({ name: "duplicate-two" }), uiLocales: [locale] },
];`,
        );
        choices.set("duplicate.ts", true);
        await assert.rejects(
            loader.apply("duplicate.ts"),
            /duplicate\.ts registers the en UI locale more than once/,
        );
        assert.equal(loader.uiLocales().length, 3);
    });
});

test("a malformed reload preserves the last good locale dictionary", async () => {
    await isolated(async ({ loader, choices, add }) => {
        const file = "translation.ts";

        add(file, moduleSource("translation", `[${pack("ja-JP", '{ Hello: "こんにちは" }')}]`));
        choices.set(file, true);
        await loader.apply(file);
        assert.equal(loader.uiLocales()[0]?.strings.Hello, "こんにちは");

        add(file, moduleSource("translation", `[${pack("ja-JP", "{ Hello: 7 }")}]`));
        await assert.rejects(loader.reload(file), /values must be plain strings/);
        assert.equal(loader.uiLocales()[0]?.strings.Hello, "こんにちは");

        add(file, moduleSource("translation", `[${pack("ja-JP", '{ Hello: "おはよう" }')}]`));
        await loader.reload(file);
        assert.equal(loader.uiLocales()[0]?.strings.Hello, "おはよう");
    });
});

test("a newer reload wins over an older asynchronous import", async () => {
    await isolated(async ({ loader, choices, add, root }) => {
        const file = "newer-wins.ts";
        const started = join(root, "old.started");
        const release = join(root, "old.release");

        add(
            file,
            `import { existsSync, writeFileSync } from "node:fs";
import { defineExtension } from "@earendil-works/pi-durable";
writeFileSync(${JSON.stringify(started)}, "started");
while (!existsSync(${JSON.stringify(release)})) await new Promise((resolve) => setTimeout(resolve, 5));
export default () => ({ ...defineExtension({ name: "newer-wins" }), uiLocales: [{ locale: "fr-FR", label: "Français", strings: { Hello: "Bonjour" } }] });`,
        );
        choices.set(file, true);
        const olderLoad = loader.apply(file);

        await waitFor(() => existsSync(started), "the older import to begin");
        add(file, moduleSource("newer-wins", `[${pack("es-ES", '{ Hello: "Hola" }')}]`));
        await loader.reload(file);
        assert.equal(loader.uiLocales()[0]?.strings.Hello, "Hola");

        writeFileSync(release, "release");
        await olderLoad;
        assert.equal(loader.uiLocales()[0]?.strings.Hello, "Hola");
    });
});

test("a load finishing after disable or deletion cannot resurrect its locale", async () => {
    await isolated(async (fixture) => {
        const { loader, choices, add, root, dropIn } = fixture;
        const disableFile = "disable-race.ts";
        const disableStarted = join(root, "disable.started");
        const disableRelease = join(root, "disable.release");

        add(
            disableFile,
            `import { existsSync, writeFileSync } from "node:fs";
import { defineExtension } from "@earendil-works/pi-durable";
writeFileSync(${JSON.stringify(disableStarted)}, "started");
while (!existsSync(${JSON.stringify(disableRelease)})) await new Promise((resolve) => setTimeout(resolve, 5));
export default () => ({ ...defineExtension({ name: "disable-race" }), uiLocales: [{ locale: "sv-SE", label: "Svenska", strings: { Hello: "Hej" } }] });`,
        );
        choices.set(disableFile, true);
        const enabling = loader.apply(disableFile);

        await waitFor(() => existsSync(disableStarted), "the in-flight extension import");
        choices.set(disableFile, false);
        await loader.apply(disableFile);
        writeFileSync(disableRelease, "release");
        await enabling;
        assert.equal(loader.extensionNames().includes("disable-race"), false);
        assert.equal(loader.uiLocales().length, 0);

        const deleteFile = "delete-race.ts";
        const deleteStarted = join(root, "delete.started");
        const deleteRelease = join(root, "delete.release");
        const source = `import { existsSync, writeFileSync } from "node:fs";
import { defineExtension } from "@earendil-works/pi-durable";
writeFileSync(${JSON.stringify(deleteStarted)}, "started");
while (!existsSync(${JSON.stringify(deleteRelease)})) await new Promise((resolve) => setTimeout(resolve, 5));
export default () => ({ ...defineExtension({ name: "delete-race" }), uiLocales: [{ locale: "da-DK", label: "Dansk", strings: { Hello: "Hej" } }] });`;

        add(deleteFile, moduleSource("delete-race", `[${pack("da-DK", '{ Hello: "Hej" }')}]`));
        choices.set(deleteFile, true);
        await loader.apply(deleteFile);
        add(deleteFile, source);
        loader.watch();
        const reloading = loader.reload(deleteFile);

        await waitFor(() => existsSync(deleteStarted), "the in-flight reload before deletion");
        rmSync(join(dropIn, deleteFile));
        await waitFor(
            () => !loader.extensionNames().includes("delete-race"),
            "the deleted extension to uninstall",
        );
        writeFileSync(deleteRelease, "release");
        await reloading;
        await waitFor(() => loader.uiLocales().length === 0, "deleted locale data to disappear");
        assert.equal(loader.extensionNames().includes("delete-race"), false);
        await waitFor(() => fixture.changes > 0, "client refresh after deletion");
    });
});
