// Source tests that keep the sandbox's structure closed (design 2.3, 2.2 I6, 4.1): every direct `.submit(` on a
// conversation goes through `deliver.ts`, every place that makes a conversation passes admission, one module writes a
// session's folders and archive flag, and the provider API is not public. They read the code, not behaviour.
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { test } from "node:test";

const server = join(import.meta.dirname, "..", "src", "server");

function files(dir: string): string[] {
    return readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
        entry.isDirectory()
            ? files(join(dir, entry.name))
            : /\.ts$/.test(entry.name)
              ? [join(dir, entry.name)]
              : [],
    );
}

/** A file's code with comments taken out, so a word in a comment never counts. */
function code(file: string): string {
    return readFileSync(file, "utf8")
        .replace(/\/\*[\s\S]*?\*\//g, (match) => match.replace(/[^\n]/g, " "))
        .replace(/(^|[^:"'`\\])\/\/.*$/gm, "$1");
}

const all = files(server).map((file) => ({ name: relative(server, file), text: code(file) }));

test("every direct `.submit(` on a conversation is in deliver.ts; the rest are calls of Commands, which deliver", () => {
    const found: string[] = [];

    for (const { name, text } of all) {
        for (const match of text.matchAll(/([\w#.$?!()]*?)\.submit\(/g)) {
            found.push(`${name}: ${match[1]}`);
        }
    }

    const outside = found.filter((line) => !line.startsWith("deliver.ts:"));
    const unknown = outside.filter(
        (line) => !/(commands|turnNotes|this)$/.test(line.split(": ")[1]!),
    );

    assert.deepEqual(unknown, [], "a conversation that is submitted to outside deliver.ts");
    // The calls of Commands and TurnNotes are the ones that deliver: they are listed so a new one is looked at.
    assert.deepEqual(
        outside.map((line) => line.split(": ")[0]).sort(),
        [
            "commands.ts",
            "commands.ts",
            "extension-sessions.ts",
            "http/conversation-routes.ts",
            "inbox.ts",
            "linked-sessions.ts",
            "pip.ts",
            "repo-watches.ts",
            "watches.ts",
        ].sort(),
    );
});

test("every place that makes a conversation passes admission in the same commit", () => {
    const makers = all.filter(({ text }) => /\bcreateConversation\(|\.fork\(at as /.test(text));

    assert.deepEqual(makers.map(({ name }) => name).sort(), [
        "commands.ts",
        "extensions/subagents.ts",
        "linked-sessions.ts",
        "pip.ts",
    ]);

    for (const { name, text } of makers) {
        assert.match(
            text,
            name === "extensions/subagents.ts"
                ? /admitChild\(/
                : /sandboxes\.admit\(tx, \{\s*kind: "join"/,
            `${name} makes a conversation without admission`,
        );
    }
});

test("one module writes the folders of a session and its archive flag, and both folders in one commit (I6)", () => {
    const writers: string[] = [];

    for (const { name, text } of all) {
        if (name === "sandbox.ts") {
            continue;
        }

        const patterns = [
            /\b(meta|session|entry|item)\.(archived|cwd)\s*=[^=]/,
            /\bitems\[String\([^)]*\)\]\s*=\s*\{[^}]*\bcwd\b/,
            /delete\s+\(?await tx\.doc\(SessionsDoc\)\)?\.items\[/,
            /delete\s+sessions\.items\[/,
            /\bconfigure\(\s*tx,\s*[\w.]+,\s*\{[^}]*\bcwd\b/,
            /\.configure\(\{[^}]*\bcwd\b/,
        ];

        if (
            patterns.some((pattern) => pattern.test(text)) &&
            /SessionsDoc|configure\(/.test(text)
        ) {
            writers.push(name);
        }
    }

    assert.deepEqual(
        writers,
        [],
        "a file other than sandbox.ts writes a session's folder, flag, or entry",
    );
    const own = all.find(({ name }) => name === "sandbox.ts")!.text;

    // The move writes the entry's folder and every conversation's own in the one admission.
    assert.match(own, /meta\.cwd = target\.cwd/);
    assert.match(own, /configure\(tx, move\.id, \{ cwd: move\.cwd \}\)/);
    assert.match(own, /meta\.archived = true/);
    assert.match(own, /meta\.archived = false/);
});

test("a join writes the entry and the agent's folder together, and an agent's folder is never written alone", () => {
    const own = all.find(({ name }) => name === "sandbox.ts")!.text;

    assert.match(own, /sessions\.items\[String\(id\)\] = request\.entry;/);
    assert.match(own, /configure\(tx, request\.id, \{ cwd \}\)/);
});

test("the provider API is not public: not on the host, in the public types, or in the docs", () => {
    const host = readFileSync(join(server, "host.ts"), "utf8");
    const types = readFileSync(join(server, "..", "..", "types", "pocket.d.ts"), "utf8");

    assert.doesNotMatch(host, /readonly sandbox\b|\bsandbox:\s*\{|SandboxProvider/);
    assert.doesNotMatch(types, /sandbox/i);
});

test("every release, stop, provider install, and provider removal is a known call site, each one under a check of its owner", () => {
    // Each runs in the tick of a check (owner token and generation, a revision, or the identity of the provider read in the same
    // tick); a new call site must be added here, with the check it relies on, after the same audit.
    const text = all.find((file) => file.name === "sandbox.ts")!.text;
    const lines = text.split("\n");
    const found: string[] = [];
    let method = "";

    for (const line of lines) {
        const head = /^ {4}(?:async |readonly |get )?(#?\w+)[<(]/.exec(line);

        if (head !== null && !/^(if|for|while|switch|catch|return)$/.test(head[1]!)) {
            method = head[1]!;
        }

        for (const match of line.matchAll(
            /this\.#(release|stop|install)\(|this\.#provider = (\w+)/g,
        )) {
            found.push(`${method}: ${match[0]}`);
        }
    }

    assert.deepEqual(
        found.sort(),
        [
            // register: a provider read in the same tick (`old`), the load and the identity checked before the install.
            "register: this.#install(",
            "register: this.#stop(",
            "register: this.#stop(",
            // #install: the provider switch itself.
            "#install: this.#provider = mine",
            // #stop: the removal of a provider, after its proof.
            "#stop: this.#provider = undefined",
            "#stop: this.#release(",
            // #change, turn-off, resume, proof, rules: owner token and generation or revision just before.
            "#change: this.#release(",
            "#proof: this.#release(",
            "#turnOff: this.#release(",
            "#resume: this.#release(",
            "rules: this.#release(",
            // suspendOwner and shutdown: the provider read in the same tick; the shutdown fence is permanent.
            "suspendOwner: this.#stop(",
            "shutdown: this.#stop(",
            // reloadCommitted: the reload record, the provider it stopped, and its generation, checked in the same tick.
            "reloadCommitted: this.#install(",
        ].sort(),
    );
});
