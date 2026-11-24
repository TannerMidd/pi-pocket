/**
 * The folder picker's paths, as people type them and as steps back up to them. A Windows drive is a whole path
 * (`D:`, `D:\a`, `D:/a`), and its root is a step of its own: `/` is one root of the machine, `D:\` another.
 */

/** A folder's path with a name added: `/a` and `b` make `/a/b`, `/` and `b` make `/b`. */
export const joined = (folder, name) => `${folder.replace(/\/+$/, "")}/${name.replace(/^\/+/, "")}`;

/** Whether text names a whole path: `~/a`, `/a`, or a Windows drive's (`D:`, `D:\a`, `D:/a`). */
export const whole = (text) => /^([~/]|[a-zA-Z]:(?:[\\/]|$))/.test(text);

/** A Windows path's drive root (`D:\` or `D:/`), or null for any other path. */
export const driveOf = (path) => /^[a-zA-Z]:[\\/]/.exec(path)?.[0] ?? null;

/** The path as steps to click back up to: ~, / or a drive's root, then each folder under it. */
export function crumbsOf(path, home) {
    const underHome = Boolean(home) && (path === home || path.startsWith(`${home}/`));
    // Home comes first: a Windows home (`C:\Users\me`) is also on a drive, and it still reads as ~.
    const drive = underHome ? null : driveOf(path);
    const start = drive ?? (underHome ? home : "");
    const crumbs = [{ name: drive ?? (underHome ? "~" : "/"), path: start || "/" }];
    let at = start;

    // A Windows path can use either separator (`D:\a` and `D:/a` both come back from the server).
    for (const part of path
        .slice(start.length)
        .split(drive === null ? "/" : /[\\/]/)
        .filter(Boolean)) {
        at = `${at.replace(/[\\/]+$/, "")}/${part}`;
        crumbs.push({ name: part, path: at });
    }

    return crumbs;
}
