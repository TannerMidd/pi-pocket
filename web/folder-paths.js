// Folder paths as the folder picker and the app show them, for any computer's paths: `/a/b` on Linux and macOS,
// `C:\a\b` (and `\\server\share\a`) on Windows. Plain functions with no imports, so tests load them as they are.

/** A Windows path's root: a drive (`D:`, `D:\`, `D:/`) or a share (`\\server\share\`). */
const WINDOWS_ROOT = /^(?:[A-Za-z]:(?:[\\/]|$)|\\\\[^\\/]+[\\/][^\\/]+(?:[\\/]|$))/;

/** Whether a path is a Windows one, with a drive or a share. */
export const isWindowsPath = (path) => WINDOWS_ROOT.test(path);

/** The separator a path's folders are split with: `\` for a Windows path, else `/`. */
export const separatorOf = (path) => (isWindowsPath(path) ? "\\" : "/");

/** Whether text typed is a whole path, not a name in the folder you are in: `~…`, `/…`, `\…`, `D:`, or `D:\…`. */
export const isWholePath = (text) => /^\s*[~/\\]/.test(text) || isWindowsPath(text.trim());

/** Whether `path` is `folder` or in it. */
export function isInside(path, folder) {
    return (
        Boolean(folder) && (path === folder || path.startsWith(`${folder}${separatorOf(folder)}`))
    );
}

/** A folder's path with a name added: `/a` and `b` make `/a/b`, `/` and `b` make `/b`, `D:\` and `b` make `D:\b`. */
export function joined(folder, name) {
    const sep = separatorOf(folder);

    return `${folder.replace(/[\\/]+$/, "")}${sep}${name.replace(/^[\\/]+/, "")}`;
}

/** `~/x` for a path in `home`, `~\x` on Windows; any other path as it is. */
export function shortPath(path, home) {
    if (!path) {
        return "";
    }

    if (home && isInside(path, home)) {
        return `~${path.slice(home.length)}`;
    }

    return path;
}

/** The name a root folder shows: `D:` for a drive, `\\server\share` for a share, `/` for the root. */
export const rootName = (root) => root.replace(/[\\/]+$/, "") || "/";

/** A folder's name: the last part of its path, or ~ for home and the root's name for a root. */
export function nameOf(path, home) {
    if (path === home) {
        return "~";
    }

    const root = WINDOWS_ROOT.exec(path)?.[0] ?? "/";
    const parts = path.slice(root.length).split(/[\\/]/).filter(Boolean);

    return parts.at(-1) ?? rootName(root);
}

/** The path as steps to click back up to: ~ or the root (`/`, `D:`), then each folder under it. */
export function crumbsOf(path, home) {
    const sep = separatorOf(path);
    const underHome = isInside(path, home);
    const root = WINDOWS_ROOT.exec(path)?.[0] ?? "/";
    // A root ends in its separator, as the server names it: `D:\`, not `D:`.
    const rootPath = isWindowsPath(root) ? `${root.replace(/[\\/]+$/, "")}${sep}` : "/";
    const start = underHome ? home : root;
    const crumbs = [
        underHome ? { name: "~", path: home } : { name: rootName(rootPath), path: rootPath },
    ];
    let at = underHome ? home.replace(/[\\/]+$/, "") : rootPath.replace(/[\\/]+$/, "");

    for (const part of path.slice(start.length).split(/[\\/]/).filter(Boolean)) {
        at = `${at}${sep}${part}`;
        crumbs.push({ name: part, path: at });
    }

    return crumbs;
}

/** Recent folders' labels: each one's name, with its parent's where two have the same name. */
export function recentLabels(paths, home) {
    const names = paths.map((path) => nameOf(path, home));

    return paths.map((path, index) =>
        names.indexOf(names[index]) === names.lastIndexOf(names[index])
            ? names[index]
            : shortPath(path, home).split(/[\\/]/).slice(-2).join(separatorOf(path)),
    );
}
