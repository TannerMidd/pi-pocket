// The private folder of this server's own browser downloads (`privateFolder` in `src/server/browser/downloads.ts`).
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, statSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { privateFolder } from "../src/server/browser/downloads.ts";

const root = mkdtempSync(join(tmpdir(), "pi-pocket-download-folder-test-"));

after(() => rmSync(root, { recursive: true, force: true }));

describe("this server's private downloads folder", { skip: process.getuid === undefined }, () => {
    const uid = process.getuid!();

    it("is made with mode 0700, and closed again when it is open to others", async () => {
        const base = join(root, "made");

        mkdirSync(base);
        const folder = await privateFolder(base, uid);

        assert.equal(folder, join(base, `pi-pocket-downloads-${uid}`));
        assert.equal(statSync(folder).mode & 0o777, 0o700);

        chmodSync(folder, 0o755);
        assert.equal(await privateFolder(base, uid), folder);
        assert.equal(statSync(folder).mode & 0o777, 0o700);
    });

    it("is refused when another user owns it, or when it is a link", async () => {
        const base = join(root, "taken");

        mkdirSync(base);
        // Owned by "another user": this folder's owner is not the uid asked for.
        mkdirSync(join(base, `pi-pocket-downloads-${uid + 1}`));
        await assert.rejects(privateFolder(base, uid + 1), /belongs to another user: refused/);

        mkdirSync(join(base, "elsewhere"));
        symlinkSync(join(base, "elsewhere"), join(base, `pi-pocket-downloads-${uid}`));
        await assert.rejects(privateFolder(base, uid), /is not a folder: refused/);
    });
});
