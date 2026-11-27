/** One non-owner file request. Resolve protected roots and the fork's grants once, before looking at candidates. */
import { join, relative, resolve, sep } from "node:path";
import { type Hostfs, isFile, realpath } from "./hostfs.ts";
import {
    type BoundUpload,
    matchesUpload,
    uploadContent,
    type UploadContent,
} from "./upload-content.ts";

/** The path as it really is, through the folder's confinement: a link into a sandboxed folder is refused. */
function realOf(host: Hostfs, path: string): string | undefined {
    try {
        return realpath(host.at(path), { native: true });
    } catch {
        return undefined;
    }
}

function inside(root: string, path: string): boolean {
    return path === root || path.startsWith(root.endsWith(sep) ? root : root + sep);
}

// Use a conservative comparison only to identify protected names, never to grant access. Even a Linux host can mount
// a case-insensitive volume. An ambiguous spelling on a case-sensitive volume is denied, not treated as the store.
function protectedName(path: string): string {
    return path.normalize("NFC").toLowerCase();
}

function rootNames(...paths: (string | undefined)[]): string[] {
    return [...new Set(paths.flatMap((path) => (path === undefined ? [] : [protectedName(path)])))];
}

function ambiguousWindowsPath(path: string): boolean {
    return (
        process.platform === "win32" &&
        (path.startsWith("\\\\") || path.slice(2).includes(":") || /[. ](?:\\|$)/u.test(path))
    );
}

const regularIn = (host: Hostfs, path: string): boolean => {
    try {
        return isFile(host.at(path));
    } catch {
        return false;
    }
};

const reference = /^([1-9]\d*)\/([^/\\\x00-\x1f]+)$/u;

/** A path that may be read (a name in a folder, or a bound upload), or the names a folder lists. */
type Decision = { file?: string | BoundUpload; children?: readonly string[] };
const denied: Decision = { children: [] };

export function filePolicy(options: {
    /** How raw paths are classified: a path into a sandboxed folder is confined, and a link into one is refused. */
    host: Hostfs;
    dataDir: string;
    canonicalDataDir: string;
    managedStorage: {
        root(store: "uploads"): string;
        uploadFolder(id: number): string | undefined;
    };
    agentDir: string;
    cwd: string;
    unrestrictedWorkspace: boolean;
    session: string;
    ancestors: ReadonlySet<string>;
    inherited: unknown;
    content?: Record<string, UploadContent>;
}) {
    const namedData = resolve(options.dataDir);
    const data = realOf(options.host, namedData);
    const uploads = data === undefined ? undefined : join(data, "uploads");
    const actualUploads = uploads === undefined ? undefined : realOf(options.host, uploads);
    const storeIntact =
        data === options.canonicalDataDir && uploads !== undefined && uploads === actualUploads;
    const dataNames = rootNames(namedData, data);
    const agentNames = rootNames(resolve(options.agentDir), realOf(options.host, options.agentDir));
    const namedUploads = join(namedData, "uploads");
    const uploadNames = rootNames(namedUploads, uploads, actualUploads);
    const project = realOf(options.host, options.cwd);
    const inherited = new Map<string, Map<string, UploadContent>>();

    for (const ref of Array.isArray(options.inherited) ? options.inherited : []) {
        const match = typeof ref === "string" && reference.exec(ref);

        if (!match || !options.ancestors.has(match[1]!) || [".", ".."].includes(match[2]!)) {
            continue;
        }

        const content = uploadContent(options.content?.[ref]);

        if (!content) {
            continue;
        }

        const names = inherited.get(match[1]!) ?? new Map<string, UploadContent>();

        names.set(match[2]!, content);
        inherited.set(match[1]!, names);
    }

    const uploadFolders = [options.session, ...inherited.keys()];

    function verifiedFolder(source?: string): boolean {
        try {
            if (uploads === undefined || options.managedStorage.root("uploads") !== uploads) {
                return false;
            }

            return (
                source === undefined ||
                options.managedStorage.uploadFolder(Number(source)) === join(uploads, source)
            );
        } catch {
            return false;
        }
    }

    const reachable = (path: string) =>
        options.unrestrictedWorkspace || (project !== undefined && inside(project, path));

    const decide = (path: string): Decision => {
        const target = realOf(options.host, path);

        if (
            data === undefined ||
            data !== options.canonicalDataDir ||
            target === undefined ||
            ambiguousWindowsPath(path) ||
            ambiguousWindowsPath(target)
        ) {
            return denied;
        }

        const named = protectedName(path);
        const resolved = protectedName(target);
        const under = (roots: string[]) =>
            roots.some((root) => inside(root, named) || inside(root, resolved));

        if (under(agentNames)) {
            return denied;
        }

        if (under(uploadNames)) {
            if (!storeIntact || !inside(uploads, target) || !verifiedFolder()) {
                return denied;
            }

            // A path written in the store must still name its own entry. Do not follow a replacement link there.
            if (
                uploadNames.some((root) => inside(root, named)) &&
                ![namedUploads, uploads].some(
                    (root) => inside(root, path) && join(uploads, relative(root, path)) === target,
                )
            ) {
                return denied;
            }

            if (target === uploads) {
                return { children: uploadFolders.filter((source) => verifiedFolder(source)) };
            }

            const parts = relative(uploads, target).split(sep);
            const source = parts[0]!;

            if (!verifiedFolder(source)) {
                return denied;
            }

            if (source === options.session) {
                return { file: target };
            }

            const names = inherited.get(source);

            if (names !== undefined) {
                if (parts.length === 1) {
                    return { children: [...names.keys()] };
                }

                const content = names.get(parts[1]!);

                if (parts.length === 2 && content && regularIn(options.host, target)) {
                    return { file: { path: target, content } };
                }
            }

            return denied;
        }

        if (under(dataNames)) {
            if (target === data) {
                return { children: ["uploads", "worktrees", "repos"] };
            }

            if (!inside(join(data, "repos"), target) && !inside(join(data, "worktrees"), target)) {
                return denied;
            }
        }

        return reachable(target) ? { file: target } : denied;
    };

    const folder = project === undefined ? undefined : protectedName(project);
    const ordinaryTree =
        folder !== undefined &&
        project === resolve(options.cwd) &&
        ![...agentNames, ...dataNames, ...uploadNames].some(
            (root) => inside(root, folder) || inside(folder, root),
        );

    return {
        ordinaryTree,
        grant: async (ref: string, issued?: UploadContent): Promise<UploadContent | undefined> => {
            const match = reference.exec(ref);

            if (!storeIntact || !match || [".", ".."].includes(match[2]!)) {
                return undefined;
            }

            const path = join(uploads, match[1]!, match[2]!);
            const file = decide(path).file;
            const content =
                typeof file === "object"
                    ? file.content
                    : file === path && match[1] === options.session
                      ? uploadContent(issued)
                      : undefined;

            return content && (await matchesUpload({ path, content })) ? content : undefined;
        },
        file: (path: string) => decide(path).file,
        allow: (path: string) => {
            const file = decide(path).file;

            return typeof file === "object" ? matchesUpload(file) : file !== undefined;
        },
        children: (path: string) => decide(path).children,
    };
}
