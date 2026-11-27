// What Pi's loaders would read in a folder that a sandboxed session works in is read by the confined walk instead: a
// guest wrote it, so a link to a device, a file of any size, or a tree of any size costs the server nothing.
import assert from "node:assert/strict";
import fs, { mkdirSync, symlinkSync, truncateSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { join } from "node:path";
import { after, test } from "node:test";
import { onSandboxedFolders } from "../src/server/confined.ts";
import { loadPromptTemplates } from "../src/server/prompts.ts";
import { loadSessionSkills } from "../src/server/skills.ts";
import { cleanUp, root } from "./helpers.ts";

after(cleanUp);

const LINUX = process.platform === "linux" ? false : "the confined walk needs Linux";
const sources = {
    agentDir: join(root, "agent"),
    home: join(root, "home"),
    settingsPaths: [],
    defaultProjectTrust: "always",
} as const;

function skill(dir: string, name: string, description = "does a thing"): void {
    mkdirSync(dir, { recursive: true });
    writeFileSync(
        join(dir, "SKILL.md"),
        `---\nname: ${name}\ndescription: ${description}\n---\nBody\n`,
    );
}

/** Record what `readFileSync` is asked for under `.pi/skills`, and answer an ignore file as empty: never the file. */
function watchReads(): { read: string[]; restore: () => void } {
    const original = fs.readFileSync;
    const read: string[] = [];

    (fs as unknown as { readFileSync: unknown }).readFileSync = (...args: unknown[]) => {
        if (typeof args[0] === "string" && /\.gitignore$/.test(args[0])) {
            read.push(args[0]);

            return "";
        }

        return (original as (...call: unknown[]) => unknown)(...args);
    };

    syncBuiltinESMExports();

    return {
        read,
        restore: () => {
            (fs as unknown as { readFileSync: unknown }).readFileSync = original;
            syncBuiltinESMExports();
        },
    };
}

test(
    "skills of a sandboxed folder are found by the confined walk: no ignore file or link is read, and a big file is left out",
    { skip: LINUX },
    () => {
        const project = join(root, "loaders-skills");
        const skills = join(project, ".pi", "skills");

        skill(join(skills, "plain"), "plain");
        skill(join(skills, "big"), "big");
        skill(join(skills, "linked-target"), "linked-target");
        // An unbounded read for a loader that follows links, and a file larger than a skill may be.
        symlinkSync("/dev/zero", join(skills, ".gitignore"));
        truncateSync(join(skills, "big", "SKILL.md"), 3 * 1024 * 1024);
        symlinkSync(join(skills, "linked-target", "SKILL.md"), join(skills, "plain", "other.md"));
        const stop = onSandboxedFolders(() => [project]);
        const watching = watchReads();

        try {
            const found = loadSessionSkills(project, sources)
                .map((each) => each.name)
                .sort();

            assert.deepEqual(found, ["linked-target", "plain"]);
            assert.deepEqual(watching.read, [], "an ignore file was read");
        } finally {
            watching.restore();
            stop();
        }
    },
);

test("in a folder that no sandboxed session uses, Pi's own loader reads skills as before", () => {
    const project = join(root, "loaders-ordinary");

    skill(join(project, ".pi", "skills", "plain"), "plain");
    writeFileSync(join(project, ".pi", "skills", ".gitignore"), "plain\n");

    assert.deepEqual(loadSessionSkills(project, sources), []);
    // `.gitignore` is applied by Pi there: the skill is ignored.
    skill(join(project, ".pi", "skills", "other"), "other");
    assert.deepEqual(
        loadSessionSkills(project, sources).map((each) => each.name),
        ["other"],
    );
});

test(
    "prompt templates of a sandboxed folder: only regular files of a limited size, no links",
    { skip: LINUX },
    () => {
        const project = join(root, "loaders-prompts");
        const prompts = join(project, ".pi", "prompts");

        mkdirSync(prompts, { recursive: true });
        writeFileSync(join(prompts, "fine.md"), "Fine $1");
        writeFileSync(join(prompts, "huge.md"), "x");
        truncateSync(join(prompts, "huge.md"), 3 * 1024 * 1024);
        symlinkSync("/dev/zero", join(prompts, "zero.md"));
        const stop = onSandboxedFolders(() => [project]);

        try {
            assert.deepEqual(
                loadPromptTemplates(project, join(root, "agent"), []).map((each) => each.name),
                ["fine"],
            );
        } finally {
            stop();
        }
    },
);
