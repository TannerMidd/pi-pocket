/** Install a release in an isolated global prefix while the live npm package keeps running. */
import { spawn } from "node:child_process";
import { mkdir, readFile, rm } from "node:fs/promises";
import { npmCommand } from "./npm-install.ts";
import { readPending, stagedPackagePath, updatePaths } from "./update-state.ts";

export type NpmStageOptions = {
    /** An explicit local tarball for offline tests. Production uses the exact registry version. */
    spec?: string;
    env?: NodeJS.ProcessEnv;
};

/** Pending state must be durable before npm can write anything in staging. */
export async function stageNpmUpdate(
    appRoot: string,
    version: string,
    options: NpmStageOptions = {},
): Promise<void> {
    const pending = readPending(appRoot);

    if (
        pending?.kind !== "npm-global" ||
        pending.toVersion !== version ||
        pending.phase !== "packages" ||
        pending.modules
    ) {
        throw new Error("Write an npm global pending update before staging its exact version.");
    }

    if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(version)) {
        throw new Error("An npm update needs an exact version.");
    }

    const { staging } = updatePaths(appRoot);
    const command = npmCommand();

    await rm(staging, { recursive: true, force: true });
    await mkdir(staging, { recursive: true });

    try {
        await new Promise<void>((resolve, reject) => {
            const args = [
                "install",
                "--global",
                "--prefix",
                staging,
                "--no-audit",
                "--no-fund",
                "--",
                options.spec ?? `pi-pocket@${version}`,
            ];
            const child = spawn(
                command.shell ? `"${command.file}"` : command.file,
                command.shell ? args.map((arg) => `"${arg}"`) : args,
                {
                    shell: command.shell,
                    timeout: 20 * 60_000,
                    cwd: staging,
                    env: {
                        ...process.env,
                        ...options.env,
                        npm_config_update_notifier: "false",
                        npm_config_fund: "false",
                    },
                    stdio: ["ignore", "pipe", "pipe"],
                },
            );
            let output = "";

            const collect = (chunk: Buffer) => {
                output = (output + chunk.toString()).slice(-16_384);
            };

            child.stdout.on("data", collect);
            child.stderr.on("data", collect);
            child.once("error", reject);
            child.once("close", (code) => {
                if (code === 0) {
                    resolve();
                } else {
                    reject(new Error(`npm staging failed (${code}): ${output.trim()}`));
                }
            });
        });
        const manifest = JSON.parse(
            await readFile(`${stagedPackagePath(appRoot)}/package.json`, "utf8"),
        ) as { name?: unknown; version?: unknown };

        if (manifest.name !== "pi-pocket" || manifest.version !== version) {
            throw new Error(
                "The staged npm package does not match the requested name and version.",
            );
        }
    } catch (error) {
        // No live files moved. Keep the pending record until the caller records the outcome.
        await rm(staging, { recursive: true, force: true });

        throw error;
    }
}
