/** Export paths stay inside the session folder; directory links cannot redirect a write. */
import { randomBytes } from "node:crypto";
import { lstat, mkdir, open, realpath, rename, rm } from "node:fs/promises";
import { constants } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

export async function writeExport(cwd: string, path: string, bytes: Buffer): Promise<string> {
    const root = await realpath(cwd);
    const target = resolve(root, path);
    const local = relative(root, target);

    if (local === "" || local === ".." || local.startsWith(`..${sep}`) || isAbsolute(local)) {
        throw new Error("Export paths must stay inside the session folder.");
    }

    let parent = root;

    for (const part of relative(root, dirname(target)).split(sep).filter(Boolean)) {
        parent = join(parent, part);
        await mkdir(parent).catch((error: NodeJS.ErrnoException) => {
            if (error.code !== "EEXIST") {
                throw error;
            }
        });
        const info = await lstat(parent);

        if (info.isSymbolicLink() || !info.isDirectory()) {
            throw new Error("Export directories must not be symbolic links.");
        }
    }

    const temporary = join(parent, `.pocket-export-${randomBytes(12).toString("hex")}`);
    const handle = await open(
        temporary,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL,
        0o600,
    );

    try {
        await handle.writeFile(bytes);
        await handle.close();
        await rename(temporary, target);
    } finally {
        await handle.close();
        await rm(temporary, { force: true });
    }

    return target;
}
