/** Identify npm installs without treating a local project's hoisted packages or an npx cache as a global install. */
import { execFile } from "node:child_process";
import { constants, existsSync } from "node:fs";
import { access, realpath } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import { updatePaths } from "./update-state.ts";

export type InstallKind = "git" | "npm-global" | "npm-local" | "npx" | "unknown";

/** Use the npm beside the Node.js that runs Pi Pocket, else the one on PATH. */
export function npmCommand(): { file: string; shell: boolean } {
    const windows = process.platform === "win32";
    const beside = join(dirname(process.execPath), windows ? "npm.cmd" : "npm");

    return { file: existsSync(beside) ? beside : windows ? "npm.cmd" : "npm", shell: windows };
}

/** The global package folder for this Node.js, not another npm on PATH. */
export function globalNpmRoot(): Promise<string> {
    const { file, shell } = npmCommand();

    return new Promise((done, fail) => {
        execFile(
            shell ? `"${file}"` : file,
            ["root", "-g"],
            {
                encoding: "utf8",
                shell,
                timeout: 20_000,
                maxBuffer: 1024 * 1024,
                env: { ...process.env, npm_config_update_notifier: "false" },
            },
            (error, stdout) => {
                if (error !== null) {
                    fail(error);

                    return;
                }

                done(stdout.trim());
            },
        );
    });
}

/** Git detection belongs to Updates. Only an exact global root match permits a package swap. */
export async function npmInstallKind(appRoot: string): Promise<InstallKind> {
    const root = await realpath(appRoot).catch(() => resolve(appRoot));
    const parts = [...resolve(appRoot).split(sep), ...root.split(sep)];

    if (parts.includes("_npx") && parts.includes("node_modules")) {
        return "npx";
    }

    const global = await globalNpmRoot()
        .then((path) => realpath(path))
        .catch(() => undefined);
    const parent = await realpath(dirname(root)).catch(() => dirname(root));

    if (global !== undefined && parent === global) {
        return "npm-global";
    }

    return parts.includes("node_modules") ? "npm-local" : "unknown";
}

/**
 * Both renames need the parent, and an install owned by another user must not be replaced. The update's state folder
 * beside the package must take its files too, when an earlier update left it.
 */
export async function npmWritable(appRoot: string): Promise<boolean> {
    const state = updatePaths(appRoot).dir;

    return Promise.all([
        access(appRoot, constants.W_OK),
        access(dirname(appRoot), constants.W_OK),
        ...(existsSync(state) ? [access(state, constants.W_OK)] : []),
    ]).then(
        () => true,
        () => false,
    );
}
