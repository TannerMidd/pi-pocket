/**
 * Pi's loaders read the paths they are given, so a sandboxed folder is loaded from a snapshot made through the confined
 * walk (`snapshots.ts`), and Pi's own loader runs on the copy. A plain folder is loaded in place, as it always was.
 */
import assert from "node:assert/strict";
import {
    mkdirSync,
    mkdtempSync,
    readdirSync,
    rmSync,
    statSync,
    symlinkSync,
    writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Hostfs } from "../src/server/hostfs.ts";
import { expandSkillCommand, loadPromptTemplates } from "../src/server/prompts.ts";
import { loadSessionSkills, type SkillSources } from "../src/server/skills.ts";
import { Snapshots } from "../src/server/snapshots.ts";

const linux = process.platform === "linux";

function lab(t: { after: (fn: () => void) => void }) {
    const base = mkdtempSync(join(tmpdir(), "pocket-loaders-"));
    const root = join(base, "project");
    const agentDir = join(base, "agent");
    const home = join(base, "home");
    const secret = join(base, "id_rsa");

    t.after(() => rmSync(base, { recursive: true, force: true }));
    mkdirSync(join(root, ".pi", "skills", "careful"), { recursive: true });
    mkdirSync(join(root, ".pi", "prompts"), { recursive: true });
    mkdirSync(join(root, "sub"), { recursive: true });
    mkdirSync(agentDir);
    mkdirSync(home);
    writeFileSync(secret, "PRIVATE KEY");
    writeFileSync(
        join(root, ".pi", "skills", "careful", "SKILL.md"),
        "---\nname: careful\ndescription: Be careful.\n---\nTake care.\n",
    );
    writeFileSync(
        join(root, ".pi", "prompts", "review.md"),
        "---\ndescription: Review\n---\nReview $1\n",
    );
    writeFileSync(join(root, "AGENTS.md"), "Project rules.\n");
    writeFileSync(join(base, "AGENTS.md"), "Rules above the project.\n");

    const info = statSync(root, { bigint: true });
    const sandboxed = new Hostfs({
        sandboxedFolders: () => [{ path: root, dev: info.dev, ino: info.ino }],
    });
    const plain = new Hostfs();
    const sources = (host: Hostfs): SkillSources => ({
        host,
        snapshots: new Snapshots(host, join(base, "data", "snapshots")),
        agentDir,
        home,
        settingsPaths: [],
        defaultProjectTrust: "always",
    });

    return { base, root, agentDir, secret, sandboxed, plain, sources };
}

test(
    "a sandboxed folder's skills come from a snapshot, with the same answer as Pi's loader on the folder",
    { skip: !linux },
    (t) => {
        const { root, sandboxed, plain, sources } = lab(t);
        const mine = loadSessionSkills(root, sources(sandboxed));
        const theirs = loadSessionSkills(root, sources(plain));

        assert.deepEqual(
            mine.map(({ name, description, filePath, baseDir }) => ({
                name,
                description,
                filePath,
                baseDir,
            })),
            theirs.map(({ name, description, filePath, baseDir }) => ({
                name,
                description,
                filePath,
                baseDir,
            })),
        );
        assert.equal(mine[0]!.filePath, join(root, ".pi", "skills", "careful", "SKILL.md"));
        assert.equal(mine[0]!.sourceInfo.path.startsWith(root), true, "no path of the copy shows");
    },
);

test(
    "a skills folder whose .gitignore is /dev/zero, and a skill that is a link, load nothing from them and do not hang",
    { skip: !linux, timeout: 30_000 },
    (t) => {
        const { root, secret, sandboxed, sources } = lab(t);

        symlinkSync("/dev/zero", join(root, ".pi", "skills", ".gitignore"));
        mkdirSync(join(root, ".pi", "skills", "stolen"));
        symlinkSync(secret, join(root, ".pi", "skills", "stolen", "SKILL.md"));

        const names = loadSessionSkills(root, sources(sandboxed)).map((skill) => skill.name);

        assert.deepEqual(names, ["careful"]);
    },
);

test(
    "AGENTS.md that is a link to a secret is not read for a sandboxed folder, and is for a plain one",
    { skip: !linux },
    (t) => {
        const { root, secret, sandboxed, plain, sources, agentDir } = lab(t);

        rmSync(join(root, "AGENTS.md"));
        symlinkSync(secret, join(root, "AGENTS.md"));

        const shut = new Snapshots(sandboxed, join(root, "..", "data", "snapshots"));
        const found = shut.contextFiles(root, agentDir).map((file) => file.content);

        assert.equal(
            found.some((text) => text.includes("PRIVATE KEY")),
            false,
        );
        assert.deepEqual(
            found,
            ["Rules above the project.\n"],
            "the folder above is the owner's, and is read",
        );

        // A plain folder behaves as before: a shared AGENTS.md that is a link works.
        const open = new Snapshots(plain, join(root, "..", "data", "snapshots"));

        assert.equal(
            open.contextFiles(root, agentDir).some((file) => file.content.includes("PRIVATE KEY")),
            true,
        );
        assert.ok(sources(plain));
    },
);

test(
    "context files of a sandboxed folder map to the folder's own paths and leave no copy behind",
    { skip: !linux },
    (t) => {
        const { base, root, sandboxed, agentDir } = lab(t);
        const store = join(base, "data", "snapshots");
        const files = new Snapshots(sandboxed, store).contextFiles(join(root, "sub"), agentDir);

        assert.deepEqual(
            files.map((file) => file.path),
            [join(base, "AGENTS.md"), join(root, "AGENTS.md")],
        );
        assert.equal(statSync(store).isDirectory(), true);
        assert.deepEqual(readdirNames(store), []);
    },
);

function readdirNames(path: string): string[] {
    return readdirSync(path);
}

test(
    "prompt templates and /skill expansion refuse a link in a sandboxed folder",
    { skip: !linux },
    (t) => {
        const { root, secret, sandboxed, plain, agentDir, sources } = lab(t);

        symlinkSync(secret, join(root, ".pi", "prompts", "leak.md"));

        const mine = loadPromptTemplates(sandboxed, root, agentDir, []);
        const theirs = loadPromptTemplates(plain, root, agentDir, []);

        assert.deepEqual(
            mine.map((each) => each.name),
            ["review"],
        );
        assert.deepEqual(
            theirs.map((each) => each.name).sort(),
            ["leak", "review"],
            "plain: as before",
        );

        const [skill] = loadSessionSkills(root, sources(sandboxed));
        const command = {
            name: skill!.name,
            description: skill!.description,
            path: skill!.filePath,
            baseDir: skill!.baseDir,
        };

        assert.match(
            expandSkillCommand(sandboxed, "/skill:careful go", [command]) ?? "",
            /Take care\./,
        );
        rmSync(skill!.filePath);
        symlinkSync(secret, skill!.filePath);
        assert.equal(expandSkillCommand(sandboxed, "/skill:careful go", [command]), undefined);
        assert.match(
            expandSkillCommand(plain, "/skill:careful go", [command]) ?? "",
            /PRIVATE KEY/,
        );
    },
);
