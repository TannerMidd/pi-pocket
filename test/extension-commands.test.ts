import {
    cleanUp,
    fakeTab,
    newSession,
    openApp,
    owner,
    root,
    scriptedModel,
    until,
    type App,
} from "./helpers.ts";
import assert from "node:assert/strict";
import {
    existsSync,
    mkdirSync,
    mkdtempSync,
    readFileSync,
    renameSync,
    rmSync,
    writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { createRegistry } from "@earendil-works/pi-durable";
import ts from "typescript";
import type { PocketHost } from "../src/server/host.ts";
import { ExtensionLoader } from "../src/server/reload.ts";

let app: App;

before(async () => {
    app = await openApp(scriptedModel());
});

after(async () => {
    await app?.close();
    cleanUp();
});

test("an enabled drop-in exposes its native commands without exposing handlers", async () => {
    writeFileSync(
        join(app.dataDir, "extensions", "command-status.ts"),
        `/** Reports the extension's status. */
export default (host) => {
    host.commands?.register({
        name: "command-status",
        description: "Show the extension status",
        scope: "conversation",
        handler: () => ({ type: "toast", level: "info", message: "Ready" }),
    });
    return [];
};
`,
    );
    await app.setExtensionEnabled(owner(app), "command-status.ts", true);
    const commands = (await app.hello(owner(app))).server.extensionCommands ?? [];

    assert.deepEqual(
        commands.map(({ name, description, scope }) => ({ name, description, scope })),
        [
            {
                name: "command-status",
                description: "Show the extension status",
                scope: "conversation",
            },
        ],
    );
    assert.equal("handler" in commands[0]!, false);
});

const source = (commands: Record<string, unknown>[], tail = "") => `/** Offers native commands. */
export default (host) => {
    for (const command of ${JSON.stringify(commands)}) {
        host.commands?.register({
            description: "An extension command",
            scope: "conversation",
            handler: () => ({ type: "toast", level: "info", message: "Ready" }),
            ...command,
        });
    }
    ${tail}
    return [];
};
`;

async function enable(file: string, content: string): Promise<void> {
    writeFileSync(join(app.dataDir, "extensions", file), content);
    await app.setExtensionEnabled(owner(app), file, true);
}

test("viewers discover no commands and guests do not discover global configuration commands", async () => {
    await enable(
        "command-access.ts",
        source([{ name: "guest-status" }, { name: "owner-setting", scope: "global" }]),
    );
    const guest = app.config.addUser("Guest", "guest").user;
    const viewer = app.config.addUser("Viewer", "viewer").user;
    const visible = async (user: typeof guest) =>
        (await app.hello(user)).server.extensionCommands
            .filter((command) => command.file === "command-access.ts")
            .map((command) => command.name);

    assert.deepEqual(await visible(owner(app)), ["guest-status", "owner-setting"]);
    assert.deepEqual(await visible(guest), ["guest-status"]);
    assert.deepEqual(await visible(viewer), []);
});

test("disabling a module removes its commands from discovery", async () => {
    await enable("command-disable.ts", source([{ name: "disable-status" }]));
    await app.setExtensionEnabled(owner(app), "command-disable.ts", false);

    assert.equal(
        app.loader.commands().some((command) => command.name === "disable-status"),
        false,
    );
});

test("a failed rebuild keeps the old commands and a successful rebuild replaces them together", async () => {
    const file = "command-replace.ts";
    const path = join(app.dataDir, "extensions", file);

    await enable(file, source([{ name: "previous-status" }]));
    const previous = app.loader.commands().filter((command) => command.file === file);

    writeFileSync(
        path,
        source([{ name: "discarded-status" }], 'throw new Error("broken rebuild");'),
    );
    await assert.rejects(app.loader.reload(file), /broken rebuild/);
    assert.deepEqual(
        app.loader.commands().filter((command) => command.file === file),
        previous,
    );

    writeFileSync(path, source([{ name: "replacement-status" }]));
    await app.loader.reload(file);
    const next = app.loader.commands().filter((command) => command.file === file);

    assert.deepEqual(
        next.map((command) => command.name),
        ["replacement-status"],
    );
    assert.notEqual(next[0]!.id, previous[0]!.id);
});

test("successful direct reloads refresh command discovery for already connected tabs", async () => {
    const file = "command-events.ts";

    await enable(file, source([{ name: "before-refresh" }]));
    const tab = fakeTab(undefined, owner(app));

    await app.attach(tab.client);

    try {
        writeFileSync(join(app.dataDir, "extensions", file), source([{ name: "after-refresh" }]));
        await app.loader.reload(file);
        const server = tab.last("hello")?.server as
            Awaited<ReturnType<App["hello"]>>["server"] | undefined;

        assert.equal(
            server?.extensionCommands.some((command) => command.name === "after-refresh"),
            true,
        );
        assert.equal(
            server?.extensionCommands.some((command) => command.name === "before-refresh"),
            false,
        );
    } finally {
        app.detach(tab.client);
    }
});

test("a module cannot add commands after its factory has returned", async () => {
    const file = "command-late.ts";

    await enable(
        file,
        source(
            [{ name: "declared-status" }],
            `queueMicrotask(() => {
                try {
                    host.commands.register({
                        name: "late-status",
                        description: "Too late",
                        scope: "conversation",
                        handler: () => ({ type: "toast", level: "info", message: "Late" }),
                    });
                } catch {}
            });`,
        ),
    );

    assert.deepEqual(
        app.loader
            .commands()
            .filter((command) => command.file === file)
            .map((command) => command.name),
        ["declared-status"],
    );
});

test("a command cannot replace a built-in or another module's command", async () => {
    await enable("command-first.ts", source([{ name: "reserved-status" }]));

    for (const name of ["compact", "model", "settings", "reserved-status"]) {
        await assert.rejects(
            enable(`command-conflict-${name}.ts`, source([{ name }])),
            /built-in|already.*command/i,
        );
    }
});

test("every built-in composer command is protected when a module tries to register its name", async () => {
    const file = ts.createSourceFile(
        "commands.js",
        readFileSync(new URL("../web/commands.js", import.meta.url), "utf8"),
        ts.ScriptTarget.Latest,
        true,
        ts.ScriptKind.JS,
    );
    const declaration = file.statements
        .filter(ts.isVariableStatement)
        .flatMap((statement) => [...statement.declarationList.declarations])
        .find((declaration) => declaration.name.getText(file) === "COMMANDS");
    const commands = declaration?.initializer;

    assert.ok(
        commands && ts.isArrayLiteralExpression(commands),
        "the composer command catalog exists",
    );

    for (const command of commands.elements) {
        assert.ok(ts.isObjectLiteralExpression(command));
        const name = command.properties.find((property) => property.name?.getText(file) === "name");

        assert.ok(name && ts.isPropertyAssignment(name) && ts.isStringLiteral(name.initializer));
        await assert.rejects(
            enable(
                `command-builtin-${name.initializer.text}.ts`,
                source([{ name: name.initializer.text }]),
            ),
            /built-in command/,
        );
    }
});

test("duplicate or malformed declarations reject the whole module", async () => {
    const invalid = [
        [{ name: "same-name" }, { name: "same-name" }],
        [{ name: "not/a-command" }],
        [{ name: "UPPERCASE" }],
        [{ name: "unknown-scope", scope: "anything" }],
        [{ name: "missing-description", description: "" }],
        [{ name: "invalid-hint", args: 42 }],
        [{ name: "not-callable", handler: null }],
    ];

    for (const [index, declarations] of invalid.entries()) {
        const file = `command-invalid-${index}.ts`;

        await assert.rejects(
            enable(file, source(declarations)),
            /command|description|scope|args|handler/i,
        );
        assert.deepEqual(
            app.loader.commands().filter((command) => command.file === file),
            [],
        );
    }
});

function gate(file: string, command: string, fail = false) {
    const ready = join(app.dataDir, `${file}.ready`);
    const release = join(app.dataDir, `${file}.release`);
    const content = `/** A module with a delayed import. */
import { existsSync, writeFileSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
writeFileSync(${JSON.stringify(ready)}, "ready");
while (!existsSync(${JSON.stringify(release)})) { await delay(5); }
${fail ? 'throw new Error("old import failed");' : ""}
${source([{ name: command }])}`;

    return { ready, release, content };
}

test("turning a module off while it imports prevents its pending commands from being installed", async () => {
    const file = "command-disable-race.ts";
    const delayed = gate(file, "disabled-while-loading");
    const loading = enable(file, delayed.content);

    try {
        await until(() => existsSync(delayed.ready), "the module import");
        await app.setExtensionEnabled(owner(app), file, false);
    } finally {
        writeFileSync(delayed.release, "release");
        await loading;
    }

    assert.equal(app.loader.enabled(file), false);
    assert.deepEqual(
        app.loader.commands().filter((command) => command.file === file),
        [],
    );
});

test("an older import finishing last cannot replace a newer successful command rebuild", async () => {
    const file = "command-version-race.ts";
    const delayed = gate(file, "stale-rebuild");

    await enable(file, source([{ name: "original-rebuild" }]));
    writeFileSync(join(app.dataDir, "extensions", file), delayed.content);
    const older = app.loader.reload(file);

    try {
        await until(() => existsSync(delayed.ready), "the older import");
        writeFileSync(join(app.dataDir, "extensions", file), source([{ name: "latest-rebuild" }]));
        await app.loader.reload(file);
    } finally {
        writeFileSync(delayed.release, "release");
        await older;
    }

    assert.deepEqual(
        app.loader
            .commands()
            .filter((command) => command.file === file)
            .map((command) => command.name),
        ["latest-rebuild"],
    );
});

test("an older failed import does not label a newer successful rebuild as broken", async () => {
    const file = "command-error-race.ts";
    const delayed = gate(file, "discarded-error-rebuild", true);

    await enable(file, source([{ name: "original-error-rebuild" }]));
    writeFileSync(join(app.dataDir, "extensions", file), delayed.content);
    const older = app.loader.reload(file).catch((error: unknown) => error);

    try {
        await until(() => existsSync(delayed.ready), "the older failing import");
        writeFileSync(join(app.dataDir, "extensions", file), source([{ name: "healthy-rebuild" }]));
        await app.loader.reload(file);
    } finally {
        writeFileSync(delayed.release, "release");
        await older;
    }

    assert.equal(
        (await app.extensions(owner(app))).modules.find((module) => module.file === file)?.error,
        undefined,
    );
});

/** Use the actual host with isolated module folders, never the running app's source directory. */
async function isolatedLoader() {
    const globals = globalThis as typeof globalThis & Record<string, unknown>;
    const key = "commandHost_" + crypto.randomUUID();
    let host: Omit<PocketHost, "commands"> | undefined;

    globals[key] = (value: PocketHost) => {
        host = value;
    };

    try {
        await enable(
            `${key}.ts`,
            `export default (host) => {
            globalThis[${JSON.stringify(key)}](host);
            return [];
        };`,
        );
    } finally {
        delete globals[key];
    }

    assert.ok(host);
    const directory = mkdtempSync(join(root, "command-modules-"));
    const folders = { builtIn: join(directory, "built-in"), dropIn: join(directory, "drop-in") };

    mkdirSync(folders.builtIn);
    mkdirSync(folders.dropIn);

    return { folders, loader: new ExtensionLoader(createRegistry(), host, folders, () => true) };
}

test("deleting a built-in removes its registrations even when an ignored same-name drop-in exists", async () => {
    const { folders, loader } = await isolatedLoader();
    const file = "watched.ts";
    const previous = app.loader;

    writeFileSync(join(folders.builtIn, file), source([{ name: "watched-status" }]));
    writeFileSync(join(folders.dropIn, file), source([{ name: "ignored-status" }]));
    await loader.reload(file);
    loader.watch();
    app.loader = loader;

    try {
        const id = await newSession(app);
        const command = loader.commands()[0]!;
        const request = { commandId: command.id, args: "", requestId: crypto.randomUUID() };
        const receipt = await app.extensionCommands.run(id, owner(app), request);

        assert.equal(receipt.status, "done");
        rmSync(join(folders.builtIn, file));
        await until(
            () => loader.commands().length === 0,
            "the built-in registrations being removed",
        );
        assert.equal(loader.command(command.id), undefined);
        await assert.rejects(
            app.extensionCommands.run(id, owner(app), {
                ...request,
                requestId: crypto.randomUUID(),
            }),
            { status: 404 },
        );
        assert.deepEqual(await app.extensionCommands.run(id, owner(app), request), receipt);
    } finally {
        app.loader = previous;
        loader.close();
    }
});

test("renaming a built-in releases the old name before the renamed module registers it", async () => {
    const { folders, loader } = await isolatedLoader();

    writeFileSync(join(folders.builtIn, "old.ts"), source([{ name: "renamed-status" }]));
    await loader.reload("old.ts");
    const old = loader.commands()[0]!;

    loader.watch();

    try {
        renameSync(join(folders.builtIn, "old.ts"), join(folders.builtIn, "renamed.ts"));
        await until(
            () => loader.commands().length === 1 && loader.commands()[0]?.file === "renamed.ts",
            "the renamed built-in",
        );
        assert.equal(loader.command(old.id), undefined);
        assert.equal(loader.commands()[0]?.name, "renamed-status");
    } finally {
        loader.close();
    }
});

test("a removed built-in cannot finish importing against an enabled same-name drop-in", async () => {
    const { folders, loader } = await isolatedLoader();
    const file = "pending-built-in.ts";
    const delayed = gate(file, "obsolete-built-in");

    writeFileSync(join(folders.builtIn, file), delayed.content);
    writeFileSync(join(folders.dropIn, file), source([{ name: "fallback-drop-in" }]));
    loader.watch();
    const loading = loader.reload(file);

    try {
        await until(() => existsSync(delayed.ready), "the pending built-in import");
        rmSync(join(folders.builtIn, file));
        writeFileSync(delayed.release, "release");
        await loading;
        assert.deepEqual(
            loader.commands(),
            [],
            "removed source must not register through a different module's enabled flag",
        );
    } finally {
        writeFileSync(delayed.release, "release");

        try {
            await loading;
        } finally {
            loader.close();
        }
    }
});
