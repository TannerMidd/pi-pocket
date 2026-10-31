// A loaded system is kept while the revision of its folder stays the same. The revision is read on every call, so an edit by any program shows at once.
// A file changed in the last 3 seconds is not trusted: two writes in one tick of the file system's clock (2 s on FAT) get the same time.
import { createHash } from "node:crypto";
import { lstatSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { LIMITS } from "./tokens-base.ts";
import type { DesignSystem } from "./system-types.ts";

const ENTRIES = 8;
const BUDGET = 48_000_000;
const RACY_NS = 3_000_000_000n;

interface Entry {
    revision: string;
    system: DesignSystem;
    weight: number;
}

const kept = new Map<string, Entry>();
const loaded = new WeakSet<DesignSystem>();
const memos = new WeakMap<DesignSystem, Map<string, string>>();

const TOKEN_FILE = /^tokens(?:\..+)?\.json$/;

function statOf(path: string) {
    try {
        return lstatSync(path, { bigint: true });
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
            return undefined;
        }

        throw error;
    }
}

/** The revision of `.pi/design` as the read sees it, or undefined when it cannot be trusted (or there is no folder). */
function folderRevision(cwd: string): string | undefined {
    const hash = createHash("sha256");
    const now = BigInt(Date.now()) * 1_000_000n;
    let racy = false;

    const add = (label: string, path: string, directory: boolean) => {
        const stat = statOf(path);

        if (stat === undefined) {
            hash.update(`${label}\0-\n`);

            return false;
        }

        if (!directory && (stat.mtimeNs > now - RACY_NS || stat.ctimeNs > now - RACY_NS)) {
            racy = true;
        }

        hash.update(
            `${label}\0${stat.mode}\0${stat.ino}\0${stat.dev}\0${directory ? "" : `${stat.size}\0${stat.mtimeNs}\0${stat.ctimeNs}`}\n`,
        );

        return stat.isDirectory();
    };

    const root = join(cwd, ".pi", "design");

    if (!add(".pi", join(cwd, ".pi"), true) || !add("design", root, true)) {
        return undefined;
    }

    const names = readdirSync(root);

    hash.update(`${names.join("\0")}\n`);

    for (const name of names.slice(0, 500)) {
        if (name.startsWith(".")) {
            continue;
        }

        if (TOKEN_FILE.test(name) || name === "guidelines.md") {
            add(name, join(root, name), false);
        } else if (name === "components" && add(name, join(root, name), true)) {
            const files = readdirSync(join(root, name));

            hash.update(`${files.join("\0")}\n`);

            for (const file of files
                .filter((each) => each.endsWith(".html") && !each.startsWith("."))
                .sort()
                .slice(0, LIMITS.components + 1)) {
                add(`components/${file}`, join(root, name, file), false);
            }
        }
    }

    return racy ? undefined : hash.digest("base64");
}

function freeze(value: unknown): void {
    if (typeof value === "object" && value !== null && !Object.isFrozen(value)) {
        Object.freeze(value);

        for (const key of Object.keys(value)) {
            freeze((value as Record<string, unknown>)[key]);
        }
    }
}

function weightOf(system: DesignSystem): number {
    const { modes, ...files } = system.compiled;
    let weight = 0;

    for (const text of [...Object.values(files), ...Object.values(modes ?? {})]) {
        weight += typeof text === "string" ? text.length : 0;
    }

    return weight;
}

/** The system of `cwd`, frozen: callers share one object, so none may change it. */
export function cachedSystem(
    cwd: string,
    load: () => DesignSystem | undefined,
): DesignSystem | undefined {
    let revision: string | undefined;

    try {
        revision = folderRevision(cwd);
    } catch {
        revision = undefined;
    }

    const found = kept.get(cwd);

    if (revision !== undefined && found?.revision === revision) {
        kept.delete(cwd);
        kept.set(cwd, found);

        return found.system;
    }

    kept.delete(cwd);

    const system = load();

    if (system === undefined) {
        return undefined;
    }

    freeze(system);
    loaded.add(system);

    const weight = weightOf(system);

    if (revision !== undefined && weight <= BUDGET) {
        kept.set(cwd, { revision, system, weight });

        let total = 0;

        for (const entry of kept.values()) {
            total += entry.weight;
        }

        for (const [key, entry] of kept) {
            if (kept.size <= ENTRIES && total <= BUDGET) {
                break;
            }

            kept.delete(key);
            total -= entry.weight;
        }
    }

    return system;
}

export function forgetSystem(cwd: string): void {
    kept.delete(cwd);
}

export function derived(system: DesignSystem, key: string, make: () => string): string {
    if (!loaded.has(system)) {
        return make();
    }

    let values = memos.get(system);

    if (values === undefined) {
        values = new Map();
        memos.set(system, values);
    }

    let value = values.get(key);

    if (value === undefined) {
        value = make();

        if (values.size < 8) {
            values.set(key, value);
        }
    }

    return value;
}
