// Plan mode: Pi reads and proposes, anything that changes something is blocked, and approving turns it off.
import {
    type App,
    cleanUp,
    context,
    lastText,
    modelTexts,
    newSession,
    openApp,
    owner,
    say,
    scriptedModel,
    until,
    work,
} from "./helpers.ts";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { after, before, test } from "node:test";
import type { FauxResponseStep } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { ChatDoc, PlanDoc, SubagentsDoc } from "../src/server/docs.ts";
import { blockedInPlanMode, commandWords, readOnlyCommand } from "../src/server/extensions/plan.ts";

test("command lines split into words the way bash would, and anything beyond plain words is refused", () => {
    assert.deepEqual(commandWords(`grep -rn "a|b" src | head -5 && echo 'it''s'`), [
        ["grep", "-rn", "a|b", "src"],
        ["head", "-5"],
        ["echo", "its"],
    ]);
    assert.deepEqual(commandWords(`echo "a \\" b \\x" one\\ word; ls`), [
        ["echo", 'a " b \\x', "one word"],
        ["ls"],
    ]);

    for (const refused of [
        "ls > out",
        "cat < in",
        "echo $HOME",
        'echo "$(id)"',
        "echo `id`",
        "ls *.ts",
        "(ls)",
        "ls &",
        "echo 'open",
        "ls \\\nfoo",
        "a=1 ls",
    ]) {
        const words = commandWords(refused);

        assert.ok(words === undefined || !readOnlyCommand(refused), refused);
    }
});

test("only commands that read pass, with arguments that keep them reading", () => {
    const reads = [
        "ls -la ~/src",
        "cat package.json | head -20",
        "cd src && grep -rn TODO .",
        "find . -name '*.ts' -not -path './node_modules/*'",
        "git status",
        "git --no-pager log --oneline -20",
        "git diff HEAD~1 -- src",
        "sort -u names.txt",
        "uniq -c names.txt",
        "rg --glob '*.md' pi",
        "wc -l src/server/app.ts",
        "git log --oneline -- src",
        "sort --check names.txt",
        "printf '%s\\n' a b",
        "test -f package.json",
    ];

    for (const command of reads) {
        assert.equal(readOnlyCommand(command), true, command);
    }

    const changes = [
        "rm -rf build",
        "npm test",
        "git commit -am x",
        "git -c core.pager=evil log",
        "git diff --output=patch.diff",
        "git grep -O foo",
        "find . -name x -delete",
        "find . -exec rm {} +",
        "sort -o out.txt in.txt",
        "sort -no out.txt in.txt",
        "uniq in.txt out.txt",
        "tree -o out.txt",
        "rg --pre ./run.sh foo",
        "fd -x rm",
        "file -C -m magic",
        // Long options shortened, as getopt and git accept them.
        "git grep --open-files-in-pa='touch pwned;' hello",
        "git log --outp=log.txt",
        "git diff --ext",
        "sort --outp=sorted.txt a",
        "sort --compress-program=sh big.txt",
        "sort --compress=sh big.txt",
        "file --comp",
        "printf b | uniq - out.txt",
        "tree -R -H . -L 2",
        "tree -RH .",
        // The subscript of a name runs what it substitutes.
        "printf -v 'a[$(touch pwned)]' x",
        "printf -vname x",
        "test -v 'a[$(touch pwned)]'",
        "sed -i s/a/b/ f",
        "ls && rm x",
        "",
    ];

    for (const command of changes) {
        assert.equal(readOnlyCommand(command), false, command);
    }
});

test("in plan mode only reading tools pass", () => {
    assert.equal(blockedInPlanMode("read", { path: "a" }), undefined);
    assert.equal(blockedInPlanMode("artifact", {}), undefined);
    assert.equal(blockedInPlanMode("codemode", { code: "" }), undefined);
    assert.equal(blockedInPlanMode("subagent", { action: "status" }), undefined);
    assert.equal(blockedInPlanMode("subagent", { action: "stop" }), undefined);
    assert.equal(blockedInPlanMode("bash", { command: "git log" }), undefined);
    assert.match(
        blockedInPlanMode("write", { path: "a", content: "" }) ?? "",
        /^Plan mode is on: The write tool can change things/,
    );
    assert.match(
        blockedInPlanMode("bash", { command: "npm install" }) ?? "",
        /not a simple read-only one/,
    );
    assert.match(blockedInPlanMode("subagent", { action: "spawn" }) ?? "", /blocked/);
    assert.match(
        blockedInPlanMode("schedule", {}) ?? "",
        /blocked/,
        "tools it does not know are blocked too",
    );
});

/** Whether a request carried the plan mode section of the system prompt. */
let toldPlanMode = false;

/** The scripted model tries to write a file, then lists the folder, then answers with what it learned. */
const route: FauxResponseStep = (request) => {
    const { role, text } = lastText(request as never);
    // System messages are positional: each sets the sections it names, and null removes one.
    let planSection = false;

    for (const message of (
        request as { messages: { role: string; sections?: Record<string, string | null> }[] }
    ).messages) {
        if (
            message.role === "system" &&
            message.sections !== undefined &&
            "plan_mode" in message.sections
        ) {
            planSection = message.sections.plan_mode !== null;
        }
    }

    if (planSection) {
        toldPlanMode = true;
    }

    const call = (name: string, args: Parameters<typeof fauxToolCall>[1]) =>
        fauxAssistantMessage([fauxToolCall(name, args)], { stopReason: "toolUse" });

    if (role === "toolResult" && text.startsWith("Plan mode is on")) {
        return call("bash", { command: "ls" });
    }

    if (role === "toolResult") {
        return fauxAssistantMessage([fauxText(`plan: 1. write the file (saw: ${text.trim()})`)]);
    }

    if (text.endsWith("make a plan")) {
        return call("write", { path: "planned.txt", content: "x" });
    }

    if (text.endsWith("start a helper")) {
        return call("subagent", { action: "spawn", name: "helper", message: "hello helper" });
    }

    if (text.endsWith("helper, write")) {
        return call("write", { path: "helper.txt", content: "x" });
    }

    return fauxAssistantMessage([fauxText(`echo: ${text}`)]);
};

let app: App;

before(async () => {
    app = await openApp(scriptedModel(route));
});

after(async () => {
    await app?.close();
    cleanUp();
});

test("a session in plan mode is told so, cannot write, still reads, and approving the plan turns it off and says go", async () => {
    const id = await newSession(app);

    await app.commands.setPlan(id, owner(app), true);
    await say(app, id, "make a plan");
    assert.equal(toldPlanMode, true, "the system prompt says plan mode is on");
    assert.equal(existsSync(join(work, "planned.txt")), false, "the write was blocked");
    const said = (await modelTexts(app, id)).join("\n");

    assert.match(said, /Plan mode is on: The write tool can change things/);
    assert.match(said, /plan: 1\. write the file/, "read-only bash ran and Pi answered");

    await app.commands.approvePlan(id, owner(app));
    assert.equal((await app.harness.snapshot(PlanDoc, id, context))?.on, false);
    const chat = (await app.harness.snapshot(ChatDoc, id, context))!.messages.map(
        (message) => message.text,
    );

    assert.deepEqual(chat, ["turned on plan mode", "approved the plan"]);
    await assert.rejects(app.commands.approvePlan(id, owner(app)), { status: 409 });
    await assert.rejects(app.commands.setPlan(id, owner(app), "yes"), { status: 400 });
    const viewer = app.config.addUser("Vee", "viewer").user;

    await assert.rejects(app.commands.setPlan(id, viewer, true), { status: 403 });
});

test("plan mode reaches the subagents already at work, and is set only for the whole session", async () => {
    const id = await newSession(app);

    await say(app, id, "start a helper");
    await until(
        async () =>
            (await modelTexts(app, id)).some((text) => text.includes("[subagent helper answered")),
        "the helper to report",
    );
    const helper = (await app.harness.snapshot(SubagentsDoc, id, context))!.agents.helper!
        .conversationId;

    await app.commands.setPlan(id, owner(app), true);
    assert.equal((await app.harness.snapshot(PlanDoc, helper, context))?.on, true);
    await assert.rejects(app.commands.setPlan(helper, owner(app), false), {
        status: 400,
        message: /whole session/,
    });

    await say(app, helper, "helper, write");
    assert.equal(existsSync(join(work, "helper.txt")), false, "the helper's write was blocked");
    assert.match(
        (await modelTexts(app, helper)).join("\n"),
        /Plan mode is on: The write tool can change things/,
    );
    await app.commands.approvePlan(id, owner(app));
    assert.equal(
        (await app.harness.snapshot(PlanDoc, helper, context))?.on,
        false,
        "approving lets the helper work again",
    );
});

test("plan mode cannot be turned on while its extension is off", async () => {
    const id = await newSession(app);

    await app.setExtensionEnabled(owner(app), "plan.ts", false);

    try {
        await assert.rejects(app.commands.setPlan(id, owner(app), true), {
            status: 409,
            message: /turned off in Extensions/,
        });
    } finally {
        await app.setExtensionEnabled(owner(app), "plan.ts", true);
    }

    await app.commands.setPlan(id, owner(app), true);
    assert.equal((await app.harness.snapshot(PlanDoc, id, context))?.on, true);
});
