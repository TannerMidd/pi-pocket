// The Windows installer runs this with its own Node.js, after it copies the files: it installs the pi-pocket npm
// package into the private prefix beside this file (app\), so Menu → Update Pi Pocket can update it later.
//
//   node install-app.mjs <package spec> <installer version>
//
// The package spec is pi-pocket@<installer version>, or a tarball that the Windows CI job packs from its checkout.
// A newer pi-pocket that the app already updated to stays: the installer does not take it back to an older one.
// The output goes to install.log beside this file. The exit code is not 0 when the package is not there at the end.
import { spawnSync } from "node:child_process";
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const prefix = join(here, "app");
const installed = join(prefix, "node_modules", "pi-pocket");
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

    // npm.cmd needs a shell (Node refuses to start a .cmd file without one), so every argument is quoted.
    const npm = join(dirname(process.execPath), "npm.cmd");
    const command = `"${npm}" install --global --no-fund --no-audit "${spec}"`;

    log(`> ${command}`);
    const result = spawnSync(command, {
        shell: true,
        windowsHide: true,
        encoding: "utf8",
        maxBuffer: 64 * 1024 * 1024,
        timeout: 15 * 60_000,
        env: {
            ...process.env,
            NPM_CONFIG_PREFIX: prefix,
            NPM_CONFIG_CACHE: join(here, "npm-cache"),
            NPM_CONFIG_UPDATE_NOTIFIER: "false",
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
