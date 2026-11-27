// Pocket's own git runs with no `GIT_*` variable that it was started with: a file that `GIT_CONFIG_GLOBAL` names can
// lie in a folder that a guest writes, and the sandbox audit of git's configuration does not read it.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { git } from "../src/server/git.ts";

const folder = realpathSync(mkdtempSync(join(tmpdir(), "pocket-git-env-")));
const config = join(folder, "host.cfg");

writeFileSync(config, "[pocket]\n\tmarker = from-the-file\n");
execFileSync("git", ["init", "-q", "-b", "main", folder], {
    env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null" },
});

after(() => rmSync(folder, { recursive: true, force: true }));

const VARIABLES: [string, Record<string, string>][] = [
    ["GIT_CONFIG_GLOBAL", { GIT_CONFIG_GLOBAL: config }],
    ["GIT_CONFIG_SYSTEM", { GIT_CONFIG_SYSTEM: config }],
    [
        "GIT_CONFIG_COUNT",
        { GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "pocket.marker", GIT_CONFIG_VALUE_0: "x" },
    ],
    ["GIT_CONFIG_PARAMETERS", { GIT_CONFIG_PARAMETERS: "'pocket.marker=x'" }],
];

for (const [name, variables] of VARIABLES) {
    test(`${name} does not reach Pocket's git, in a repository or outside one`, async () => {
        const saved = Object.fromEntries(
            Object.keys(variables).map((key) => [key, process.env[key]]),
        );

        Object.assign(process.env, variables);

        try {
            // `git config` itself would print the value: it is what the variable would have set.
            assert.equal(
                execFileSync("git", ["config", "--get", "pocket.marker"], { cwd: folder })
                    .toString()
                    .trim() !== "",
                true,
                "the variable has no effect here, so the test proves nothing",
            );

            for (const cwd of [folder, tmpdir()]) {
                assert.equal(
                    await git(cwd, ["config", "--get", "pocket.marker"], { allowExit: [1] }),
                    "",
                    cwd,
                );
            }
        } finally {
            for (const [key, value] of Object.entries(saved)) {
                if (value === undefined) {
                    delete process.env[key];
                } else {
                    process.env[key] = value;
                }
            }
        }
    });
}
