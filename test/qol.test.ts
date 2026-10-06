// The message box's helpers on the server: `!` commands, mentioned files sent along, skills, the file viewer, undoing a
// file from Changes, and session titles.
import {
    type App,
    cleanUp,
    context,
    lastText,
    modelTexts,
    newSession,
    openApp,
    owner,
    root,
    say,
    scriptedModel,
    until,
} from "./helpers.ts";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, test } from "node:test";
import type { FauxResponseStep } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxText } from "@earendil-works/pi-ai/providers/faux";
import { ShellRequestsDoc } from "../src/server/docs.ts";
import { mentionedPaths } from "../src/server/files.ts";
import type { ClientEntry } from "../src/server/projection.ts";
import { cleanTitle, TITLE_PROMPT, titleModel, wantsTitle } from "../src/server/titles.ts";

/** Echoes, except that it names sessions when asked to. */
const route: FauxResponseStep = (request) => {
    const { text } = lastText(request as never);

    if (text.startsWith(TITLE_PROMPT)) {
        return fauxAssistantMessage([fauxText('"Tidy The Release Script."')]);
    }

    return fauxAssistantMessage([fauxText(`echo: ${text}`)]);
};

let app: App;
const folder = join(root, "qol");

before(async () => {
    mkdirSync(folder, { recursive: true });
    app = await openApp(scriptedModel(route), join(root, "qol-data"));
});

after(async () => {
    await app?.close();
    cleanUp();
});

/** The conversation's entries as browsers get them, oldest first. */
const entries = (id: Parameters<App["fullEntry"]>[0]): Promise<ClientEntry[]> =>
    app.history(id, Number.MAX_SAFE_INTEGER);

test("`!` runs a command in the session's folder and Pi sees it; `!!` shows it to people only", async () => {
    const id = await newSession(app, folder);

    writeFileSync(join(folder, "hello.txt"), "hi from the file\n");
    await app.shell.start(id, owner(app), { command: "cat hello.txt; exit 3" });
    await until(
        async () => (await entries(id)).some((entry) => entry.kind === "shell"),
        "the first command's entry",
    );
    await app.shell.start(id, owner(app), { command: "echo secret", context: false });
    await until(
        async () => (await entries(id)).filter((entry) => entry.kind === "shell").length === 2,
        "the second command's entry",
    );
    const shells = (await entries(id)).filter((entry) => entry.kind === "shell");

    assert.deepEqual(
        shells.map(
            (entry) =>
                entry.kind === "shell" && {
                    command: entry.command,
                    output: entry.output,
                    code: entry.code,
                    status: entry.status,
                    context: entry.context,
                },
        ),
        [
            {
                command: "cat hello.txt; exit 3",
                output: "hi from the file\n",
                code: 3,
                status: "done",
                context: true,
            },
            { command: "echo secret", output: "secret\n", code: 0, status: "done", context: false },
        ],
    );
    const seen = (await modelTexts(app, id)).join("\n");

    assert.match(seen, /Ran `cat hello.txt; exit 3`/);
    assert.match(seen, /hi from the file/);
    assert.match(seen, /Command exited with code 3/);
    assert.doesNotMatch(seen, /secret/);
    await assert.rejects(app.shell.start(id, owner(app), { command: "  " }), /Say which command/);
});

test("a `!` command Pi sees makes Pi work for its person, as a message does; one Pi does not see does not", async () => {
    const id = await newSession(app, folder);
    const { user: guest } = app.config.addUser("Runner", "guest");

    try {
        await say(app, id, "hello from the owner");
        assert.equal(app.requesterOf(id), owner(app).id);
        await app.shell.start(id, guest, { command: "echo quiet", context: false });
        await until(
            async () => (await entries(id)).some((entry) => entry.kind === "shell"),
            "the quiet command",
        );
        assert.equal(app.requesterOf(id), owner(app).id, "a command Pi does not see is nobody's");
        await app.shell.start(id, guest, { command: "echo do something risky" });
        await until(
            async () => (await entries(id)).filter((entry) => entry.kind === "shell").length === 2,
            "the command Pi sees",
        );
        await until(() => app.requesterOf(id) === guest.id, "Pi working for the guest");
    } finally {
        app.config.removeUser(guest.id);
    }
});

test("a command that is stopped says so and keeps what it printed; a retried request runs it once; a viewer cannot run one", async () => {
    const id = await newSession(app, folder);
    const { taskId } = await app.shell.start(id, owner(app), {
        command: "echo before; sleep 30",
        requestId: "r-1",
    });

    assert.deepEqual(
        await app.shell.start(id, owner(app), {
            command: "echo before; sleep 30",
            requestId: "r-1",
        }),
        { taskId },
        "the same request: the same command",
    );
    await until(() => app.shell.printed(taskId) === "before\n", "the command's first output");
    await app.shell.stop(id, owner(app), taskId);
    await until(
        async () =>
            (await entries(id)).some(
                (entry) => entry.kind === "shell" && entry.status === "stopped",
            ),
        "the stopped command's entry",
    );
    const stopped = (await entries(id)).filter((entry) => entry.kind === "shell");

    assert.equal(stopped.length, 1);
    assert.equal(stopped[0]?.kind === "shell" && stopped[0].output, "before\n");
    const { user: viewer } = app.config.addUser("Watcher", "viewer");

    try {
        await assert.rejects(
            app.shell.start(id, viewer, { command: "echo hi" }),
            /view this session but not steer/,
        );
    } finally {
        app.config.removeUser(viewer.id);
    }
});

test("a running command keeps its request id however many commands follow; finished ones make room", async () => {
    const id = await newSession(app, folder);
    const me = owner(app);
    const { taskId } = await app.shell.start(id, me, {
        command: "sleep 30",
        requestId: "long",
        context: false,
    });
    const quick: number[] = [];

    for (let index = 0; index < 105; index++) {
        quick.push(
            (
                await app.shell.start(id, me, {
                    command: "true",
                    requestId: `quick-${index}`,
                    context: false,
                })
            ).taskId,
        );
    }

    await until(async () => {
        for (const each of quick) {
            if ((await app.harness.getTask(each as never, context))?.state.status !== "terminal") {
                return false;
            }
        }

        return true;
    }, "the quick commands to finish");
    // The next one makes room among the finished.
    await app.shell.start(id, me, { command: "true", requestId: "one-more", context: false });
    assert.deepEqual(
        await app.shell.start(id, me, { command: "sleep 30", requestId: "long", context: false }),
        { taskId },
        "still the running command",
    );
    const kept = (await app.harness.snapshot(ShellRequestsDoc, id, context))!.items;

    assert.equal(Object.keys(kept).length, 100);
    assert.equal(kept[`${me.id}:quick-0`], undefined, "the oldest finished request made room");
    await app.shell.stop(id, me, taskId);
});

test("mentioned files go along with a message when asked, and show by name", async () => {
    const id = await newSession(app, folder);

    writeFileSync(join(folder, "plan.md"), "# The plan\nShip on Friday.\n");
    const { submissionId } = await app.commands.submit(id, owner(app), {
        text: "Check @plan.md. Also @missing.txt",
        requestId: "mention-1",
        inlineFiles: true,
    });

    await (await app.harness.submission(submissionId, context))!.wait(context);
    const seen = (await modelTexts(app, id)).join("\n");

    assert.match(seen, /<file name=\\"[^"]*plan\.md\\">\\n# The plan\\nShip on Friday/);
    const user = (await entries(id)).find((entry) => entry.kind === "user");

    assert.equal(user?.kind === "user" && user.text, "Check @plan.md. Also @missing.txt");
    assert.deepEqual(user?.kind === "user" && user.files, [join(folder, "plan.md")]);
    assert.deepEqual(mentionedPaths('see @a.ts, @"my notes.md" and me@x.com (@b/c.js)'), [
        { written: "a.ts,", candidates: ["a.ts,", "a.ts"] },
        { written: "my notes.md", candidates: ["my notes.md"] },
        { written: "b/c.js)", candidates: ["b/c.js)", "b/c.js"] },
    ]);
});

test("skills run as /skill:name with the request, as Pi sends them", async () => {
    const skill = join(process.env.PI_CODING_AGENT_DIR!, "skills", "deploy");

    mkdirSync(skill, { recursive: true });
    writeFileSync(
        join(skill, "SKILL.md"),
        "---\nname: deploy\ndescription: Ship the app to production\n---\nRun the deploy script, then check the health page.\n",
    );
    const id = await newSession(app, folder);

    assert.deepEqual(
        app.skillCommands(id).map(({ name, description }) => ({ name, description })),
        [{ name: "deploy", description: "Ship the app to production" }],
    );
    await say(app, id, "/skill:deploy to staging");
    const seen = (await modelTexts(app, id)).join("\n");

    assert.match(seen, /<skill name=\\"deploy\\" location=\\"[^"]*SKILL\.md\\">/);
    assert.match(seen, /Run the deploy script/);
    assert.match(seen, /<\/skill>\\n\\nto staging/);
});

test("a command cut off by a restart is not run again, and its entry says so", async () => {
    const data = join(root, "qol-restart");
    const marker = join(folder, "runs.txt");
    const first = await openApp(scriptedModel(route), data);
    const id = await newSession(first, folder);
    const { taskId } = await first.shell.start(id, owner(first), {
        command: `echo run >> ${marker}; sleep 30`,
        requestId: "once",
    });

    await until(() => existsSync(marker), "the command to start");
    await first.close();
    const second = await openApp(scriptedModel(route), data);

    try {
        // The same request again, as a client whose reply was lost sends it: the command it started, not a new one.
        assert.deepEqual(
            await second.shell.start(id, owner(second), {
                command: `echo run >> ${marker}; sleep 30`,
                requestId: "once",
            }),
            { taskId },
        );
        await until(
            async () =>
                (await second.history(id, Number.MAX_SAFE_INTEGER)).some(
                    (entry) => entry.kind === "shell" && entry.status === "interrupted",
                ),
            "the cut-off entry",
        );
        assert.equal(readFileSync(marker, "utf8"), "run\n", "run once");
        assert.match((await modelTexts(second, id)).join("\n"), /cut off by a server restart/);
    } finally {
        await second.close();
    }
});

test("after a restart, an older message settling does not take Pi back from the person of a newer `!` command", async () => {
    const data = join(root, "qol-attribution");
    // A long answer: the owner's message is still being answered when the guest's command comes in.
    const slow: FauxResponseStep = (request) =>
        lastText(request as never).text.startsWith(TITLE_PROMPT)
            ? fauxAssistantMessage([fauxText("Title")])
            : fauxAssistantMessage([fauxText("word ".repeat(6000))]);
    const first = await openApp(scriptedModel(slow), data);
    const id = await newSession(first, folder);
    const { user: guest } = first.config.addUser("Late", "guest");

    await first.commands.submit(id, owner(first), { text: "write a lot", requestId: "slow-1" });
    await until(() => first.isBusy(id), "Pi to start answering");
    const { taskId } = await first.shell.start(id, guest, { command: "echo from the guest" });

    await until(
        async () =>
            (await first.harness.getTask(taskId as never, context))?.state.status === "terminal",
        "the guest's command to finish",
    );
    assert.equal(first.isBusy(id), true, "the owner's message is still being answered");
    await first.close();
    const second = await openApp(scriptedModel(slow), data);

    try {
        await until(
            async () =>
                (await second.history(id, Number.MAX_SAFE_INTEGER)).some(
                    (entry) => entry.kind === "shell",
                ),
            "the guest's command in place",
            30_000,
        );
        await until(() => !second.isBusy(id), "the answer", 30_000);
        assert.equal(second.requesterOf(id), guest.id);
    } finally {
        await second.close();
    }
});

test("only the owner may read Pi's folder and the app's data, but anyone who steers may read uploads", async () => {
    const id = await newSession(app, folder);
    const { user: guest } = app.config.addUser("Guest", "guest");

    try {
        const agentFile = join(process.env.PI_CODING_AGENT_DIR!, "settings-test.json");

        writeFileSync(agentFile, "{}");
        await assert.rejects(app.viewFile(id, guest, agentFile), /is not there/);
        await assert.rejects(
            app.viewFile(id, guest, join(app.dataDir, "config.json")),
            /is not there/,
        );
        assert.equal((await app.viewFile(id, owner(app), agentFile)).kind, "text");
        mkdirSync(app.uploadDirectory(id), { recursive: true });
        writeFileSync(join(app.uploadDirectory(id), "shared.txt"), "hi");
        assert.equal(
            (await app.viewFile(id, guest, join(app.uploadDirectory(id), "shared.txt"))).kind,
            "text",
        );
    } finally {
        app.config.removeUser(guest.id);
    }
});

test("the viewer shows text, folders, images, and binary files, and says when a file is not there", async () => {
    const id = await newSession(app, folder);

    mkdirSync(join(folder, "docs"), { recursive: true });
    writeFileSync(join(folder, "docs", "a.md"), "alpha\n");
    writeFileSync(join(folder, "blob.bin"), Buffer.from([1, 0, 2, 3]));
    writeFileSync(join(folder, "shot.png"), "not really a png");
    const me = owner(app);

    assert.deepEqual(await app.viewFile(id, me, "docs/a.md"), {
        path: join(folder, "docs", "a.md"),
        display: "docs/a.md",
        kind: "text",
        size: 6,
        text: "alpha\n",
        truncated: false,
    });
    assert.deepEqual(
        (await app.viewFile(id, me, "docs")).kind === "folder" &&
            (await app.viewFile(id, me, "docs")),
        {
            path: join(folder, "docs"),
            display: "docs",
            kind: "folder",
            entries: [{ name: "a.md", dir: false }],
            truncated: false,
        },
    );
    assert.equal((await app.viewFile(id, me, "blob.bin")).kind, "binary");
    assert.equal((await app.viewFile(id, me, "shot.png")).kind, "image");
    execFileSync("mkfifo", [join(folder, "pipe")]);
    assert.equal((await app.viewFile(id, me, "pipe")).kind, "other", "a pipe is not opened");
    mkdirSync(join(folder, "many"), { recursive: true });

    for (let index = 0; index < 1100; index++) {
        writeFileSync(join(folder, "many", `f${index}.txt`), "");
    }

    const many = await app.viewFile(id, me, "many");

    assert.equal(many.kind === "folder" && many.entries.length, 1000);
    assert.equal(many.kind === "folder" && many.truncated, true);
    await assert.rejects(app.viewFile(id, me, "nope.txt"), /nope\.txt is not there/);
});

test("undoing a file from Changes puts it back as committed, and Pi is told", async () => {
    const repo = join(root, "qol-repo");

    mkdirSync(repo, { recursive: true });
    const git = (...args: string[]) => execFileSync("git", args, { cwd: repo, encoding: "utf8" });

    git("init", "-q");
    git("config", "user.email", "t@example.com");
    git("config", "user.name", "T");
    writeFileSync(join(repo, "keep.txt"), "one\n");
    writeFileSync(join(repo, "gone.txt"), "two\n");
    git("add", "-A");
    git("commit", "-qm", "init");
    writeFileSync(join(repo, "keep.txt"), "changed\n");
    execFileSync("rm", [join(repo, "gone.txt")]);
    writeFileSync(join(repo, "fresh.txt"), "new\n");
    const id = await newSession(app, repo);
    const me = owner(app);

    await app.revertChange(id, me, "keep.txt");
    await app.revertChange(id, me, "gone.txt");
    await app.revertChange(id, me, "fresh.txt");
    assert.equal(readFileSync(join(repo, "keep.txt"), "utf8"), "one\n");
    assert.equal(readFileSync(join(repo, "gone.txt"), "utf8"), "two\n");
    assert.equal(existsSync(join(repo, "fresh.txt")), false);
    assert.equal(git("status", "--porcelain"), "");
    await assert.rejects(app.revertChange(id, me, "keep.txt"), /no uncommitted changes/);
    // Both sides added the same file: a conflict is git's to resolve, and the file stays as it is.
    git("checkout", "-qb", "other");
    writeFileSync(join(repo, "both.txt"), "theirs\n");
    git("add", "-A");
    git("commit", "-qm", "theirs");
    git("checkout", "-q", "-");
    writeFileSync(join(repo, "both.txt"), "ours\n");
    git("add", "-A");
    git("commit", "-qm", "ours");
    assert.throws(() => git("merge", "-q", "other"));
    await assert.rejects(app.revertChange(id, me, "both.txt"), /merge conflict/);
    assert.match(readFileSync(join(repo, "both.txt"), "utf8"), /ours/);
    git("merge", "--abort");
    await until(
        async () => (await entries(id)).filter((entry) => entry.kind === "note").length === 3,
        "the notes",
    );
    const notes = (await entries(id)).flatMap((entry) =>
        entry.kind === "note" ? [entry.text] : [],
    );

    assert.deepEqual(notes, [
        "undid the uncommitted changes to keep.txt",
        "undid the uncommitted changes to gone.txt",
        "deleted fresh.txt, which was new since the last commit",
    ]);
    assert.match(
        (await modelTexts(app, id)).join("\n"),
        /\[note\] Owner undid the uncommitted changes to keep.txt/,
    );
});

test("a long first message gets a short written title; a short one is the title", async () => {
    assert.equal(wantsTitle("fix the login bug"), false);
    assert.equal(wantsTitle("please look at the release script and tidy it up for me"), true);
    assert.equal(wantsTitle("one\ntwo"), true);
    assert.equal(cleanTitle('Title: "Fix the login flow."\nmore'), "Fix the login flow");
    assert.equal(cleanTitle("  \n"), undefined);
    const model = (id: string, provider = "p", cost = 1) =>
        ({ id, provider, input: ["text"], cost: { input: cost, output: cost } }) as never;

    assert.equal(
        titleModel(
            [
                model("big"),
                model("big-mini", "p", 0.5),
                model("gemini-pro"),
                model("other-haiku", "q"),
            ],
            model("big"),
        ).id,
        "big-mini",
    );
    assert.equal(titleModel([model("gemini-pro")], model("big")).id, "big");

    const id = await newSession(app, folder);

    await say(
        app,
        id,
        "please look at the release script and tidy it up so the tags come out right",
    );
    await until(
        () =>
            app.sessions().find((each) => each.id === Number(id))?.title ===
            "Tidy The Release Script",
        "the written title",
    );
    const short = await newSession(app, folder);

    await say(app, short, "fix the login bug");
    assert.equal(
        app.sessions().find((each) => each.id === Number(short))?.title,
        "fix the login bug",
    );
});
