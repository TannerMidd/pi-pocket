/**
 * The `tsconfig.json` that Pi Pocket keeps in the drop-in folder, so an editor finds Pi Pocket's packages and their
 * types there with no `node_modules` link: where a system refuses links, that link is missing.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** The first line of a `tsconfig.json` Pi Pocket made: it refreshes only such a file, never the owner's own. */
const CONFIG_MARK =
    "// Pi Pocket made this file so editors find its packages: it refreshes it at each start. Edits here are lost.\n";

/** Conditions that lead to a package's types, in the order TypeScript reads them for an `import`. */
const CONDITIONS = ["types", "import", "node", "default"];

function typesOf(entry: unknown, folder: string): string | undefined {
    if (typeof entry === "string") {
        if (/\.d\.[cm]?ts$/.test(entry)) {
            return entry;
        }

        const declared = entry.replace(/\.([cm]?)js$/, ".d.$1ts");

        return declared !== entry && (entry.includes("*") || existsSync(join(folder, declared)))
            ? declared
            : undefined;
    }

    if (Array.isArray(entry)) {
        return entry.map((each) => typesOf(each, folder)).find((each) => each !== undefined);
    }

    if (entry !== null && typeof entry === "object") {
        const conditions = entry as Record<string, unknown>;

        for (const condition of CONDITIONS) {
            const found =
                condition in conditions ? typesOf(conditions[condition], folder) : undefined;

            if (found !== undefined) {
                return found;
            }
        }
    }

    return undefined;
}

function pathsOf(name: string, modules: string): [string, string[]][] {
    const folder = join(modules, name);
    let manifest: { exports?: unknown };

    try {
        manifest = JSON.parse(
            readFileSync(join(folder, "package.json"), "utf8"),
        ) as typeof manifest;
    } catch {
        return [];
    }

    const slashes = (path: string) => path.replaceAll("\\", "/");
    const exports = manifest.exports;

    if (exports === undefined || exports === null) {
        return [
            [name, [slashes(folder)]],
            [`${name}/*`, [slashes(join(folder, "*"))]],
        ];
    }

    const subpaths =
        typeof exports === "object" &&
        !Array.isArray(exports) &&
        Object.keys(exports).some((key) => key.startsWith("."))
            ? (exports as Record<string, unknown>)
            : { ".": exports };
    const paths: [string, string[]][] = [];

    for (const [key, entry] of Object.entries(subpaths)) {
        const types = typesOf(entry, folder);

        if (types !== undefined && (key === "." || key.startsWith("./"))) {
            paths.push([
                key === "." ? name : `${name}/${key.slice(2)}`,
                [slashes(join(folder, types))],
            ]);
        }
    }

    return paths;
}

/** A file the owner made stays as it is; Pi Pocket's own is written again when its folders change (an update). */
export function writeDropInConfig(
    directory: string,
    packageModules: Readonly<Record<string, string>>,
): void {
    const file = join(directory, "tsconfig.json");
    let current: string | undefined;

    try {
        current = readFileSync(file, "utf8");
    } catch {}

    if (current !== undefined && !current.startsWith(CONFIG_MARK)) {
        return;
    }

    const paths = Object.fromEntries(
        Object.entries(packageModules).flatMap(([name, modules]) => pathsOf(name, modules)),
    );
    const typeRoots = [...new Set(Object.values(packageModules))]
        .map((modules) => join(modules, "@types"))
        .filter((folder) => existsSync(join(folder, "node")))
        .map((folder) => folder.replaceAll("\\", "/"));
    const config = {
        compilerOptions: {
            target: "esnext",
            // Not `nodenext`: with no `package.json` of type module here, it reads each drop-in as CommonJS, where
            // `import.meta` and top-level `await` are errors. Node runs them as ES modules.
            module: "esnext",
            moduleResolution: "bundler",
            strict: true,
            noEmit: true,
            allowImportingTsExtensions: true,
            skipLibCheck: true,
            ...(typeRoots.length === 0 ? {} : { typeRoots }),
            paths,
        },
        exclude: ["node_modules", ".pocket-packages"],
    };
    const content = CONFIG_MARK + JSON.stringify(config, undefined, 4) + "\n";

    if (content !== current) {
        writeFileSync(file, content);
    }
}
