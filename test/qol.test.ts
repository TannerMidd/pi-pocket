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
import { ProviderDoc, UsageDoc } from "@earendil-works/pi-durable";
import type { ClientEntry } from "../src/server/projection.ts";
import { cleanTitle, TITLE_PROMPT } from "../src/server/titles.ts";

/**
 * Echoes, except that it names sessions when asked to: a command by what it sends, and with a model that thinks aloud,
 * or goes on until it is cut off, when the message asks for that.
 */
const route: FauxResponseStep = (request) => {
    const { text } = lastText(request as never);

    if (text.startsWith(TITLE_PROMPT)) {
        const thinking =
            "The user wants me to name a chat session with a title of 3 to 6 words for a session that starts with the message below";

        return text.includes("think aloud")
            ? fauxAssistantMessage([fauxText(`${thinking}.\n\nRelease Script Tags`)])
            : text.includes("go on and on")
              ? fauxAssistantMessage([fauxText("Release")], { stopReason: "length" })
              : fauxAssistantMessage([fauxText('"Tidy The Release Script."')]);
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
const entries = (id: Parameters<App["transcripts"]["fullEntry"]>[0]): Promise<ClientEntry[]> =>
    app.transcripts.history(id, Number.MAX_SAFE_INTEGER);

test("`!` runs a command in the session's folder and Pi sees it; `!!` shows it to people only", async () => {
    const id = await newSession(app, folder);

    writeFileSync(join(folder, "hello.txt"), "hi from the file\n");
    await app.shell.start(id, owner(app), {
        command: "printf '\\033[1m'; cat hello.txt; printf '\\033[0m'; exit 3",
    });
    await until(
        async () => (await entries(id)).some((entry) => entry.kind === "shell"),
        "the first command's entry",
    );
    await app.shell.start(id, owner(app), { command: "echo secret", context: false });
    await until(
        async () => (await entries(id)).filter((entry) => entry.kind === "shell").length === 2,
        "the second command's entry",
    );
    const seen = (await modelTexts(app, id)).join("\n");
    const first = (await entries(id)).find((entry) => entry.kind === "shell");

    assert.match(seen, /hi from the file/);
    assert.doesNotMatch(seen, /secret/);
    assert.doesNotMatch(seen, /u001b/, "Pi sees no terminal escape codes");
    assert.equal(first?.kind === "shell" && first.output, "hi from the file\n");
});

test("a `!` command Pi sees makes Pi work for its person, as a message does; one Pi does not see does not", async () => {
    const id = await newSession(app, folder);
    const { user: guest } = app.config.addUser("Runner", "guest");

    try {
        await say(app, id, "hello from the owner");
        assert.equal(app.attribution.requesterOf(id), owner(app).id);
        await app.shell.start(id, guest, { command: "echo quiet", context: false });
        await until(
            async () => (await entries(id)).some((entry) => entry.kind === "shell"),
            "the quiet command",
        );
        assert.equal(
            app.attribution.requesterOf(id),
            owner(app).id,
            "a command Pi does not see is nobody's",
        );
        await app.shell.start(id, guest, { command: "echo do something risky" });
        await until(
            async () => (await entries(id)).filter((entry) => entry.kind === "shell").length === 2,
            "the command Pi sees",
        );
        await until(() => app.attribution.requesterOf(id) === guest.id, "Pi working for the guest");
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
});

test("skills run as /skill:name with the request, as Pi sends them", async () => {
    const skill = join(process.env.PI_CODING_AGENT_DIR!, "skills", "deploy");

    mkdirSync(skill, { recursive: true });
    writeFileSync(
        join(skill, "SKILL.md"),
        "---\nname: deploy\ndescription: Ship the app to production\n---\nRun the deploy script, then check the health page.\n",
    );
    const id = await newSession(app, folder);

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
                (await second.transcripts.history(id, Number.MAX_SAFE_INTEGER)).some(
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
                (await second.transcripts.history(id, Number.MAX_SAFE_INTEGER)).some(
                    (entry) => entry.kind === "shell",
                ),
            "the guest's command in place",
            30_000,
        );
        await until(() => !second.isBusy(id), "the answer", 30_000);
        assert.equal(second.attribution.requesterOf(id), guest.id);
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
        await assert.rejects(app.workspace.viewFile(id, guest, agentFile), /is not there/);
        await assert.rejects(
            app.workspace.viewFile(id, guest, join(app.dataDir, "config.json")),
            /is not there/,
        );
        assert.equal((await app.workspace.viewFile(id, owner(app), agentFile)).kind, "text");
        mkdirSync(app.workspace.uploadDirectory(id), { recursive: true });
        writeFileSync(join(app.workspace.uploadDirectory(id), "shared.txt"), "hi");
        assert.equal(
            (
                await app.workspace.viewFile(
                    id,
                    guest,
                    join(app.workspace.uploadDirectory(id), "shared.txt"),
                )
            ).kind,
            "text",
        );
    } finally {
        app.config.removeUser(guest.id);
    }
});

test("the viewer shows a text file, and does not open a pipe", async () => {
    const id = await newSession(app, folder);

    mkdirSync(join(folder, "docs"), { recursive: true });
    writeFileSync(join(folder, "docs", "a.md"), "alpha\n");
    const me = owner(app);

    assert.deepEqual(await app.workspace.viewFile(id, me, "docs/a.md"), {
        path: join(folder, "docs", "a.md"),
        display: "docs/a.md",
        kind: "text",
        size: 6,
        text: "alpha\n",
        truncated: false,
    });
    execFileSync("mkfifo", [join(folder, "pipe")]);
    assert.equal(
        (await app.workspace.viewFile(id, me, "pipe")).kind,
        "other",
        "a pipe is not opened",
    );
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

    await app.workspace.revertChange(id, me, "keep.txt");
    await app.workspace.revertChange(id, me, "gone.txt");
    await app.workspace.revertChange(id, me, "fresh.txt");
    assert.equal(readFileSync(join(repo, "keep.txt"), "utf8"), "one\n");
    assert.equal(readFileSync(join(repo, "gone.txt"), "utf8"), "two\n");
    assert.equal(existsSync(join(repo, "fresh.txt")), false);
    assert.equal(git("status", "--porcelain"), "");
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
    await assert.rejects(app.workspace.revertChange(id, me, "both.txt"), /merge conflict/);
    assert.match(readFileSync(join(repo, "both.txt"), "utf8"), /ours/);
    git("merge", "--abort");
    await until(
        async () => (await entries(id)).filter((entry) => entry.kind === "note").length === 3,
        "the notes",
    );
    assert.match(
        (await modelTexts(app, id)).join("\n"),
        /\[note\] Owner undid the uncommitted changes to keep.txt/,
    );
});

test("a long first message gets a short written title; a short one is the title", async () => {
    // A model thinking aloud in its reply (#52) gives no title, and its reasoning in tags is left out.
    assert.equal(
        cleanTitle("The user wants me to name a chat session with a title of 3 to 6 words"),
        undefined,
    );
    assert.equal(cleanTitle("<think>\nA title for it.\n</think>\n\nFix Login"), "Fix Login");
    const id = await newSession(app, folder);

    // The session's own model writes its title, not the first or default one: its usage is the title's too.
    await app.commands.configure(id, owner(app), {
        model: { provider: "faux", modelId: "faux-2" },
    });
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
    assert.deepEqual(
        Object.keys((await app.harness.snapshot(UsageDoc, id, context))?.models ?? {}),
        ["faux/faux-2"],
    );
    const short = await newSession(app, folder);

    await say(app, short, "fix the login bug");
    assert.equal(
        app.sessions().find((each) => each.id === Number(short))?.title,
        "fix the login bug",
    );
});

test("a reply that is no title leaves the first message's", async () => {
    const title = (id: unknown) => app.sessions().find((each) => each.id === Number(id))?.title;
    const tokens = async (id: unknown) =>
        (await app.harness.snapshot(UsageDoc, id as never, context))?.models["faux/faux-1"]
            ?.totalTokens ?? 0;
    const complete = app.models.completeSimple;
    const waiting: (() => void)[] = [];
    const letGo = () => waiting.splice(0).forEach((resolve) => resolve());
    let options: Parameters<typeof complete>[2];

    // Title requests wait to be let go: the session's own answer is counted first, and then the title's usage shows
    // when the commit that would rename the session is done.
    app.models.completeSimple = async function (...args) {
        options = args[2];
        await new Promise<void>((resolve) => waiting.push(resolve));

        return complete.apply(app.models, args);
    } as typeof complete;

    try {
        for (const text of [
            "please think aloud, then tidy up the release script's tags",
            "please go on and on, then tidy up the release script's tags",
        ]) {
            const id = await newSession(app, folder);

            await say(app, id, text);
            await until(() => waiting.length > 0, "the title request");
            const answered = await tokens(id);

            letGo();
            await until(async () => (await tokens(id)) > answered, "the title's usage");
            assert.equal(title(id), text);
            // With the session's identity with the provider, which OpenCode Go requires, as Pi Durable's summaries.
            assert.equal(
                options?.sessionId,
                (await app.harness.snapshot(ProviderDoc, id, context))?.sessionId,
            );
            assert.equal(typeof options?.sessionId, "string");
            assert.equal(options?.cacheRetention, "none");
        }
    } finally {
        app.models.completeSimple = complete;
        letGo();
    }
});
