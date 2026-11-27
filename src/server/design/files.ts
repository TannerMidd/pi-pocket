/** Export paths stay inside the session folder; directory links cannot redirect a write. */
import { randomBytes } from "node:crypto";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import {
    constants,
    type FolderRef,
    lstatAsync,
    mkdirAsync,
    open,
    realpathAsync,
    renameAsync,
    rmAsync,
} from "../hostfs.ts";
import { workspaceScheme } from "../paths.ts";

/** What the design system and design exports say in a session on a workspace URI: its files are not here. */
export const REMOTE_DESIGN =
    "The design system and design exports are not available for remote workspaces.";

/** A session's folder when it is on this machine: undefined for none, or for a workspace URI (`ssh://…`). */
export function localFolder(cwd: string | undefined): string | undefined {
    return cwd === undefined || workspaceScheme(cwd) !== undefined ? undefined : cwd;
}

export async function writeExport(
    cwd: FolderRef,
    path: string,
    bytes: Buffer,
    /** @internal A test hook, after the first look at the folder: where a guest can replace it. */
    afterCheck?: () => void | Promise<void>,
): Promise<string> {
    const root = await realpathAsync(cwd.at());

    await afterCheck?.();
    const target = resolve(root, path);
    const local = relative(root, target);

    if (local === "" || local === ".." || local.startsWith(`..${sep}`) || isAbsolute(local)) {
        throw new Error("Export paths must stay inside the session folder.");
    }

    // Every place is derived from the folder itself, so its admitted root is checked at each step.
    let parent = cwd.at();

    for (const part of relative(root, dirname(target)).split(sep).filter(Boolean)) {
        parent = parent.child(part);
        await mkdirAsync(parent).catch((error: NodeJS.ErrnoException) => {
            if (error.code !== "EEXIST") {
                throw error;
            }
        });
        const info = await lstatAsync(parent);

        if (info.isSymbolicLink() || !info.isDirectory()) {
            throw new Error("Export directories must not be symbolic links.");
        }
    }

    const temporary = parent.child(`.pocket-export-${randomBytes(12).toString("hex")}`);
    const handle = await open(
        temporary,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL,
        0o600,
    );

    try {
        await handle.writeFile(bytes);
        await handle.close();
        await renameAsync(temporary, cwd.at(local));
    } finally {
        await handle.close();
        await rmAsync(temporary, { force: true });
    }

    return target;
}
