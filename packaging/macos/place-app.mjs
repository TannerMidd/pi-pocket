// The macOS package's postinstall runs this with the package's own Node.js, to put the payload's app.new/ in place of
// app/ with two renames: no npm, no network. Usage: node place-app.mjs <installer version>
//
// A newer pi-pocket that the app already updated to stays. The exit code is not 0 when app/ does not hold pi-pocket
// <version> or newer at the end: the desktop app then refuses to start it. The output goes to install.log.
import {
    appendFileSync,
    existsSync,
    readFileSync,
    renameSync,
    rmSync,
    writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

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

export function versionIn(prefix) {
    const folder = join(prefix, "lib", "node_modules", "pi-pocket");

    try {
        if (!existsSync(join(folder, "bin", "pi-pocket.js"))) {
            return undefined;
        }

        return JSON.parse(readFileSync(join(folder, "package.json"), "utf8")).version;
    } catch {
        return undefined;
    }
}

export function placeApp(here, version, log) {
    const fresh = join(here, "app.new");
    const live = join(here, "app");
    const old = join(here, "app.old");
    const bundled = versionIn(fresh);
    const current = versionIn(live);

    if (current !== undefined && compareVersions(current, version) > 0) {
        log(`pi-pocket ${current} is newer than ${version}: it stays.`);
        rmSync(fresh, { recursive: true, force: true });
    } else if (bundled !== version) {
        log(`The package holds no pi-pocket ${version} in ${fresh} (${bundled ?? "none"}).`);
    } else {
        rmSync(old, { recursive: true, force: true });

        if (existsSync(live)) {
            renameSync(live, old);
        }

        try {
            renameSync(fresh, live);
        } catch (error) {
            if (existsSync(old) && !existsSync(live)) {
                renameSync(old, live);
            }

            throw error;
        }

        try {
            rmSync(old, { recursive: true, force: true });
        } catch (error) {
            log(`Could not delete ${old}: ${error instanceof Error ? error.message : error}`);
        }

        log(
            `Installed pi-pocket ${version}${current === undefined ? "" : ` in place of ${current}`}.`,
        );
    }

    const now = versionIn(live);

    if (now === undefined || compareVersions(now, version) < 0) {
        log(`${live} holds pi-pocket ${now ?? "none"}, not ${version} or newer.`);

        return 1;
    }

    return 0;
}

function main() {
    const here = dirname(fileURLToPath(import.meta.url));
    const logFile = join(here, "install.log");
    const [version] = process.argv.slice(2);
    const log = (line) => appendFileSync(logFile, `${line}\n`);

    writeFileSync(logFile, `Pi Pocket ${version}: ${new Date().toISOString()}\n`);

    if (!version) {
        log("Usage: node place-app.mjs <installer version>");

        return 2;
    }

    try {
        return placeApp(here, version, log);
    } catch (error) {
        log(
            `Could not put the app folder in place: ${error instanceof Error ? error.message : error}`,
        );

        return 1;
    }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
    process.exitCode = main();
}
