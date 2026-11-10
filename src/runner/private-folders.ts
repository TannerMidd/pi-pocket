/**
 * The runner's folders in the temporary folder (`pi-pocket-uploads`, `pi-pocket-tasks`, `pi-pocket-downloads`), made
 * private before any session uses them. On Linux the temporary folder is shared by every user: a folder another user
 * made first, or made readable, would let them read attachments and downloads, or plant a task's files. macOS and
 * Windows give each user a temporary folder of their own; the check there costs nothing.
 */
import { chmod, lstat, mkdir } from "node:fs/promises";
import { join } from "node:path";

export const PRIVATE_FOLDERS = ["pi-pocket-uploads", "pi-pocket-tasks", "pi-pocket-downloads"];

/** Make each folder in `base` (mode 0700, this user's, not a link); refuse one that another user owns. */
export async function privateFolders(
    base: string,
    uid: number | undefined = process.getuid?.(),
    names: readonly string[] = PRIVATE_FOLDERS,
): Promise<void> {
    for (const name of names) {
        const folder = join(base, name);

        await mkdir(folder, { mode: 0o700 }).catch((error: NodeJS.ErrnoException) => {
            if (error.code !== "EEXIST") {
                throw error;
            }
        });

        const found = await lstat(folder);

        if (!found.isDirectory()) {
            throw new Error(
                `${folder} is not a folder (a link or a file): the runner does not use it. Remove it, then start the runner again.`,
            );
        }

        // No user ids on Windows: its temporary folder is the user's own.
        if (uid === undefined) {
            continue;
        }

        if (found.uid !== uid) {
            throw new Error(
                `${folder} belongs to another user of this computer: the runner does not use it. Remove it, then start the runner again.`,
            );
        }

        if ((found.mode & 0o077) !== 0) {
            await chmod(folder, 0o700);
        }
    }
}
