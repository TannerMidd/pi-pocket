import { once } from "node:events";
import { mkdtempSync, rmSync, watch, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** libuv reports EMFILE when the Darwin sandbox denies the FSEvents stream, also after fs.watch returns. */
async function unavailable(): Promise<false | string> {
    if (process.platform !== "darwin" || !process.env.NIX_BUILD_TOP) {
        return false;
    }

    const dir = mkdtempSync(join(tmpdir(), "pocket-watch-"));

    try {
        const watcher = watch(dir);
        const change = setInterval(() => writeFileSync(join(dir, "probe"), "x"), 100);

        try {
            await once(watcher, "change", { signal: AbortSignal.timeout(5000) });
        } finally {
            clearInterval(change);
            watcher.close();
        }
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EMFILE") {
            throw error;
        }

        return "the Darwin Nix builder cannot start a directory watch";
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }

    return false;
}

export const noDirectoryWatch = await unavailable();
