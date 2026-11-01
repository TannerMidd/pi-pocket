// Updates of Pi Pocket itself (`src/server/updates.ts`), on a checkout of a repository made here: what stands in the
// way, an update that moves the checkout and restarts, its packages put in place beside it, the start after it, and
// the launcher going back when the new version does not start (`update-state.ts`).
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
    existsSync,
    mkdirSync,
    mkdtempSync,
    readFileSync,
    readlinkSync,
    rmSync,
    symlinkSync,
    writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import {
    keptNote,
    readOutcome,
    readPending,
    rollBackUpdate,
    stopMeansRollBack,
    undoPartialSwitch,
    updatePaths,
    writePending,
} from "../src/server/update-state.ts";
import {
    changedFiles,
    newer,
    newestOfReleases,
    newestTag,
    nodeMeets,
    notesWarn,
    failureLines,
    pickNpmVersion,
    type Release,
    repositoryProblem,
    Updates,
    type UpdatesOptions,
    type UpdateStatus,
} from "../src/server/updates.ts";
import { atLeast, compareReleases, versionParts } from "../src/server/versions.ts";
import { installsByItself } from "../src/server/extensions/updates.ts";

const root = mkdtempSync(join(tmpdir(), "pi-pocket-updates-"));

after(() => rmSync(root, { recursive: true, force: true }));

let made = 0;

const run = (cwd: string, args: string[]) =>
    execFileSync("git", args, {
        cwd,
        encoding: "utf8",
        env: {
            ...process.env,
            GIT_AUTHOR_NAME: "Test",
            GIT_AUTHOR_EMAIL: "test@example.com",
            GIT_COMMITTER_NAME: "Test",
            GIT_COMMITTER_EMAIL: "test@example.com",
            GIT_CONFIG_NOSYSTEM: "1",
            HOME: root,
        },
    }).trim();

/** A lock file with no packages: `npm ci` installs nothing, without the network. */
const lock = (version: string, extra: Record<string, unknown> = {}) =>
    `${JSON.stringify(
        {
            name: "pi-pocket",
            version,
            lockfileVersion: 3,
            requires: true,
            packages: { "": { name: "pi-pocket", version, ...extra } },
        },
        null,
        2,
    )}\n`;

/** Write Pi Pocket's version (and maybe its lock file) in `cwd`, commit, and tag it. */
function release(cwd: string, version: string, lockExtra?: Record<string, unknown>, tag = true) {
    writeFileSync(
        join(cwd, "package.json"),
        `${JSON.stringify({ name: "pi-pocket", version, engines: { node: ">=22.19" } }, null, 2)}\n`,
    );
    writeFileSync(join(cwd, "package-lock.json"), lock(version, lockExtra));
    writeFileSync(join(cwd, "code.txt"), `code of ${version}\n`);
    run(cwd, ["add", "-A"]);
    run(cwd, ["commit", "--quiet", "-m", version]);

    if (tag) {
        run(cwd, ["tag", `v${version}`]);
    }

    return run(cwd, ["rev-parse", "HEAD"]);
}

/** An upstream at 1.0.0, and a checkout of it, as a person clones Pi Pocket. */
function setUp() {
    const where = join(root, `case-${++made}`);
    const upstream = join(where, "upstream");
    const app = join(where, "app");

    mkdirSync(upstream, { recursive: true });
    run(upstream, ["init", "--quiet", "--initial-branch=main"]);
    writeFileSync(join(upstream, ".gitignore"), "node_modules/\n/.pocket-update/\n");
    const first = release(upstream, "1.0.0");

    run(where, ["clone", "--quiet", upstream, app]);
    mkdirSync(join(app, "node_modules"));
    writeFileSync(join(app, "node_modules", "old.txt"), "the packages of 1.0.0\n");

    return { upstream, app, first };
}

const notes = (text = "Fixes.") => ({ notes: text, url: "https://example.com/release" });

function updater(
    app: string,
    upstream: string,
    latest: () => Release | undefined,
    overrides: Partial<UpdatesOptions> = {},
) {
    const restarts: number[] = [];
    const updates = new Updates({
        appRoot: app,
        version: JSON.parse(readFileSync(join(app, "package.json"), "utf8")).version,
        supervised: true,
        rollback: true,
        restart: () => restarts.push(Date.now()),
        busy: () => 0,
        log: () => {},
        repository: upstream,
        releases: async () => latest(),
        ...overrides,
    });

    return { updates, restarts };
}

function tagged(app: string, upstream: string, overrides: Partial<UpdatesOptions> = {}) {
    const restarts: number[] = [];
    const updates = new Updates({
        appRoot: app,
        version: JSON.parse(readFileSync(join(app, "package.json"), "utf8")).version,
        supervised: true,
        rollback: true,
        restart: () => restarts.push(Date.now()),
        busy: () => 0,
        log: () => {},
        repository: upstream,
        ...overrides,
    });

    return { updates, restarts };
}

const releaseOf = (version: string, extra: Partial<Release> = {}): Release => ({
    tag: `v${version}`,
    version,
    name: `Pi Pocket ${version}`,
    warning: notesWarn(extra.notes),
    ...notes(),
    ...extra,
});

const waitFor = async (check: () => boolean, what: string) => {
    for (let tries = 0; tries < 100 && !check(); tries++) {
        await new Promise((resolve) => setTimeout(resolve, 20));
    }

    assert.ok(check(), what);
};

test("apply never replaces recovery state from an unfinished update", async () => {
    const { upstream, app, first } = setUp();
    const unfinished = release(upstream, "1.1.0");

    release(upstream, "1.2.0");
    writePending(app, {
        v: 1,
        tag: "v1.1.0",
        fromVersion: "1.0.0",
        toVersion: "1.1.0",
        from: first,
        to: unfinished,
        branch: "main",
        modules: false,
        phase: "switching",
        oneWay: false,
        at: 123,
    });
    const pending = readPending(app);
    const { updates, restarts } = updater(app, upstream, () => releaseOf("1.2.0"));
    const status = await updates.check();

    assert.match(status.blockers.join("\n"), /An update is under way/);
    await assert.rejects(updates.apply(), /An update is under way/);
    assert.deepEqual(readPending(app), pending);
    assert.equal(run(app, ["rev-parse", "HEAD"]), first);
    assert.deepEqual(restarts, []);
});

test("versions, Node.js ranges, and release notes' warnings are read as the release notes guide writes them", () => {
    assert.equal(newer("0.23.0", "0.22.0"), true);
    assert.equal(newer("0.22.0", "0.22.0"), false);
    assert.equal(newer("0.21.9", "0.22.0"), false);
    assert.equal(newer("1.0.0", "0.99.99"), true);
    assert.equal(newer("garbage", "0.22.0"), false);
    assert.equal(nodeMeets(">=22.19", "22.19.0"), true);
    assert.equal(nodeMeets(">=22.19", "22.18.4"), false);
    assert.equal(nodeMeets(">=24", "26.1.0"), true);
    assert.equal(nodeMeets("^22 || ^24", "20.0.0"), true, "a range it cannot read is not checked");
    assert.equal(notesWarn("> [!WARNING]\n> 0.21.0 upgrades the database one way."), true);
    assert.equal(notesWarn("> [!IMPORTANT]\n> Run `npm install`."), false);
    assert.equal(notesWarn(undefined), false);
});

test("an update moves a clean checkout to the release, restarts, and the start after it finishes it", async () => {
    const { upstream, app, first } = setUp();
    const next = release(upstream, "1.1.0");
    const { updates, restarts } = updater(app, upstream, () => releaseOf("1.1.0"));

    const status = await updates.check();

    assert.equal(status.available, true);
    assert.deepEqual(status.blockers, []);
    assert.equal(status.packages, false, "a new version in the lock file installs nothing");
    assert.equal(status.branch, "main");

    const answer = await updates.apply({ by: "test" });

    assert.deepEqual(answer, { restarting: true, version: "1.1.0" });
    assert.equal(run(app, ["rev-parse", "HEAD"]), next);
    assert.equal(run(app, ["symbolic-ref", "--short", "HEAD"]), "main", "the branch moves forward");
    assert.equal(readFileSync(join(app, "code.txt"), "utf8"), "code of 1.1.0\n");
    assert.equal(readPending(app)?.from, first);
    assert.equal(readPending(app)?.to, next);
    assert.equal(readFileSync(join(app, "node_modules", "old.txt"), "utf8").length > 0, true);
    await waitFor(() => restarts.length === 1, "it restarts");

    // The new version's start: it notes that the update is done.
    const started = updater(app, upstream, () => releaseOf("1.1.0")).updates;
    const outcome = await started.recover();

    assert.equal(outcome?.ok, true);
    assert.match(outcome?.message ?? "", /from 1\.0\.0 to 1\.1\.0/);
    assert.equal(readPending(app), undefined);
    assert.equal((await started.status()).available, false);
    assert.equal((await started.status()).last?.ok, true);
});

test("changes not committed, commits the release lacks, and no launcher each stop an update", async () => {
    const { upstream, app } = setUp();

    release(upstream, "1.1.0");

    // Changes of the owner's own, as Pi Pocket editing itself makes.
    writeFileSync(join(app, "code.txt"), "my own change\n");
    const dirty = updater(app, upstream, () => releaseOf("1.1.0")).updates;
    const status = await dirty.check();

    assert.equal(status.available, true);
    assert.match(
        status.blockers.join("\n"),
        /1 file has changes that are not committed \(code\.txt\)/,
    );
    await assert.rejects(dirty.apply(), /not committed/);
    assert.equal(readFileSync(join(app, "code.txt"), "utf8"), "my own change\n", "nothing changed");

    // Committed, they are commits the release does not have.
    run(app, ["commit", "--quiet", "-am", "mine"]);
    const ahead = await updater(app, upstream, () => releaseOf("1.1.0")).updates.check();

    assert.match(ahead.blockers.join("\n"), /commits that v1\.1\.0 does not have \(on main\)/);

    // No launcher: nothing can restart it.
    const plain = setUp();

    release(plain.upstream, "1.1.0");
    const alone = await updater(plain.app, plain.upstream, () => releaseOf("1.1.0"), {
        supervised: false,
    }).updates.check();

    assert.match(alone.blockers.join("\n"), /without its launcher/);
});

test("a tag whose version is not the release's, and a checkout ahead of the release, are not updated", async () => {
    const { upstream, app } = setUp();

    release(upstream, "1.1.0", undefined, false);
    run(upstream, ["tag", "v1.2.0"]);
    const wrong = await updater(app, upstream, () => releaseOf("1.2.0")).updates.check();

    assert.match(wrong.blockers.join("\n"), /v1\.2\.0 holds version 1\.1\.0/);

    // A checkout that has the release already (pulled by hand, the server not restarted yet) has nothing to update.
    const later = setUp();

    release(later.upstream, "1.1.0");
    release(later.upstream, "1.2.0-dev", undefined, false);
    run(later.app, ["pull", "--quiet"]);
    const ahead = await updater(later.app, later.upstream, () => releaseOf("1.1.0"), {
        version: "1.0.0",
    }).updates.check();

    assert.equal(ahead.available, false);
    assert.deepEqual(ahead.blockers, []);
});

test("a release whose notes warn needs the owner's word, and the launcher does not undo it", async () => {
    const { upstream, app } = setUp();
    const next = release(upstream, "1.1.0");
    const warned = releaseOf("1.1.0", {
        notes: "> [!WARNING]\n> This upgrades the database one way.",
    });
    const { updates } = updater(app, upstream, () => warned);
    const status = await updates.check();

    assert.equal(status.latest?.warning, true);
    assert.match(status.cautions.join("\n"), /warning/);
    await assert.rejects(updates.apply(), /confirm/);
    assert.notEqual(run(app, ["rev-parse", "HEAD"]), next);

    await updates.apply({ confirmWarning: true });
    assert.equal(run(app, ["rev-parse", "HEAD"]), next);
    assert.equal(readPending(app)?.oneWay, true);

    // The new version does not start: the launcher leaves a one-way update in place, and says so.
    const said = rollBackUpdate(app);

    assert.match(said ?? "", /did not go back/);
    assert.equal(run(app, ["rev-parse", "HEAD"]), next);
    assert.equal(readPending(app), undefined);
    assert.equal(readOutcome(app)?.ok, false);
});

test("a release whose notes GitHub did not give is treated as one that warns", async () => {
    const { upstream, app } = setUp();
    const next = release(upstream, "1.1.0");
    const unread: Release = { ...releaseOf("1.1.0"), notes: undefined, unread: true };
    const { updates } = updater(app, upstream, () => unread);
    const status = await updates.check();

    assert.match(status.cautions.join("\n"), /could not read this version's release notes/);
    await assert.rejects(updates.apply(), /read them on GitHub/);
    assert.notEqual(run(app, ["rev-parse", "HEAD"]), next);

    await updates.apply({ confirmWarning: true });
    assert.equal(readPending(app)?.oneWay, true);
    assert.match(rollBackUpdate(app) ?? "", /did not go back/);
    assert.equal(run(app, ["rev-parse", "HEAD"]), next);
});

test("new packages install beside the checkout, and the launcher puts the old ones back with the old version", async () => {
    const { upstream, app, first } = setUp();
    const next = release(upstream, "1.1.0", { license: "MIT" });
    const { updates } = updater(app, upstream, () => releaseOf("1.1.0"));
    const status = await updates.check();

    assert.equal(status.packages, true);
    assert.match(status.cautions.join("\n"), /npm ci/);

    await updates.apply();
    assert.equal(run(app, ["rev-parse", "HEAD"]), next);
    assert.equal(
        existsSync(join(app, "node_modules", "old.txt")),
        false,
        "the new packages are in place",
    );
    assert.equal(existsSync(join(updatePaths(app).previous, "node_modules", "old.txt")), true);
    assert.equal(existsSync(updatePaths(app).staging), false);

    // 1.1.0 does not start: the launcher goes back to 1.0.0, its packages too.
    const said = rollBackUpdate(app);

    assert.match(said ?? "", /1\.1\.0 did not start, so Pi Pocket went back to 1\.0\.0/);
    assert.equal(run(app, ["rev-parse", "HEAD"]), first);
    assert.equal(run(app, ["symbolic-ref", "--short", "HEAD"]), "main");
    assert.equal(
        readFileSync(join(app, "node_modules", "old.txt"), "utf8"),
        "the packages of 1.0.0\n",
    );
    assert.equal(readPending(app), undefined);
    assert.equal(readOutcome(app)?.ok, false);
    assert.equal(rollBackUpdate(app), undefined, "with no update under way, it does nothing");

    // The old version's start after it: nothing to finish, and the outcome stays for the owner to read.
    const back = updater(app, upstream, () => releaseOf("1.1.0")).updates;

    assert.equal(await back.recover(), undefined);
    assert.match((await back.status()).last?.message ?? "", /went back/);
});

test("a detached checkout of a tag updates to the next tag, and goes back detached", async () => {
    const { upstream, app, first } = setUp();

    run(app, ["checkout", "--quiet", "--detach", "v1.0.0"]);
    const next = release(upstream, "1.1.0");
    const { updates } = updater(app, upstream, () => releaseOf("1.1.0"));

    assert.equal((await updates.check()).branch, null);
    await updates.apply();
    assert.equal(run(app, ["rev-parse", "HEAD"]), next);
    rollBackUpdate(app);
    assert.equal(run(app, ["rev-parse", "HEAD"]), first);
});

test("busy sessions wait unless the owner accepts them, and one update runs at a time", async () => {
    const { upstream, app } = setUp();

    release(upstream, "1.1.0");
    const { updates } = updater(app, upstream, () => releaseOf("1.1.0"), { busy: () => 2 });
    const status = await updates.check();

    assert.match(status.cautions.join("\n"), /Pi works in 2 sessions/);
    await assert.rejects(updates.apply(), /Pi works in a session/);

    const [one, two] = await Promise.allSettled([
        updates.apply({ allowBusy: true }),
        updates.apply({ allowBusy: true }),
    ]);

    assert.equal(one.status, "fulfilled");
    assert.equal(two.status, "rejected");
    assert.match(String((two as PromiseRejectedResult).reason), /under way/);
});

test("a server stopped between the packages and the checkout gets its packages back at its next start", async () => {
    const { upstream, app, first } = setUp();

    release(upstream, "1.1.0", { license: "MIT" });
    const { updates } = updater(app, upstream, () => releaseOf("1.1.0"));

    await updates.apply();
    // As though the server stopped before git moved: the checkout is back at 1.0.0, the packages are 1.1.0's.
    run(app, ["reset", "--quiet", "--keep", first]);

    const started = updater(app, upstream, () => releaseOf("1.1.0")).updates;
    const outcome = await started.recover();

    assert.equal(outcome?.ok, false);
    assert.match(outcome?.message ?? "", /did not finish/);
    assert.equal(
        readFileSync(join(app, "node_modules", "old.txt"), "utf8"),
        "the packages of 1.0.0\n",
    );
});

test("an ignored file of the owner's where the release has a file stops the update, and stays", async () => {
    const { upstream, app, first } = setUp();

    writeFileSync(join(upstream, "notes.local"), "the release's file\n");
    release(upstream, "1.1.0", { license: "MIT" });
    writeFileSync(join(app, ".git", "info", "exclude"), "notes.local\n");
    writeFileSync(join(app, "notes.local"), "my own notes\n");
    const paused: boolean[] = [];
    const { updates, restarts } = updater(app, upstream, () => releaseOf("1.1.0"), {
        quiesce: (on) => paused.push(on),
    });

    assert.match((await updates.check()).blockers.join("\n"), /A file of yours .*notes\.local/);
    await assert.rejects(updates.apply(), /A file of yours/);
    assert.equal(readFileSync(join(app, "notes.local"), "utf8"), "my own notes\n");
    assert.equal(run(app, ["rev-parse", "HEAD"]), first);
    assert.equal(readFileSync(join(app, "node_modules", "old.txt"), "utf8").length > 0, true);
    assert.equal(readPending(app), undefined);
    assert.deepEqual(paused, [], "nothing was paused: the update never got as far as git");
    assert.equal(restarts.length, 0);
});

test("packages that do not install leave the checkout as it was, and are noted so nothing retries them by itself", async () => {
    const { upstream, app, first } = setUp();

    // A package whose file is not there: `npm ci` fails, without the network.
    release(upstream, "1.1.0", undefined, false);
    const lockFile = JSON.parse(readFileSync(join(upstream, "package-lock.json"), "utf8"));
    const pkg = JSON.parse(readFileSync(join(upstream, "package.json"), "utf8"));

    pkg.dependencies = lockFile.packages[""].dependencies = { "left-pad": "1.0.0" };
    lockFile.packages["node_modules/left-pad"] = { version: "1.0.0", resolved: "file:missing.tgz" };
    writeFileSync(join(upstream, "package.json"), JSON.stringify(pkg, null, 2));
    writeFileSync(join(upstream, "package-lock.json"), JSON.stringify(lockFile, null, 2));
    run(upstream, ["commit", "--quiet", "-am", "left-pad"]);
    run(upstream, ["tag", "v1.1.0"]);
    const { updates } = updater(app, upstream, () => releaseOf("1.1.0"));

    await assert.rejects(updates.apply(), /Installing the new packages failed/);
    assert.equal(run(app, ["rev-parse", "HEAD"]), first);
    assert.equal(existsSync(join(app, "node_modules", "old.txt")), true);
    assert.equal(existsSync(updatePaths(app).staging), false);

    const last = readOutcome(app);

    assert.equal(last?.ok, false);
    assert.equal(last?.toVersion, "1.1.0");
    assert.equal((await updates.status()).step, undefined);
});

test("an update stops after its packages when it is no longer wanted", async () => {
    const { upstream, app, first } = setUp();

    release(upstream, "1.1.0");
    const { updates } = updater(app, upstream, () => releaseOf("1.1.0"));

    await assert.rejects(
        updates.apply({ stillWanted: () => "Someone started to work." }),
        /started/,
    );
    assert.equal(run(app, ["rev-parse", "HEAD"]), first);
    assert.equal(readPending(app), undefined);
});

test("the launcher does not go back on a branch someone switched to meanwhile", async () => {
    const { upstream, app } = setUp();
    const next = release(upstream, "1.1.0");
    const { updates } = updater(app, upstream, () => releaseOf("1.1.0"));

    await updates.apply();
    run(app, ["switch", "--quiet", "-c", "other"]);

    assert.match(rollBackUpdate(app) ?? "", /no longer on main/);
    assert.equal(run(app, ["rev-parse", "HEAD"]), next);
    assert.equal(run(app, ["rev-parse", "main"]), next, "main stays where the update put it");
});

test("a server stopped while git moved the checkout gets the files before back at its next start", async () => {
    const { upstream, app, first } = setUp();

    writeFileSync(join(upstream, "added.txt"), "new in 1.1.0\n");
    release(upstream, "1.1.0");
    const { updates } = updater(app, upstream, () => releaseOf("1.1.0"));

    await updates.apply();
    // Files of the owner's that the update never touched: they stay.
    writeFileSync(join(app, ".git", "info", "exclude"), "mine.local\n");
    writeFileSync(join(app, "mine.local"), "ignored, mine\n");
    writeFileSync(join(app, "mine.txt"), "untracked, mine\n");
    // As though git stopped part way: HEAD at 1.0.0, some files of 1.1.0's.
    run(app, ["update-ref", "refs/heads/main", first]);
    assert.equal(readFileSync(join(app, "code.txt"), "utf8"), "code of 1.1.0\n");

    const outcome = await updater(app, upstream, () => releaseOf("1.1.0")).updates.recover();

    assert.match(outcome?.message ?? "", /did not finish/);
    assert.equal(readFileSync(join(app, "code.txt"), "utf8"), "code of 1.0.0\n");
    assert.equal(existsSync(join(app, "added.txt")), false);
    assert.equal(readFileSync(join(app, "mine.local"), "utf8"), "ignored, mine\n");
    assert.equal(readFileSync(join(app, "mine.txt"), "utf8"), "untracked, mine\n");
    assert.equal(run(app, ["status", "--porcelain"]), "?? mine.txt");
});

test("files the owner changes while packages install stop the update before git moves anything", async () => {
    const { upstream, app, first } = setUp();

    release(upstream, "1.1.0");
    const paused: boolean[] = [];
    const { updates } = updater(app, upstream, () => releaseOf("1.1.0"), {
        quiesce: (on) => paused.push(on),
    });

    await assert.rejects(
        updates.apply({
            // Stands for the minutes of `npm ci`, during which the owner edits a file.
            stillWanted: () => {
                writeFileSync(join(app, "code.txt"), "edited meanwhile\n");

                return undefined;
            },
        }),
        /Files changed while the update got ready/,
    );
    assert.equal(readFileSync(join(app, "code.txt"), "utf8"), "edited meanwhile\n");
    assert.equal(run(app, ["rev-parse", "HEAD"]), first);
    assert.deepEqual(paused, []);
    assert.equal(readPending(app), undefined);
});

test("git refusing to move the checkout ends the update cleanly, packages back and reloads on again", async () => {
    const { upstream, app, first } = setUp();

    release(upstream, "1.1.0", { license: "MIT" });
    const paused: boolean[] = [];
    const { updates, restarts } = updater(app, upstream, () => releaseOf("1.1.0"), {
        quiesce: (on) => paused.push(on),
        // Another git holds the index just as the update moves: git refuses before it writes.
        log: () => {},
    });

    await updates.check();
    const lock = join(app, ".git", "index.lock");

    await assert.rejects(
        updates.apply({
            stillWanted: () => {
                writeFileSync(lock, "");

                return undefined;
            },
        }),
        /failed/,
    );
    rmSync(lock);
    assert.equal(run(app, ["rev-parse", "HEAD"]), first);
    assert.equal(readFileSync(join(app, "node_modules", "old.txt"), "utf8").length > 0, true);
    assert.equal(readPending(app), undefined);
    assert.equal(readOutcome(app)?.ok, false);
    assert.deepEqual(paused, [true, false]);
    assert.equal(restarts.length, 0);
});

test("what someone writes in the instant before git moves is kept, though the files go back", async () => {
    const { upstream, app, first } = setUp();

    writeFileSync(join(upstream, "added.txt"), "new in 1.1.0\n");
    release(upstream, "1.1.0");
    const { updates } = updater(app, upstream, () => releaseOf("1.1.0"), {
        // Just after the last check, before git runs: an edit, and an ignored file where the release adds one.
        quiesce: (on) => {
            if (on) {
                writeFileSync(join(app, "code.txt"), "edited in the instant\n");
                writeFileSync(join(app, ".git", "info", "exclude"), "added.txt\n");
                writeFileSync(join(app, "added.txt"), "mine, ignored\n");
            }
        },
    });

    await assert.rejects(updates.apply(), /stopped part way/);
    assert.equal(readPending(app)?.phase, "switching", "noted, for the restart to finish");
    assert.equal(run(app, ["rev-parse", "HEAD"]), first);

    const outcome = await updater(app, upstream, () => releaseOf("1.1.0")).updates.recover();

    assert.match(outcome?.message ?? "", /kept in \.pocket-update\/kept\//);
    const folder = /kept in (\S+?)\.$/.exec(outcome!.message)![1]!;

    assert.equal(readFileSync(join(app, folder, "code.txt"), "utf8"), "edited in the instant\n");
    assert.equal(readFileSync(join(app, folder, "added.txt"), "utf8"), "mine, ignored\n");
    assert.equal(readFileSync(join(app, "code.txt"), "utf8"), "code of 1.0.0\n");
});

test("a release that puts a file where a folder of tracked files was is not blocked by that folder", async () => {
    const { upstream, app } = setUp();

    mkdirSync(join(upstream, "thing"));
    writeFileSync(join(upstream, "thing", "child"), "tracked\n");
    run(upstream, ["add", "-A"]);
    run(upstream, ["commit", "--quiet", "-m", "thing"]);
    run(app, ["pull", "--quiet"]);
    run(upstream, ["rm", "--quiet", "-r", "thing"]);
    writeFileSync(join(upstream, "thing"), "a file now\n");
    const next = release(upstream, "1.1.0");
    const { updates } = updater(app, upstream, () => releaseOf("1.1.0"));

    assert.deepEqual((await updates.check()).blockers, []);
    await updates.apply();
    assert.equal(run(app, ["rev-parse", "HEAD"]), next);
    assert.equal(readFileSync(join(app, "thing"), "utf8"), "a file now\n");

    // With a file of the owner's in that folder, it is in the way.
    const other = setUp();

    mkdirSync(join(other.upstream, "thing"));
    writeFileSync(join(other.upstream, "thing", "child"), "tracked\n");
    run(other.upstream, ["add", "-A"]);
    run(other.upstream, ["commit", "--quiet", "-m", "thing"]);
    run(other.app, ["pull", "--quiet"]);
    writeFileSync(join(other.app, "thing", "mine"), "untracked\n");
    run(other.upstream, ["rm", "--quiet", "-r", "thing"]);
    writeFileSync(join(other.upstream, "thing"), "a file now\n");
    release(other.upstream, "1.1.0");
    const blocked = await updater(other.app, other.upstream, () =>
        releaseOf("1.1.0"),
    ).updates.check();

    assert.match(blocked.blockers.join("\n"), /A file of yours .*thing/);
});

test("a folder or a link where a changed file was, and a second recovery, keep everything of the owner's", async () => {
    const { upstream, app, first } = setUp();

    writeFileSync(join(upstream, "other.txt"), "tracked in 1.1.0 too\n");
    release(upstream, "1.1.0");
    const { updates } = updater(app, upstream, () => releaseOf("1.1.0"));

    await updates.apply();
    run(app, ["update-ref", "refs/heads/main", first]);
    // In place of code.txt, a folder of the owner's; in place of package.json, a link of the owner's.
    rmSync(join(app, "code.txt"));
    mkdirSync(join(app, "code.txt"));
    writeFileSync(join(app, "code.txt", "mine"), "in a folder\n");
    rmSync(join(app, "package.json"));
    symlinkSync("somewhere-of-mine", join(app, "package.json"));

    const pending = readPending(app)!;
    const kept = undoPartialSwitch(app, pending);

    assert.deepEqual(kept.paths.sort(), ["code.txt", "package.json"]);
    assert.equal(readFileSync(join(kept.folder!, "code.txt", "mine"), "utf8"), "in a folder\n");
    assert.equal(readlinkSync(join(kept.folder!, "package.json")), "somewhere-of-mine");
    assert.equal(readFileSync(join(app, "code.txt"), "utf8"), "code of 1.0.0\n");
    assert.match(
        keptNote(app, kept),
        /\(code\.txt, package\.json\) is kept in \.pocket-update\/kept\//,
    );

    // Stopped before it noted the end: another edit, and the next try keeps it in a folder of its own.
    writeFileSync(join(app, "code.txt"), "a second edit\n");
    const again = undoPartialSwitch(app, pending);

    assert.notEqual(again.folder, kept.folder);
    assert.equal(readFileSync(join(again.folder!, "code.txt"), "utf8"), "a second edit\n");
    assert.equal(readFileSync(join(kept.folder!, "code.txt", "mine"), "utf8"), "in a folder\n");
    assert.equal(run(app, ["status", "--porcelain"]), "");
});

test("a file the release makes a folder, with something of the owner's in it, is kept whole when undone", async () => {
    const { upstream, app } = setUp();

    writeFileSync(join(upstream, "tools"), "a file in 1.0.1\n");
    const from = release(upstream, "1.0.1");

    run(app, ["pull", "--quiet", "--ff-only"]);
    rmSync(join(upstream, "tools"));
    mkdirSync(join(upstream, "tools"));
    writeFileSync(join(upstream, "tools", "b.txt"), "in a folder in 1.1.0\n");
    release(upstream, "1.1.0");

    await updater(app, upstream, () => releaseOf("1.1.0")).updates.apply();
    // Stopped part way, and the owner wrote into the release's new folder before the next start.
    run(app, ["update-ref", "refs/heads/main", from]);
    writeFileSync(join(app, "tools", "mine.txt"), "the owner's\n");

    const kept = undoPartialSwitch(app, readPending(app)!);

    assert.deepEqual(kept.paths, ["tools"]);
    assert.equal(readFileSync(join(kept.folder!, "tools", "mine.txt"), "utf8"), "the owner's\n");
    assert.equal(readFileSync(join(app, "tools"), "utf8"), "a file in 1.0.1\n");
    assert.equal(run(app, ["status", "--porcelain"]), "");
});

test("a clean filter that hides part of a file does not make the owner's file look like git's", async () => {
    const { upstream, app, first } = setUp();

    release(upstream, "1.1.0");
    const { updates } = updater(app, upstream, () => releaseOf("1.1.0"));

    await updates.apply();
    run(app, ["update-ref", "refs/heads/main", first]);
    run(app, ["config", "filter.strip.clean", "grep -v LOCAL || true"]);
    writeFileSync(join(app, ".git", "info", "attributes"), "code.txt filter=strip\n");
    writeFileSync(join(app, "code.txt"), "code of 1.0.0\nLOCAL a note of mine\n");

    const kept = undoPartialSwitch(app, readPending(app)!);

    assert.deepEqual(kept.paths, ["code.txt"]);
    assert.equal(
        readFileSync(join(kept.folder!, "code.txt"), "utf8"),
        "code of 1.0.0\nLOCAL a note of mine\n",
    );
});

test("going back keeps a file someone put where only the version before has one", async () => {
    const { upstream, app, first } = setUp();

    writeFileSync(join(upstream, "notes.local"), "tracked in 1.0.0\n");
    run(upstream, ["add", "-A"]);
    run(upstream, ["commit", "--quiet", "-m", "notes"]);
    run(app, ["pull", "--quiet"]);
    const base = run(app, ["rev-parse", "HEAD"]);

    assert.notEqual(base, first);
    run(upstream, ["rm", "--quiet", "notes.local"]);
    release(upstream, "1.1.0");
    const { updates } = updater(app, upstream, () => releaseOf("1.1.0"));

    await updates.apply();
    // Gone in 1.1.0; the owner puts an ignored file of their own there.
    writeFileSync(join(app, ".git", "info", "exclude"), "notes.local\n");
    writeFileSync(join(app, "notes.local"), "mine now\n");

    const said = rollBackUpdate(app) ?? "";

    assert.match(said, /went back/);
    assert.equal(run(app, ["rev-parse", "HEAD"]), base);
    assert.equal(readFileSync(join(app, "notes.local"), "utf8"), "tracked in 1.0.0\n");
    const folder = /kept in (\S+?)\.$/.exec(said)![1]!;

    assert.equal(readFileSync(join(app, folder, "notes.local"), "utf8"), "mine now\n");
});

test("a repository address that git could read as an option or a command is refused before git runs", async () => {
    const { upstream, app } = setUp();
    const marker = join(root, "executed");

    for (const repository of [
        `--upload-pack=touch ${marker} #`,
        `ext::sh -c touch% ${marker}`,
        "http://example.com/plain.git",
    ]) {
        const { updates } = updater(app, upstream, () => undefined, {
            repository,
            releases: undefined,
        });
        const status = await updates.check();

        assert.match(status.error ?? "", /Updates do not fetch from/);
        assert.equal(existsSync(marker), false);
    }

    assert.equal(repositoryProblem("https://github.com/TannerMidd/pi-pocket.git"), undefined);
    assert.equal(repositoryProblem("git@github.com:TannerMidd/pi-pocket.git"), undefined);
    assert.equal(repositoryProblem(upstream), undefined);
});

test("a lock git left behind ends the update with words for the owner, rather than failing at each start", async () => {
    const { upstream, app, first } = setUp();

    release(upstream, "1.1.0");
    const { updates } = updater(app, upstream, () => releaseOf("1.1.0"));

    await updates.apply();
    run(app, ["update-ref", "refs/heads/main", first]);
    writeFileSync(join(app, ".git", "index.lock"), "");

    // The launcher's try, and the server's: each ends the update once.
    const said = rollBackUpdate(app) ?? "";

    assert.match(said, /Fix the checkout by hand/);
    assert.equal(readPending(app), undefined);
    assert.equal(rollBackUpdate(app), undefined);
    rmSync(join(app, ".git", "index.lock"));
});

test("a server that starts on an update stopped part way puts it back, without reloads, and restarts", async () => {
    const { upstream, app, first } = setUp();

    release(upstream, "1.1.0");
    await updater(app, upstream, () => releaseOf("1.1.0")).updates.apply();
    run(app, ["update-ref", "refs/heads/main", first]);

    const paused: boolean[] = [];
    const { updates, restarts } = updater(app, upstream, () => releaseOf("1.1.0"), {
        quiesce: (on) => paused.push(on),
    });
    const outcome = await updates.recover();

    assert.match(outcome?.message ?? "", /did not finish/);
    assert.deepEqual(paused, [true]);
    assert.equal(restarts.length, 1);
    assert.equal(readFileSync(join(app, "code.txt"), "utf8"), "code of 1.0.0\n");
});

test("the install by itself takes only a release that needs no question, and the launcher goes back only for the version's fault", () => {
    const ready = {
        version: "1.0.0",
        installKind: "git",
        repository: "x",
        beta: false,
        available: true,
        blockers: [],
        cautions: [],
        packages: false,
        busy: 0,
        supervised: true,
        rollback: true,
        latest: releaseOf("1.1.0"),
    } satisfies UpdateStatus;

    assert.equal(installsByItself(ready), true);
    assert.equal(installsByItself({ ...ready, busy: 1 }), false, "someone at work");
    assert.equal(installsByItself({ ...ready, blockers: ["no"] }), false);
    assert.equal(
        installsByItself({ ...ready, rollback: false }),
        false,
        "a launcher that cannot go back",
    );
    assert.equal(installsByItself({ ...ready, step: "Checking" }), false);
    assert.equal(
        installsByItself({
            ...ready,
            latest: releaseOf("1.1.0", { notes: "> [!WARNING]\n> One way." }),
        }),
        false,
    );
    assert.equal(
        installsByItself({ ...ready, latest: { ...releaseOf("1.1.0"), notes: undefined } }),
        false,
        "no notes to read a warning in",
    );
    const failed = {
        v: 1 as const,
        id: "x",
        ok: false,
        tag: "v1.1.0",
        fromVersion: "1.0.0",
        toVersion: "1.1.0",
        message: "",
        at: 0,
    };

    assert.equal(installsByItself({ ...ready, last: failed }), false, "it failed before");
    assert.equal(installsByItself({ ...ready, last: { ...failed, toVersion: "1.0.5" } }), true);

    assert.equal(stopMeansRollBack(false, 1), true);
    assert.equal(stopMeansRollBack(false, null), true, "killed by a signal");
    assert.equal(stopMeansRollBack(false, 75), false, "a restart it asked for");
    assert.equal(stopMeansRollBack(false, 78), false, "a port it cannot listen on");
    assert.equal(stopMeansRollBack(true, 1), false, "it was ready: a crash after is not the start");
});

test("a checkout that writes CRLF line endings does not make git's own files look like the owner's", async () => {
    const { upstream, app, first } = setUp();

    release(upstream, "1.1.0");
    await updater(app, upstream, () => releaseOf("1.1.0")).updates.apply();
    run(app, ["update-ref", "refs/heads/main", first]);
    run(app, ["config", "core.autocrlf", "true"]);
    // As git writes the release's file here, part way.
    writeFileSync(join(app, "code.txt"), "code of 1.1.0\r\n");

    const kept = undoPartialSwitch(app, readPending(app)!);

    assert.deepEqual(kept.paths, []);
    assert.equal(kept.folder, undefined);
});

test("status names files as they are, renames by their new name", () => {
    assert.deepEqual(changedFiles(" M a b.txt\0R  new.txt\0old.txt\0 M nl\nname\0"), [
        "a b.txt",
        "new.txt",
        "nl\nname",
    ]);
    assert.deepEqual(changedFiles(""), []);
});

test("a release that moves a submodule leaves the submodule's folder where it is when undone", async () => {
    const { upstream, app, first } = setUp();
    const sub = join(upstream, "..", "sub");
    const allow = ["-c", "protocol.file.allow=always"];

    mkdirSync(sub);
    run(sub, ["init", "--quiet"]);
    writeFileSync(join(sub, "s.txt"), "one\n");
    run(sub, ["add", "-A"]);
    run(sub, ["commit", "--quiet", "-m", "one"]);
    run(upstream, [...allow, "submodule", "--quiet", "add", sub, "mod"]);
    run(upstream, ["commit", "--quiet", "-m", "mod"]);
    run(app, ["pull", "--quiet"]);
    run(app, [...allow, "submodule", "--quiet", "update", "--init"]);
    const base = run(app, ["rev-parse", "HEAD"]);

    assert.notEqual(base, first);
    writeFileSync(join(sub, "s.txt"), "two\n");
    run(sub, ["commit", "--quiet", "-am", "two"]);
    run(join(upstream, "mod"), ["pull", "--quiet"]);
    run(upstream, ["add", "mod"]);
    release(upstream, "1.1.0");
    await updater(app, upstream, () => releaseOf("1.1.0")).updates.apply();
    run(app, ["update-ref", "refs/heads/main", base]);

    const kept = undoPartialSwitch(app, readPending(app)!);

    assert.ok(!kept.paths.includes("mod"));
    assert.equal(readFileSync(join(app, "mod", "s.txt"), "utf8"), "one\n");
});

test("a failed npm says its cause, not its help for the command", () => {
    const said = [
        "npm error code EUSAGE",
        "npm error",
        "npm error `npm ci` can only install packages when your package.json and package-lock.json are in sync.",
        "npm error",
        "npm error Missing: is-number@6.0.0 from lock file",
        "npm error",
        "npm error Clean install a project",
        "npm error",
        "npm error Usage:",
        "npm error npm ci",
        ...Array.from({ length: 30 }, (_, at) => `npm error   --option-${at}`),
    ].join("\n");

    assert.equal(
        failureLines(said),
        "code EUSAGE\n`npm ci` can only install packages when your package.json and package-lock.json are in sync.\nMissing: is-number@6.0.0 from lock file",
    );
    assert.equal(failureLines("one\ntwo\n"), "one\ntwo");
});

test("updates order pre-releases, and the API version compare keeps treating them as their release", () => {
    assert.equal(newer("0.27.0-beta.2", "0.27.0-beta.1"), true);
    assert.equal(newer("0.27.0-beta.1", "0.27.0-beta.2"), false);
    assert.equal(newer("0.27.0-beta.10", "0.27.0-beta.9"), true, "numbers, not text");
    assert.equal(newer("0.27.0", "0.27.0-beta.9"), true, "the release follows its betas");
    assert.equal(newer("0.27.0-beta.9", "0.27.0"), false);
    assert.equal(newer("0.27.0-beta.1", "0.26.0"), true);
    assert.equal(newer("0.26.1", "0.27.0-beta.1"), false, "no downgrade to an older stable");
    assert.equal(newer("0.27.0-beta.1", "0.27.0-beta.1"), false);
    assert.equal(newer("0.27.0-beta.1", "0.27.0+build.5"), false);
    assert.equal(newer("0.27.0-beta.1", "garbage"), false);
    assert.equal(compareReleases("0.27.0-alpha.1", "0.27.0-beta.1"), -1);
    assert.equal(compareReleases("0.27.0-1", "0.27.0-beta.1"), -1, "numbers come first");
    assert.equal(compareReleases("0.27.0-beta", "0.27.0-beta.1"), -1, "fewer fields first");
    assert.equal(compareReleases("1.0", "1.0.0"), undefined);
    // Extension and theme API versions: a pre-release is its release, as before.
    assert.deepEqual(versionParts("0.27.0-beta.1"), [0, 27, 0]);
    assert.equal(atLeast("0.27.0-beta.1", "0.27.0"), true);
    assert.equal(atLeast("0.27.0", "0.27.0-beta.1"), true);
});

test("the beta channel reads GitHub's list, version tags, and npm's dist-tags", () => {
    const repository = { owner: "o", name: "r" };
    const entry = (tag_name: string, extra: Record<string, unknown> = {}) => ({
        tag_name,
        name: tag_name,
        body: "Notes.",
        ...extra,
    });
    const list = [
        entry("v0.27.0-beta.2", { prerelease: true }),
        entry("v0.27.0-beta.1", { prerelease: true }),
        entry("v0.28.0", { draft: true }),
        entry("nightly"),
        entry("v0.26.0"),
    ];
    const newest = newestOfReleases(repository, list);

    assert.equal(newest?.tag, "v0.27.0-beta.2");
    assert.equal(newest?.version, "0.27.0-beta.2");
    assert.equal(newest?.beta, true, "a beta is marked");
    assert.equal(newest?.notes, "Notes.");
    assert.match(newest?.url ?? "", /releases\/tag\/v0\.27\.0-beta\.2$/);
    assert.equal(
        newestOfReleases(repository, [entry("v0.27.0-beta.3"), entry("v0.27.0"), entry("v0.26.1")])
            ?.tag,
        "v0.27.0",
        "the stable release follows its betas, whatever the order",
    );
    assert.equal(newestOfReleases(repository, [entry("v0.27.0", { draft: true })]), undefined);
    assert.equal(newestOfReleases(repository, { message: "Not Found" }), undefined);
    assert.equal(newestOfReleases(repository, [entry("v0.26.0")])?.beta, undefined);

    const tags = [
        "v0.26.0",
        "v0.27.0-beta.1",
        "v0.27.0-beta.10",
        "v0.27.0-beta.2",
        "v0.27.0-rc.1",
        "v0.27.0-beta.1-evil",
    ]
        .map((tag) => `${"a".repeat(40)}\trefs/tags/${tag}`)
        .join("\n");

    assert.equal(newestTag(tags)?.tag, "v0.26.0", "betas are not offered with the channel off");
    assert.equal(newestTag(tags, true)?.tag, "v0.27.0-beta.10");
    assert.equal(newestTag(`${tags}\n${"a".repeat(40)}\trefs/tags/v0.27.0`, true)?.tag, "v0.27.0");
    assert.equal(newestTag("", true), undefined);

    const npm = (tags: Record<string, unknown>) => ({
        "dist-tags": tags,
        versions: Object.fromEntries(
            Object.values(tags).map((version) => [String(version), { engines: {} }]),
        ),
    });

    assert.equal(pickNpmVersion(npm({ latest: "0.26.0", beta: "0.27.0-beta.1" })), "0.26.0");
    assert.equal(
        pickNpmVersion(npm({ latest: "0.26.0", beta: "0.27.0-beta.1" }), true),
        "0.27.0-beta.1",
    );
    assert.equal(
        pickNpmVersion(npm({ latest: "0.27.0", beta: "0.27.0-beta.2" }), true),
        "0.27.0",
        "a beta tag left behind by the stable release is not newer",
    );
    assert.equal(pickNpmVersion(npm({ latest: "0.26.0" }), true), "0.26.0", "no beta tag yet");
    assert.equal(
        pickNpmVersion(
            {
                "dist-tags": { latest: "0.26.0", beta: "0.27.0-beta.1" },
                versions: { "0.26.0": {} },
            },
            true,
        ),
        "0.26.0",
        "a beta with no package metadata is skipped",
    );
    assert.throws(() => pickNpmVersion(npm({ latest: "0.27.0-beta.1" })), /not a release version/);
    assert.throws(
        () => pickNpmVersion(npm({ latest: "0.27.0-beta.1" }), true),
        /not a release version/,
    );
    assert.throws(
        () => pickNpmVersion({ "dist-tags": { latest: "0.26.0" }, versions: {} }),
        /no published/,
    );
});

test("the beta channel offers pre-releases only when it is on, and a beta still gets the next stable release", async () => {
    const { upstream, app } = setUp();
    const beta = release(upstream, "1.1.0-beta.1");
    const off = tagged(app, upstream);
    const stable = await off.updates.check();

    assert.equal(stable.beta, false);
    assert.equal(stable.latest?.tag, "v1.0.0");
    assert.equal(stable.available, false);

    off.updates.setBeta(true);
    const on = await off.updates.check();

    assert.equal(on.beta, true);
    assert.equal(on.latest?.tag, "v1.1.0-beta.1");
    assert.equal(on.latest?.beta, true);
    assert.equal(on.available, true);
    assert.deepEqual(on.blockers, []);
    assert.match(on.cautions.join("\n"), /This is a beta version/);

    off.updates.setBeta(false);
    assert.equal((await off.updates.status()).available, false);
    assert.equal((await off.updates.status()).latest, undefined);
    assert.equal((await off.updates.check()).latest?.tag, "v1.0.0");

    const going = tagged(app, upstream, { beta: true });

    await going.updates.check();
    await going.updates.apply();
    assert.equal(run(app, ["rev-parse", "HEAD"]), beta);
    await waitFor(() => going.restarts.length === 1, "the server restarts");

    release(upstream, "1.1.0");
    release(upstream, "1.0.1", undefined, true);
    const running = tagged(app, upstream, { version: "1.1.0-beta.1" });
    const next = await running.updates.check();

    assert.equal(next.latest?.tag, "v1.1.0");
    assert.equal(next.available, true, "the release follows its beta");
    assert.equal(next.latest?.beta, undefined);
    assert.doesNotMatch(next.cautions.join("\n"), /beta version/);

    const older = updater(setUp().app, upstream, () => releaseOf("1.0.0"), {
        version: "1.1.0-beta.1",
    });

    assert.equal((await older.updates.check()).available, false, "no downgrade");
});

test("a pre-release from a stand-in source is offered only while the channel is on", async () => {
    const { upstream, app } = setUp();
    const asked: (boolean | undefined)[] = [];

    const source = (_signal?: AbortSignal, beta?: boolean) => {
        asked.push(beta);

        return Promise.resolve(releaseOf("1.1.0-beta.1", { beta: true }));
    };

    const { updates } = updater(app, upstream, () => undefined, { releases: source });

    assert.equal((await updates.check()).latest, undefined, "a beta that slipped in is dropped");
    updates.setBeta(true);
    assert.equal((await updates.check()).latest?.version, "1.1.0-beta.1");
    assert.deepEqual(asked, [false, true]);
});
