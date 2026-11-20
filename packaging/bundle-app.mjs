// Makes the app folder that the Windows and macOS installers ship: the pi-pocket package of a checkout, with its
// production dependencies, in a private npm prefix. build.ps1 and build.sh run it on the release runner with the
// installer's own Node.js and its npm, so the installer needs no npm when it runs, and Menu → Update Pi Pocket finds the
// same prefix layout as after `npm install --global`.
//
//   node bundle-app.mjs <checkout> <prefix> <version>
//
// It packs the checkout (npm pack, whose prepack script puts npm-shrinkwrap.json in, as for the npm release), installs
// that tarball globally into the prefix without install scripts, and checks the result: the version, the start script,
// the shrinkwrap, and no package for one platform only. The tree must be the same on every platform: the macOS package
// is one for both kinds of Mac.
import { spawnSync } from "node:child_process";
import { existsSync, lstatSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** The folder of the pi-pocket package in an npm prefix, in npm's layout for the platform. */
export function packageFolder(prefix, platform = process.platform) {
    return platform === "win32"
        ? join(prefix, "node_modules", "pi-pocket")
        : join(prefix, "lib", "node_modules", "pi-pocket");
}

/** What is wrong with the app folder in prefix for pi-pocket <version>: an empty list when nothing is. */
export function checkApp(prefix, version, platform = process.platform) {
    const folder = packageFolder(prefix, platform);
    const problems = [];
    let manifest;

    try {
        manifest = JSON.parse(readFileSync(join(folder, "package.json"), "utf8"));
    } catch {
        return [`${folder} holds no package.json`];
    }

    if (manifest.version !== version) {
        problems.push(`pi-pocket is version ${manifest.version}, not ${version}`);
    }

    if (!existsSync(join(folder, "bin", "pi-pocket.js"))) {
        problems.push(`${join(folder, "bin", "pi-pocket.js")} is missing`);
    }

    const shim =
        platform === "win32" ? join(prefix, "pi-pocket.cmd") : join(prefix, "bin", "pi-pocket");

    try {
        lstatSync(shim);
    } catch {
        problems.push(`npm made no ${shim}`);
    }

    let shrinkwrap;

    try {
        shrinkwrap = JSON.parse(readFileSync(join(folder, "npm-shrinkwrap.json"), "utf8"));
    } catch {
        problems.push(
            "the package has no npm-shrinkwrap.json: its dependencies are not the npm release's",
        );

        return problems;
    }

    for (const [path, entry] of Object.entries(shrinkwrap.packages ?? {})) {
        if (
            path !== "" &&
            entry.dev !== true &&
            (entry.os !== undefined || entry.cpu !== undefined)
        ) {
            problems.push(
                `${path} is for one platform only: build the app folder for each platform`,
            );
        }
    }

    return problems;
}

/** The number of files and their bytes in a folder. Links count as files. */
export function measure(folder) {
    let files = 0;
    let bytes = 0;

    for (const entry of readdirSync(folder, { withFileTypes: true, recursive: true })) {
        if (!entry.isDirectory()) {
            files++;
            bytes += lstatSync(join(entry.parentPath, entry.name)).size;
        }
    }

    return { files, bytes };
}

function npm(args, cwd, env) {
    const bin = dirname(process.execPath);
    const cli =
        process.platform === "win32"
            ? join(bin, "node_modules", "npm", "bin", "npm-cli.js")
            : join(bin, "..", "lib", "node_modules", "npm", "bin", "npm-cli.js");
    const merged = { ...process.env, ...env };
    // This Node.js first on PATH, for the package's prepack script. Windows spells the name in any case.
    const pathKey = Object.keys(merged).find((key) => key.toUpperCase() === "PATH") ?? "PATH";

    merged[pathKey] = `${bin}${process.platform === "win32" ? ";" : ":"}${merged[pathKey] ?? ""}`;
    console.log(`> npm ${args.join(" ")}`);
    const result = spawnSync(process.execPath, [cli, ...args], {
        cwd,
        env: merged,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "inherit"],
        maxBuffer: 64 * 1024 * 1024,
        timeout: 15 * 60_000,
    });

    if (result.status !== 0) {
        throw new Error(
            `npm ${args[0]} exited with ${result.status ?? result.error?.message}\n${result.stdout}`,
        );
    }

    return result.stdout;
}

function main() {
    const [checkout, prefixArgument, version] = process.argv.slice(2);

    if (!checkout || !prefixArgument || !version) {
        console.error("Usage: node bundle-app.mjs <checkout> <prefix> <version>");

        return 2;
    }

    const prefix = resolve(prefixArgument);
    const work = mkdtempSync(join(tmpdir(), "pi-pocket-bundle-"));

    try {
        const env = {
            NPM_CONFIG_CACHE: join(work, "npm-cache"),
            NPM_CONFIG_UPDATE_NOTIFIER: "false",
            NPM_CONFIG_FUND: "false",
            NPM_CONFIG_AUDIT: "false",
        };
        const packed = JSON.parse(
            npm(["pack", "--json", "--pack-destination", work], resolve(checkout), env),
        );
        const tarball = join(work, packed[0].filename);

        rmSync(prefix, { recursive: true, force: true });
        npm(["install", "--global", "--omit=dev", "--ignore-scripts", tarball], work, {
            ...env,
            NPM_CONFIG_PREFIX: prefix,
        });
        const problems = checkApp(prefix, version);

        if (problems.length > 0) {
            console.error(`The app folder ${prefix} is wrong:\n- ${problems.join("\n- ")}`);

            return 1;
        }

        const { files, bytes } = measure(prefix);

        console.log(
            `Bundled pi-pocket ${version} in ${prefix}: ${files} files, ${(bytes / 1024 / 1024).toFixed(1)} MB.`,
        );

        return 0;
    } finally {
        rmSync(work, { recursive: true, force: true });
    }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
    process.exitCode = main();
}
