// Pi Pocket's folders: where each part of its state lives, per the XDG base directory spec, and how an older
// `~/.pi-pocket` moves into them.
import assert from "node:assert/strict";
import {
    existsSync,
    mkdirSync,
    mkdtempSync,
    readFileSync,
    readdirSync,
    rmSync,
    statSync,
    writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { ensureFolders, foldersFromEnv, migrateLegacy } from "../src/server/dirs.ts";

const root = mkdtempSync(join(tmpdir(), "pp-dirs-"));

after(() => rmSync(root, { recursive: true, force: true }));

/** A home folder of its own, empty, for one test. */
function home(name: string): string {
    const folder = join(root, name);

    mkdirSync(folder, { recursive: true });

    return folder;
}

test("the folders come from XDG_*_HOME, and from the home folder's defaults when it is unset", () => {
    const xdg = foldersFromEnv(
        {
            XDG_CONFIG_HOME: "/xdg/config",
            XDG_DATA_HOME: "/xdg/data",
            XDG_STATE_HOME: "/xdg/state",
            XDG_CACHE_HOME: "/xdg/cache",
        },
        "/home/me",
    );

    assert.deepEqual(xdg, {
        config: "/xdg/config/pi-pocket",
        data: "/xdg/data/pi-pocket",
        state: "/xdg/state/pi-pocket",
        cache: "/xdg/cache/pi-pocket",
    });

    assert.deepEqual(foldersFromEnv({}, "/home/me"), {
        config: "/home/me/.config/pi-pocket",
        data: "/home/me/.local/share/pi-pocket",
        state: "/home/me/.local/state/pi-pocket",
        cache: "/home/me/.cache/pi-pocket",
    });
});

test("a relative XDG_*_HOME is ignored, as the spec says", () => {
    const dirs = foldersFromEnv(
        {
            XDG_CONFIG_HOME: "config",
            XDG_DATA_HOME: "data",
            XDG_STATE_HOME: "state",
            XDG_CACHE_HOME: "cache",
        },
        "/home/me",
    );

    assert.deepEqual(dirs, {
        config: "/home/me/.config/pi-pocket",
        data: "/home/me/.local/share/pi-pocket",
        state: "/home/me/.local/state/pi-pocket",
        cache: "/home/me/.cache/pi-pocket",
    });
});

test("each PI_POCKET_*_DIR wins over the XDG folders", () => {
    const dirs = foldersFromEnv(
        {
            XDG_CONFIG_HOME: "/xdg/config",
            XDG_DATA_HOME: "/xdg/data",
            XDG_STATE_HOME: "/xdg/state",
            XDG_CACHE_HOME: "/xdg/cache",
            PI_POCKET_CONFIG_DIR: "/elsewhere/config",
            PI_POCKET_STATE_DIR: "/elsewhere/state",
        },
        "/home/me",
    );

    assert.equal(dirs.config, "/elsewhere/config");
    assert.equal(dirs.data, "/xdg/data/pi-pocket");
    assert.equal(dirs.state, "/elsewhere/state");
    assert.equal(dirs.cache, "/xdg/cache/pi-pocket");
});

test("an empty PI_POCKET_*_DIR falls back to the XDG folder", () => {
    const dirs = foldersFromEnv({ PI_POCKET_CONFIG_DIR: "", PI_POCKET_DATA_DIR: "" }, "/home/me");

    assert.equal(dirs.config, "/home/me/.config/pi-pocket");
    assert.equal(dirs.data, "/home/me/.local/share/pi-pocket");
});

test("ensureFolders makes the four, private", () => {
    const dirs = foldersFromEnv(
        {
            PI_POCKET_CONFIG_DIR: join(root, "made", "config"),
            PI_POCKET_DATA_DIR: join(root, "made", "data"),
            PI_POCKET_STATE_DIR: join(root, "made", "state"),
            PI_POCKET_CACHE_DIR: join(root, "made", "cache"),
        },
        home("ensure"),
    );

    ensureFolders(dirs);

    for (const folder of Object.values(dirs)) {
        assert.ok(existsSync(folder), folder);

        if (process.platform !== "win32") {
            assert.equal(statSync(folder).mode & 0o777, 0o700, folder);
        }
    }
});

test("an old ~/.pi-pocket moves into the four folders, and what is not Pi Pocket's stays behind", () => {
    const folder = home("migrate");
    const legacy = join(folder, ".pi-pocket");
    const dirs = {
        config: join(folder, "config"),
        data: join(folder, "data"),
        state: join(folder, "state"),
        cache: join(folder, "cache"),
    };

    mkdirSync(join(legacy, "extensions"), { recursive: true });
    mkdirSync(join(legacy, "bin"), { recursive: true });
    writeFileSync(join(legacy, "config.json"), "{}");
    writeFileSync(join(legacy, "launcher.json"), "{}");
    writeFileSync(join(legacy, "pocket.sqlite"), "sqlite");
    writeFileSync(join(legacy, "pocket.sqlite-wal"), "wal");
    writeFileSync(join(legacy, "pocket.sqlite-shm"), "shm");
    writeFileSync(join(legacy, "push.json"), "{}");
    writeFileSync(join(legacy, "extensions", "mine.ts"), "/** Mine. */\n");
    writeFileSync(join(legacy, "harness.lock"), "1\n");
    mkdirSync(join(legacy, "repos", "owner", "project"), { recursive: true });
    writeFileSync(join(legacy, "repos", "owner", "project", "README.md"), "clone");
    writeFileSync(join(legacy, "cloudflared.log"), "log\n");
    writeFileSync(join(legacy, "bin", "cloudflared"), "binary");
    mkdirSync(join(legacy, "browser", "profile"), { recursive: true });
    writeFileSync(join(legacy, "browser", "profile", "Cookies"), "cookie");
    // Not a name Pi Pocket knows: it may be someone else's, so it is left where it is.
    writeFileSync(join(legacy, "notes.txt"), "hello");

    const said: string[] = [];

    migrateLegacy(dirs, (line) => said.push(line), folder);

    for (const moved of [
        join(dirs.config, "config.json"),
        join(dirs.config, "launcher.json"),
        join(dirs.data, "pocket.sqlite"),
        join(dirs.data, "pocket.sqlite-wal"),
        join(dirs.data, "pocket.sqlite-shm"),
        join(dirs.data, "repos", "owner", "project", "README.md"),
        join(dirs.data, "push.json"),
        join(dirs.data, "extensions", "mine.ts"),
        join(dirs.data, "harness.lock"),
        join(dirs.state, "cloudflared.log"),
        join(dirs.cache, "bin", "cloudflared"),
        join(dirs.cache, "browser", "profile", "Cookies"),
    ]) {
        assert.ok(existsSync(moved), moved);
    }

    assert.deepEqual(readdirSync(legacy), ["notes.txt"]);
    assert.ok(
        said.some((line) => line.includes("Moved Pi Pocket's data")),
        said.join("\n"),
    );
    assert.ok(
        said.some((line) => line === "Left in ~/.pi-pocket: notes.txt"),
        said.join("\n"),
    );
    assert.ok(
        said.some((line) => line.includes("Files those conversations name")),
        said.join("\n"),
    );
});

test("migrating again does nothing, and never overwrites what is already in a folder", () => {
    const folder = home("again");
    const legacy = join(folder, ".pi-pocket");
    const dirs = {
        config: join(folder, "config"),
        data: join(folder, "data"),
        state: join(folder, "state"),
        cache: join(folder, "cache"),
    };

    mkdirSync(legacy, { recursive: true });
    mkdirSync(dirs.config, { recursive: true });
    writeFileSync(join(legacy, "config.json"), "the old one");
    // The destination came first: the old one stays where it is, and the new one is not replaced.
    writeFileSync(join(dirs.config, "config.json"), "the one in use");
    writeFileSync(join(legacy, "push.json"), "{}");

    migrateLegacy(dirs, () => {}, folder);

    assert.equal(existsSync(join(dirs.data, "push.json")), true);
    assert.equal(existsSync(join(legacy, "config.json")), true);
    assert.equal(readdirSync(join(dirs.config)).length, 1);

    // Everything is gone now, so a second run finds nothing to do and says nothing.
    rmSync(join(legacy, "config.json"));
    rmSync(legacy, { recursive: true, force: true });

    const said: string[] = [];

    migrateLegacy(dirs, (line) => said.push(line), folder);

    assert.deepEqual(said, []);
    assert.deepEqual(readdirSync(dirs.data), ["push.json"]);
});

test("a folder named with PI_POCKET_*_DIR keeps what is already in the old one", () => {
    const folder = home("named");
    const legacy = join(folder, ".pi-pocket");
    const dirs = {
        config: join(folder, "config"),
        data: legacy,
        state: join(folder, "state"),
        cache: join(folder, "cache"),
    };

    mkdirSync(legacy, { recursive: true });
    writeFileSync(join(legacy, "pocket.sqlite"), "sqlite");

    migrateLegacy(dirs, () => {}, folder);

    assert.equal(existsSync(join(legacy, "pocket.sqlite")), true);
});

test("a database already in the data folder is not replaced, and the old one is named", () => {
    const folder = home("two-databases");
    const legacy = join(folder, ".pi-pocket");
    const dirs = {
        config: join(folder, "config"),
        data: join(folder, "data"),
        state: join(folder, "state"),
        cache: join(folder, "cache"),
    };

    mkdirSync(legacy, { recursive: true });
    mkdirSync(dirs.data, { recursive: true });
    writeFileSync(join(legacy, "pocket.sqlite"), "the old one");
    writeFileSync(join(dirs.data, "pocket.sqlite"), "the one in use");

    const said: string[] = [];

    migrateLegacy(dirs, (line) => said.push(line), folder);

    assert.equal(readFileSync(join(dirs.data, "pocket.sqlite"), "utf8"), "the one in use");
    assert.ok(
        said.some((line) => line.includes("Kept ~/.pi-pocket/pocket.sqlite")),
        said.join("\n"),
    );
});

test(
    "a Pi Pocket still running on the old folder is not migrated under it",
    { skip: process.platform === "win32" },
    async () => {
        const { spawn } = await import("node:child_process");
        const { once } = await import("node:events");
        const folder = home("running");
        const legacy = join(folder, ".pi-pocket");
        const dirs = {
            config: join(folder, "config"),
            data: join(folder, "data"),
            state: join(folder, "state"),
            cache: join(folder, "cache"),
        };
        const running = spawn(process.execPath, ["-e", "setTimeout(() => {}, 30000)"]);

        try {
            mkdirSync(legacy, { recursive: true });
            writeFileSync(join(legacy, "pocket.sqlite"), "sqlite");
            writeFileSync(join(legacy, "harness.lock"), `${running.pid}\n`);

            const said: string[] = [];

            migrateLegacy(dirs, (line) => said.push(line), folder);

            assert.equal(existsSync(join(legacy, "pocket.sqlite")), true);
            assert.equal(existsSync(join(dirs.data, "pocket.sqlite")), false);
            assert.ok(
                said.some((line) => line.includes("is still running on ~/.pi-pocket")),
                said.join("\n"),
            );
        } finally {
            running.kill();
            await once(running, "exit");
        }
    },
);
