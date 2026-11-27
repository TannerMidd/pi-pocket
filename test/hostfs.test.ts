import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import {
    existsSync,
    mkdirSync,
    mkdtempSync,
    readFileSync,
    rmSync,
    statSync,
    symlinkSync,
    writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import * as hostfs from "../src/server/hostfs.ts";

const linux = process.platform === "linux";

type Lab = {
    root: string;
    outside: string;
    secret: string;
    host: hostfs.Hostfs;
    plain: hostfs.Hostfs;
};

/** A sandboxed folder `root`, a folder `outside` with a secret, and a view that lists `root`. */
function lab(t: { after: (fn: () => void) => void }): Lab {
    const base = mkdtempSync(join(tmpdir(), "pocket-hostfs-"));
    const root = join(base, "project");
    const outside = join(base, "outside");

    t.after(() => rmSync(base, { recursive: true, force: true }));
    mkdirSync(join(root, "sub"), { recursive: true });
    mkdirSync(outside);
    writeFileSync(join(outside, "secret.txt"), "secret");
    writeFileSync(join(root, "ok.txt"), "ok");
    writeFileSync(join(root, "sub", "deep.txt"), "deep");

    const info = statSync(root, { bigint: true });
    const host = new hostfs.Hostfs({
        sandboxedFolders: () => [{ path: root, dev: info.dev, ino: info.ino }],
    });

    return { root, outside, secret: join(outside, "secret.txt"), host, plain: new hostfs.Hostfs() };
}

test("a plain folder is the plain call: links are followed and the errors are the same", (t) => {
    const { root, outside, secret, plain } = lab(t);

    symlinkSync(secret, join(root, "link.txt"));
    symlinkSync(outside, join(root, "dir-link"));

    const folder = plain.folder(root);

    assert.equal(folder.sandboxed, false);
    assert.equal(hostfs.readText(folder.at("ok.txt")), "ok");
    assert.equal(hostfs.readText(folder.at("link.txt")), "secret");
    assert.equal(hostfs.readText(folder.at("dir-link/secret.txt")), "secret");
    assert.equal(hostfs.stat(folder.at("link.txt")).isFile(), true);
    assert.throws(() => hostfs.readText(folder.at("missing.txt")), { code: "ENOENT" });
    assert.deepEqual(hostfs.readdir(folder.at("sub")), ["deep.txt"]);
    assert.equal(hostfs.exists(plain.at(secret)), true);
});

test("a FolderRef is no string, and fs rejects it", (t) => {
    const { root, plain } = lab(t);
    const folder = plain.folder(root);

    assert.throws(() => `${folder as unknown as string}`, TypeError);
    assert.throws(() => String(folder), TypeError);
    assert.throws(() => (folder as unknown as string) + "x", TypeError);
    assert.throws(() => readFileSync(folder as unknown as string), TypeError);
    assert.equal(String(folder.display), root);
    assert.throws(() => readFileSync(folder.display as unknown as string), {
        code: "ERR_INVALID_ARG_TYPE",
    });
});

test(
    "a sandboxed folder reads its own files and refuses a link, as the last name or on the way",
    { skip: !linux },
    (t) => {
        const { root, outside, secret, host } = lab(t);

        symlinkSync(secret, join(root, "link.txt"));
        symlinkSync(outside, join(root, "dir-link"));
        symlinkSync("/dev/zero", join(root, "zero"));
        symlinkSync("../outside", join(root, "sub", "up"));

        const folder = host.folder(root);

        assert.equal(folder.sandboxed, true);
        assert.equal(hostfs.readText(folder.at("ok.txt")), "ok");
        assert.equal(hostfs.readText(folder.at("sub/deep.txt")), "deep");
        assert.throws(() => hostfs.readText(folder.at("link.txt")), { code: "EACCES" });
        assert.throws(() => hostfs.readText(folder.at("dir-link/secret.txt")), { code: "EACCES" });
        assert.throws(() => hostfs.readText(folder.at("sub/up/secret.txt")), { code: "EACCES" });
        assert.throws(() => hostfs.readText(folder.at("zero")), { code: "EACCES" });
        assert.equal(hostfs.lstat(folder.at("link.txt")).isSymbolicLink(), true);
        assert.equal(hostfs.exists(folder.at("link.txt")), true);
        assert.throws(() => folder.at("../outside/secret.txt"), { code: "EACCES" });
        assert.throws(() => folder.at("sub/../ok.txt"), { code: "EACCES" });
        assert.throws(() => folder.at("/etc/passwd"), { code: "EACCES" });
        assert.deepEqual(hostfs.readdir(folder.at("sub")).sort(), ["deep.txt", "up"]);
        assert.deepEqual(hostfs.readdir(folder.at("")).sort(), [
            "dir-link",
            "link.txt",
            "ok.txt",
            "sub",
            "zero",
        ]);
    },
);

test(
    "a pipe or a device in a sandboxed folder is never opened or waited on",
    { skip: !linux },
    async (t) => {
        const { root, host } = lab(t);

        execFileSync("mkfifo", [join(root, "pipe")]);

        const folder = host.folder(root);

        assert.throws(() => hostfs.readText(folder.at("pipe")), { code: "EFBIG" });
        await assert.rejects(hostfs.readFileAsync(folder.at("pipe")), { code: "EFBIG" });
        assert.equal(hostfs.stat(folder.at("pipe")).isFIFO(), true);
        assert.throws(() => hostfs.createReadStream(folder.at("pipe")), { code: "EACCES" });

        const file = hostfs.openSync(folder.at("pipe"));

        assert.equal(file.stat().isFIFO(), true);
        file.close();
        assert.throws(() => hostfs.readText(folder.at("ok.txt"), { max: 1 }), { code: "EFBIG" });
    },
);

test(
    "a raw path from anyone is classified by identity: an alias, a nested link, a parent swap",
    { skip: !linux },
    (t) => {
        const { root, outside, secret, host } = lab(t);
        const alias = join(root, "..", "alias");
        const nested = join(root, "sub", "nested");

        symlinkSync(root, alias);
        symlinkSync(outside, nested);
        symlinkSync(root, join(outside, "back"));

        // By the stated path: confined.
        assert.equal(hostfs.readText(host.at(join(root, "ok.txt"))), "ok");
        assert.equal(host.at(join(root, "ok.txt")).sandboxed, true);
        assert.throws(() => hostfs.readText(host.at(join(nested, "secret.txt"))), {
            code: "EACCES",
        });
        // Through an alias that is not the stated path: refused.
        assert.throws(() => host.at(join(alias, "ok.txt")), { code: "EACCES" });
        assert.throws(() => host.at(join(alias, "sub", "deep.txt")), { code: "EACCES" });
        assert.throws(() => host.at(join(outside, "back", "ok.txt")), { code: "EACCES" });
        // A path that is not there, through a dangling link into the folder: refused.
        symlinkSync(join(root, "new.txt"), join(outside, "dangling"));
        assert.throws(() => host.at(join(outside, "dangling")), { code: "EACCES" });
        // A path outside is plain: the secret is as readable as before.
        assert.equal(hostfs.readText(host.at(secret)), "secret");
        assert.equal(host.at(secret).sandboxed, false);

        // A session whose folder is the alias works in the same folder, confined.
        const folder = host.folder(alias);

        assert.equal(folder.sandboxed, true);
        assert.equal(hostfs.readText(folder.at("ok.txt")), "ok");
        assert.throws(() => hostfs.readText(folder.at("sub/nested/secret.txt")), {
            code: "EACCES",
        });

        // A nested folder root replaced by a link: the descriptor walk refuses it.
        const inner = host.folder(join(root, "sub"));

        assert.equal(hostfs.readText(inner.at("deep.txt")), "deep");
        rmSync(join(root, "sub", "deep.txt"));
        rmSync(join(root, "sub"), { recursive: true, force: true });
        symlinkSync(outside, join(root, "sub"));
        assert.throws(() => hostfs.readText(inner.at("secret.txt")), { code: "EACCES" });
    },
);

test("a folder that is replaced after it was chosen is refused", { skip: !linux }, (t) => {
    const { root, outside, host } = lab(t);
    const gone = `${root}-old`;
    const folder = host.folder(root);

    hostfs.readText(folder.at("ok.txt"));
    // The folder's own path now names another folder (the guest cannot do this, but a mount swap can).
    execFileSync("mv", [root, gone]);
    symlinkSync(outside, root);
    assert.throws(() => hostfs.readText(folder.at("secret.txt")), { code: "ESTALE" });
    rmSync(root);
    execFileSync("mv", [gone, root]);
});

test(
    "a sandboxed folder makes, writes, renames, and removes inside itself only",
    { skip: !linux },
    async (t) => {
        const { root, outside, host } = lab(t);
        const folder = host.folder(root);

        hostfs.mkdir(folder.at("a/b/c"), { recursive: true });
        hostfs.writeFile(folder.at("a/b/c/f.txt"), "one");
        hostfs.writeFileAtomic(folder.at("a/b/c/g.txt"), "two");
        hostfs.rename(folder.at("a/b/c/f.txt"), folder.at("a/h.txt"));
        assert.equal(readFileSync(join(root, "a", "h.txt"), "utf8"), "one");
        assert.equal(readFileSync(join(root, "a", "b", "c", "g.txt"), "utf8"), "two");
        assert.throws(() => hostfs.writeFile(folder.at("a/h.txt"), "x", { flag: "wx" }), {
            code: "EEXIST",
        });
        await hostfs.mkdirAsync(folder.at("z"), { recursive: true });
        assert.equal(statSync(join(root, "z")).isDirectory(), true);
        await hostfs.copyFileAsync(folder.at("a/h.txt"), folder.at("z/copy.txt"));
        assert.equal(readFileSync(join(root, "z", "copy.txt"), "utf8"), "one");

        // A link where a name is made is replaced as a name, not followed.
        symlinkSync(join(outside, "secret.txt"), join(root, "a", "trap.txt"));
        assert.throws(() => hostfs.writeFile(folder.at("a/trap.txt"), "overwritten"), {
            code: "EACCES",
        });
        assert.equal(readFileSync(join(outside, "secret.txt"), "utf8"), "secret");
        hostfs.unlink(folder.at("a/trap.txt"));
        assert.equal(readFileSync(join(outside, "secret.txt"), "utf8"), "secret");

        // Removing a tree removes a link in it, never what the link names.
        symlinkSync(outside, join(root, "a", "b", "out"));
        hostfs.rm(folder.at("a"), { recursive: true });
        assert.equal(existsSync(join(root, "a")), false);
        assert.equal(readFileSync(join(outside, "secret.txt"), "utf8"), "secret");
        hostfs.rm(folder.at("missing"), { force: true });
        assert.throws(() => hostfs.rm(folder.at("missing")), { code: "ENOENT" });
    },
);

test(
    "a swap race never reaches outside: writes, removes, and reads while a process swaps a folder for a link",
    { skip: !linux, timeout: 60_000 },
    async (t) => {
        const { root, outside, host } = lab(t);
        const folder = host.folder(root);
        const swapper = spawn(
            process.execPath,
            [
                "-e",
                `const fs = require("node:fs");
const [root, outside] = process.argv.slice(1);
const a = root + "/race", b = root + "/race-real";
fs.mkdirSync(b, { recursive: true });
let go = true;
process.on("SIGTERM", () => { go = false; });
while (go) {
    try { fs.renameSync(b, root + "/race-old"); fs.symlinkSync(outside, a); } catch {}
    try { fs.unlinkSync(a); fs.renameSync(root + "/race-old", b); fs.symlinkSync(b, a); } catch {}
    try { fs.unlinkSync(a); fs.mkdirSync(a); } catch {}
    try { fs.rmSync(a, { recursive: true, force: true }); } catch {}
    try { fs.symlinkSync(outside, a); } catch {}
    try { fs.unlinkSync(a); } catch {}
}`,
                root,
                outside,
            ],
            { stdio: "ignore" },
        );

        t.after(() => swapper.kill("SIGKILL"));

        const marker = join(outside, "marker.txt");

        writeFileSync(marker, "mine");

        const seen = new Map<string, number>();

        for (let index = 0; index < 3000; index++) {
            for (const act of [
                () => hostfs.writeFile(folder.at("race/marker.txt"), "pwned"),
                () => hostfs.unlink(folder.at("race/marker.txt")),
                () => hostfs.mkdir(folder.at("race/made"), { recursive: true }),
                () => hostfs.rm(folder.at("race/made"), { recursive: true, force: true }),
                () => hostfs.rename(folder.at("race/marker.txt"), folder.at("race/moved.txt")),
                () => hostfs.readText(folder.at("race/secret.txt")),
            ]) {
                try {
                    act();
                    seen.set("ok", (seen.get("ok") ?? 0) + 1);
                } catch (error) {
                    // Refusals and missing names are the point: nothing may reach outside.
                    const code = (error as NodeJS.ErrnoException).code ?? "?";

                    seen.set(code, (seen.get(code) ?? 0) + 1);
                }
            }
        }

        swapper.kill("SIGKILL");
        assert.ok((seen.get("EACCES") ?? 0) > 0, `the swap was met: ${JSON.stringify([...seen])}`);
        assert.equal(readFileSync(marker, "utf8"), "mine");
        assert.equal(existsSync(join(outside, "made")), false);
        assert.equal(existsSync(join(outside, "moved.txt")), false);
        assert.equal(readFileSync(join(outside, "secret.txt"), "utf8"), "secret");
    },
);

test("a sandboxed folder fails closed off Linux, with a message", (t) => {
    const { root, host } = lab(t);
    const folder = host.folder(root);

    if (linux) {
        t.skip("This system is Linux: the fail-closed branch has nothing to show.");

        return;
    }

    assert.throws(() => hostfs.readText(folder.at("ok.txt")), { code: "EOPNOTSUPP" });
});

test(
    "a view that lists nothing is the plain view, and the folder holding a sandboxed one counts",
    { skip: !linux },
    (t) => {
        const { root, host, plain } = lab(t);
        const parent = join(root, "..");

        assert.equal(plain.folder(root).sandboxed, false);
        assert.equal(host.folder(parent).sandboxed, true);
        assert.equal(host.folder(join(parent, "outside")).sandboxed, false);
    },
);

test("own() is a plain place under a root", (t) => {
    const { root } = lab(t);

    assert.equal(hostfs.readText(hostfs.own(root).child("ok.txt")), "ok");
    assert.throws(() => hostfs.own(root).child("../x"), { code: "EACCES" });
});

test(
    "a nested session's root is pinned at admission: swapped for a link or another folder, every operation refuses",
    { skip: !linux },
    async (t) => {
        const { root, outside, host } = lab(t);
        const nested = join(root, "sub");
        const folder = host.folder(nested);

        writeFileSync(join(outside, "other.txt"), "other");
        assert.equal(hostfs.readText(folder.at("deep.txt")), "deep");

        const operations: [string, () => unknown][] = [
            ["read", () => hostfs.readText(folder.at("secret.txt"))],
            ["readAsync", () => hostfs.readFileAsync(folder.at("secret.txt"))],
            ["stat", () => hostfs.stat(folder.at("secret.txt"))],
            ["list", () => hostfs.readdir(folder.at(""))],
            ["listAsync", () => hostfs.readdirAsync(folder.at(""))],
            ["write", () => hostfs.writeFile(folder.at("new.txt"), "x")],
            ["mkdir", () => hostfs.mkdir(folder.at("made/deeper"), { recursive: true })],
            ["unlink", () => hostfs.unlink(folder.at("secret.txt"))],
            ["rm", () => hostfs.rm(folder.at("secret.txt"), { force: true })],
            ["rename", () => hostfs.rename(folder.at("secret.txt"), folder.at("moved.txt"))],
            ["folder itself", () => hostfs.stat(folder.at(""))],
            ["realpath", () => hostfs.realpath(folder.at(""))],
        ];

        for (const swap of ["link", "folder"]) {
            rmSync(nested, { recursive: true, force: true });

            if (swap === "link") {
                symlinkSync(outside, nested);
            } else {
                mkdirSync(nested);
                writeFileSync(join(nested, "secret.txt"), "not the admitted folder");
            }

            for (const [name, run] of operations) {
                let refused = false;

                try {
                    await run();
                } catch (error) {
                    refused = ["ESTALE", "EACCES"].includes(
                        (error as NodeJS.ErrnoException).code ?? "",
                    );
                }

                assert.equal(refused, true, `${swap}: ${name} refused`);
            }

            assert.equal(readFileSync(join(outside, "secret.txt"), "utf8"), "secret");
            assert.equal(existsSync(join(outside, "new.txt")), false);
            assert.equal(existsSync(join(outside, "made")), false);
            // The folder is never found again by its name: a new FolderRef for it is a new admission.
            mkdirSync(nested, { recursive: true });
        }
    },
);
