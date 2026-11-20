// A drop-in folder where the system refuses links, as some enterprise policies do: Pi Pocket makes it without them, and
// an editor still finds Pi Pocket's packages and their types there.
import { cleanUp, root } from "./helpers.ts";
import assert from "node:assert/strict";
import fs, { existsSync, readFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { join } from "node:path";
import { after, mock, test } from "node:test";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { modulesWith } from "../src/server/config.ts";
import { writeDropInConfig } from "../src/server/dropin-config.ts";
import { linkTypes, prepareDropInFolder } from "../src/server/reload.ts";

after(cleanUp);

const app = fileURLToPath(new URL("..", import.meta.url));
const dropIn = join(root, "extensions");
const manifest = JSON.parse(readFileSync(join(app, "package.json"), "utf8")) as {
    dependencies: Record<string, string>;
};
const packageModules = Object.fromEntries(
    Object.keys(manifest.dependencies).map((name) => [name, modulesWith(name, app)]),
);

test("a link the system refuses leaves the drop-in folder without it, and says why once", () => {
    const refused = Object.assign(new Error("EPERM: operation not permitted, symlink"), {
        code: "EPERM",
    });

    mock.method(fs, "symlinkSync", () => {
        throw refused;
    });
    syncBuiltinESMExports();

    try {
        assert.equal(
            prepareDropInFolder(dropIn, join(app, "node_modules"), packageModules),
            refused,
        );
        linkTypes(dropIn, join(app, "types", "pocket.d.ts"));
    } finally {
        mock.restoreAll();
        syncBuiltinESMExports();
    }

    assert.ok(!existsSync(join(dropIn, "node_modules")));
    assert.match(readFileSync(join(dropIn, "_pocket.d.ts"), "utf8"), /^\/\/ A copy of Pi Pocket/);
});

test("with no link, TypeScript finds Pi Pocket's packages and types from the drop-in folder", () => {
    writeDropInConfig(dropIn, packageModules);

    const probe = join(dropIn, "probe.ts");

    fs.writeFileSync(
        probe,
        `import type { Host } from "./_pocket.d.ts";
import type { ExecutionEnv } from "@earendil-works/pi-durable/env";
import { McpClient } from "@earendil-works/pi-mcp";
import { useState } from "preact/hooks";
import { readFileSync } from "node:fs";

const count: number = useState(1)[0];
// Node runs drop-ins as ES modules: TypeScript must read them so.
const here: string = await Promise.resolve(import.meta.url);

export type Probe = [Host, ExecutionEnv, typeof McpClient, typeof readFileSync, typeof count, typeof here];
`,
    );

    const config = ts.getParsedCommandLineOfConfigFile(
        join(dropIn, "tsconfig.json"),
        // The types copy is a declaration file: checked too, as a name that does not resolve there reads as `any`.
        { skipLibCheck: false },
        { ...ts.sys, onUnRecoverableConfigFileDiagnostic: () => {} },
    );

    assert.ok(config !== undefined);
    assert.deepEqual(config.errors, []);

    const program = ts.createProgram([probe, join(dropIn, "_pocket.d.ts")], config.options);
    const problems = [probe, join(dropIn, "_pocket.d.ts")].flatMap((file) =>
        ts
            .getPreEmitDiagnostics(program, program.getSourceFile(file))
            .filter((each) => each.file?.fileName === program.getSourceFile(file)?.fileName)
            .map((each) => ts.flattenDiagnosticMessageText(each.messageText, "\n")),
    );

    assert.deepEqual(problems, []);

    // The owner's own file stays as it is.
    fs.writeFileSync(join(dropIn, "tsconfig.json"), "{}\n");
    writeDropInConfig(dropIn, packageModules);
    assert.equal(readFileSync(join(dropIn, "tsconfig.json"), "utf8"), "{}\n");
});
