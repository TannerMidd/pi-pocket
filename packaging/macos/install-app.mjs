// The macOS package's postinstall runs this with the package's own Node.js, after the payload is in place: it installs
// the pi-pocket npm package into the private prefix beside this file (app/), so Menu → Update Pi Pocket can update it.
// It is packaging/windows/install-app.mjs with the Unix npm layout (lib/node_modules) and no shell.
//
//   node install-app.mjs <package spec> <installer version>
//
// The package spec is pi-pocket@<installer version>, or a tarball beside this file that the macOS CI job packs from its
// checkout (build.sh --package). A newer pi-pocket that the app already updated to stays: the installer does not take
// it back to an older one. The output goes to install.log beside this file. The exit code is not 0 when the package is
// not there at the end.
import { spawnSync } from "node:child_process";
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const prefix = join(here, "app");
const installed = join(prefix, "lib", "node_modules", "pi-pocket");
const logFile = join(here, "install.log");
const [spec, version] = process.argv.slice(2);

function log(line) {
    appendFileSync(logFile, `${line}\n`);
}

/** -1, 0, or 1, as SemVer orders the two versions; a pre-release comes before its release. */
export function compareVersions(a, b) {
    const parse = (text) => {
        const [core, pre] = String(text).split("+")[0].split(/-(.*)/s);

        return { core: core.split(".").map(Number), pre: pre === undefined ? [] : pre.split(".") };
    };

    const left = parse(a);
    const right = parse(b);

    for (let index = 0; index < 3; index++) {
        const difference = (left.core[index] || 0) - (right.core[index] || 0);

        if (difference !== 0) {
            return Math.sign(difference);
        }
    }

    if (left.pre.length === 0 || right.pre.length === 0) {
        return Math.sign(right.pre.length - left.pre.length);
    }

    for (let index = 0; index < Math.max(left.pre.length, right.pre.length); index++) {
        const x = left.pre[index];
        const y = right.pre[index];

        if (x === undefined || y === undefined) {
            return x === undefined ? -1 : 1;
        }

        const numeric = /^\d+$/.test(x) && /^\d+$/.test(y);
        const order = numeric ? Math.sign(Number(x) - Number(y)) : x < y ? -1 : x > y ? 1 : 0;

        if (order !== 0) {
            return order;
        }
    }

    return 0;
}

function installedVersion() {
    try {
        return JSON.parse(readFileSync(join(installed, "package.json"), "utf8")).version;
    } catch {
        return undefined;
    }
}

function main() {
    writeFileSync(logFile, `Pi Pocket ${version}: ${new Date().toISOString()}\n`);

    if (!spec || !version) {
        log("Usage: node install-app.mjs <package spec> <installer version>");

        return 2;
    }

    const current = installedVersion();

    if (
        current !== undefined &&
        compareVersions(current, version) > 0 &&
        spec.startsWith("pi-pocket@")
    ) {
        log(`pi-pocket ${current} is newer than ${version}: it stays.`);

        return 0;
    }

    // npm's own script with this Node.js, and no shell: the spec is one argument whatever it holds.
    const nodeBin = dirname(process.execPath);
    const npm = join(nodeBin, "..", "lib", "node_modules", "npm", "bin", "npm-cli.js");
    const args = [npm, "install", "--global", "--no-fund", "--no-audit", spec];

    log(`> ${process.execPath} ${args.join(" ")}`);
    const result = spawnSync(process.execPath, args, {
        cwd: here,
        encoding: "utf8",
        maxBuffer: 64 * 1024 * 1024,
        timeout: 15 * 60_000,
        env: {
            ...process.env,
            NPM_CONFIG_PREFIX: prefix,
            NPM_CONFIG_CACHE: join(here, "npm-cache"),
            NPM_CONFIG_UPDATE_NOTIFIER: "false",
            // The installer's scripts get a bare PATH: package scripts that npm runs need this Node.js on it.
            PATH: `${nodeBin}:${process.env.PATH ?? "/usr/bin:/bin:/usr/sbin:/sbin"}`,
        },
    });

    log(result.stdout ?? "");
    log(result.stderr ?? "");

    if (result.error !== undefined) {
        log(`npm did not run: ${result.error.message}`);
    }

    const bin = join(installed, "bin", "pi-pocket.js");

    if (result.status !== 0 || !existsSync(bin)) {
        log(
            `npm exited with ${result.status}; ${bin} ${existsSync(bin) ? "exists" : "is missing"}.`,
        );

        return 1;
    }

    log(`Installed pi-pocket ${installedVersion()}.`);

    return 0;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
    process.exitCode = main();
}
