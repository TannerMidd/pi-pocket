import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import {
    appendFileSync,
    chmodSync,
    closeSync,
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

test(
    "a plain folder is the plain call: links are followed and the errors are the same",
    { skip: process.platform === "win32" && "links need a privilege on Windows" },
    (t) => {
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
    },
);

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

        assert.throws(() => hostfs.readText(folder.at("pipe")), { code: "ENXIO" });
        await assert.rejects(hostfs.readFileAsync(folder.at("pipe")), { code: "ENXIO" });
        // A look at it works; an open does not.
        assert.equal(hostfs.stat(folder.at("pipe")).isFIFO(), true);
        assert.throws(() => hostfs.createReadStream(folder.at("pipe"), { end: 10 }), {
            code: "ENXIO",
        });
        assert.throws(() => hostfs.openSync(folder.at("pipe")), { code: "ENXIO" });
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

test(
    "an alias that enters the folder is the folder: a link after that point does not lead the path out",
    { skip: !linux },
    (t) => {
        const { root, outside, host } = lab(t);
        const alias = join(root, "..", "alias");

        symlinkSync(root, alias);
        symlinkSync(outside, join(root, "out"));

        // /alias -> /project, /project/out -> /outside: the path enters the folder at /alias, so it is refused, though the file is outside.
        assert.throws(() => host.at(join(alias, "out", "secret.txt")), { code: "EACCES" });
        assert.throws(() => hostfs.readText(host.at(join(alias, "out", "secret.txt"))), {
            code: "EACCES",
        });
        // A folder chosen as the alias works in the same folder, confined: the link inside it is not followed.
        const chosen = host.folder(alias);

        assert.throws(() => hostfs.readText(chosen.at("out/secret.txt")), { code: "EACCES" });
        assert.equal(hostfs.readText(chosen.at("ok.txt")), "ok");
        // A path outside every folder that never enters one is plain.
        assert.equal(hostfs.readText(host.at(join(outside, "secret.txt"))), "secret");
    },
);

test(
    "a folder pinned at admission is refused when its name is a new folder, a link, or another inode",
    { skip: !linux },
    async (t) => {
        const { root, outside, host } = lab(t);
        const nested = join(root, "sub");
        const admitted = statSync(nested, { bigint: true });
        const pinned = host.folder(nested, { dev: admitted.dev, ino: admitted.ino });

        assert.equal(hostfs.readText(pinned.at("deep.txt")), "deep");
        // Same name, new inode: a folder the guest made in its place.
        rmSync(nested, { recursive: true });
        mkdirSync(nested);
        writeFileSync(join(nested, "deep.txt"), "forged");

        for (const run of [
            () => hostfs.readText(pinned.at("deep.txt")),
            () => hostfs.readdir(pinned.at("")),
            () => hostfs.stat(pinned.at("")),
            () => hostfs.writeFile(pinned.at("new.txt"), "x"),
            () => hostfs.openSync(pinned.at("deep.txt")),
            () => hostfs.readFileAsync(pinned.at("deep.txt")),
        ]) {
            await assert.rejects(async () => run(), { code: "ESTALE" });
        }

        // A new FolderRef for the same position has the identity it was admitted with, not the replacement's. Only
        // teardown (`unpinRoot`) lets a new admission take the name.
        assert.throws(() => hostfs.readText(host.folder(nested).at("deep.txt")), {
            code: "ESTALE",
        });
        host.unpinRoot(nested);
        assert.equal(hostfs.readText(host.folder(nested).at("deep.txt")), "forged");
        rmSync(nested, { recursive: true });
        symlinkSync(outside, nested);
        await assert.rejects(async () => hostfs.readText(pinned.at("secret.txt")), {
            code: /ESTALE|EACCES/,
        });
    },
);

test(
    "a pipe, a device link, and a socket are never opened for write, read-write, or truncate",
    { skip: !linux, timeout: 30_000 },
    async (t) => {
        const { root, host } = lab(t);
        const folder = host.folder(root);

        execFileSync("mkfifo", [join(root, "pipe")]);
        symlinkSync("/dev/null", join(root, "null"));
        writeFileSync(join(root, "keep.txt"), "keep");

        const { createServer } = await import("node:net");
        const server = createServer();

        await new Promise<void>((done) => server.listen(join(root, "sock"), done));
        t.after(() => server.close());

        // A reader on the pipe would let a plain write through: the pipe is refused before it is opened.
        const reader = (await import("node:fs")).openSync(join(root, "pipe"), "r+");

        t.after(() => require_close(reader));

        for (const name of ["pipe", "null", "sock"]) {
            for (const flag of ["w", "r+", "a", "w+"]) {
                assert.throws(
                    () => hostfs.openSync(folder.at(name), flag),
                    { code: /ENXIO|EACCES/ },
                    `${name} ${flag}`,
                );
            }

            assert.throws(
                () => hostfs.writeFile(folder.at(name), "x"),
                { code: /ENXIO|EACCES/ },
                name,
            );
            await assert.rejects(
                hostfs.open(folder.at(name), "r+"),
                { code: /ENXIO|EACCES/ },
                name,
            );
            assert.throws(
                () => hostfs.createReadStream(folder.at(name), { end: 10 }),
                { code: /ENXIO|EACCES/ },
                name,
            );
        }

        assert.equal(readFileSync(join(root, "pipe").replace("pipe", "keep.txt"), "utf8"), "keep");
        // A regular file truncates and writes, and a name that is not there is made.
        hostfs.writeFile(folder.at("keep.txt"), "new");
        assert.equal(readFileSync(join(root, "keep.txt"), "utf8"), "new");
        hostfs.writeFile(folder.at("made.txt"), "made");
        assert.equal(readFileSync(join(root, "made.txt"), "utf8"), "made");
        assert.throws(() => hostfs.writeFile(folder.at("made.txt"), "x", { flag: "wx" }), {
            code: "EEXIST",
        });
    },
);

function require_close(fd: number): void {
    try {
        closeSync(fd);
    } catch {
        // Closed.
    }
}

test(
    "a read is bounded by what it reads, not by the size it looked at first",
    { skip: !linux },
    async (t) => {
        const { root, host } = lab(t);
        const folder = host.folder(root);
        const file = join(root, "grows.txt");

        writeFileSync(file, "x".repeat(100));

        const grow = () => appendFileSync(file, "y".repeat(5000));

        assert.equal(hostfs.readFile(folder.at("grows.txt"), { max: 100 }).length, 100);
        assert.throws(
            () => hostfs.readFile(folder.at("grows.txt"), { max: 100, afterSize: grow }),
            { code: "EFBIG" },
        );
        writeFileSync(file, "x".repeat(100));
        await assert.rejects(
            hostfs.readFileAsync(folder.at("grows.txt"), { max: 100, afterSize: grow }),
            { code: "EFBIG" },
        );
        // The same for a descriptor's readAll, and for a file one byte past the cap.
        writeFileSync(file, "x".repeat(101));
        assert.throws(() => hostfs.readFile(folder.at("grows.txt"), { max: 100 }), {
            code: "EFBIG",
        });
        assert.throws(() => hostfs.openSync(folder.at("grows.txt")).readAll(100), {
            code: "EFBIG",
        });
    },
);

test(
    "a child of a plain place is classified again: a walk that starts above a sandboxed folder is confined from there",
    { skip: !linux },
    (t) => {
        const { root, outside, host } = lab(t);
        const above = host.at(join(root, ".."));
        const alias = join(root, "..", "alias");

        symlinkSync(root, alias);
        symlinkSync(outside, join(root, "out"));

        assert.equal(above.sandboxed, false);
        // Entering the folder by name: confined, so its own link is not followed.
        assert.equal(above.child("project").sandboxed, true);
        assert.equal(hostfs.readText(above.child("project").child("ok.txt")), "ok");
        assert.equal(hostfs.readText(above.child("project/sub/deep.txt")), "deep");
        assert.throws(() => hostfs.readText(above.child("project/out/secret.txt")), {
            code: "EACCES",
        });
        assert.throws(
            () => hostfs.readText(above.child("project").child("out").child("secret.txt")),
            { code: "EACCES" },
        );
        // Entering it by an alias is refused at the child that enters.
        assert.throws(() => above.child("alias/ok.txt"), { code: "EACCES" });
        assert.throws(() => above.child("alias").child("out"), { code: "EACCES" });
        // Outside every folder it stays plain, and Pocket's own places have no context to classify with.
        assert.equal(hostfs.readText(above.child("outside/secret.txt")), "secret");
        assert.equal(hostfs.own(root).child("out").sandboxed, false);

        // A worker takes the place with the folders it was sent with, and classifies its children the same way.
        const received = hostfs.receivePlace(hostfs.sendPlace(above));

        assert.equal(received.child("project").sandboxed, true);
        assert.throws(() => received.child("alias/ok.txt"), { code: "EACCES" });
    },
);

test(
    "a first-look pin is kept until admission is torn down, and a full table refuses, never evicts",
    { skip: !linux },
    (t) => {
        const { root, host: unused, outside } = lab(t);
        const info = statSync(root, { bigint: true });
        const host = new hostfs.Hostfs(
            { sandboxedFolders: () => [{ path: root, dev: info.dev, ino: info.ino }] },
            { maxPins: 3 },
        );

        assert.ok(unused);

        for (const name of ["one", "two", "three"]) {
            mkdirSync(join(root, name));
            writeFileSync(join(root, name, "f.txt"), name);
        }

        const first = host.folder(join(root, "one"));

        host.folder(join(root, "two"));
        assert.throws(() => host.folder(join(root, "three")), { code: "EMFILE" });
        // The first pin is still there: a replacement at its path is refused, not accepted as the root.
        rmSync(join(root, "one"), { recursive: true });
        mkdirSync(join(root, "one"));
        writeFileSync(join(root, "one", "f.txt"), "forged");
        assert.throws(() => hostfs.readText(host.folder(join(root, "one")).at("f.txt")), {
            code: "ESTALE",
        });
        assert.throws(() => hostfs.readText(first.at("f.txt")), { code: "ESTALE" });
        // Teardown frees a slot; a pinned folder is pinned again at its next look.
        host.unpinRoot(join(root, "one"));
        assert.equal(hostfs.readText(host.folder(join(root, "one")).at("f.txt")), "forged");
        assert.ok(outside);
    },
);

test(
    "a copy is streamed and counted: a file that grows during it is refused, and the part written is removed",
    { skip: !linux },
    async (t) => {
        const { root, host } = lab(t);
        const folder = host.folder(root);
        const source = join(root, "source.bin");

        writeFileSync(source, "x".repeat(100));

        // The bytes that are there fit the budget.
        await hostfs.copyFileAsync(folder.at("source.bin"), folder.at("copy.bin"), 100);
        assert.equal(readFileSync(join(root, "copy.bin"), "utf8"), "x".repeat(100));

        // It grows after the first chunk was read: the next chunk is past the budget, whatever the size said first.
        let chunks = 0;

        const grow = () => {
            if (++chunks === 1) {
                appendFileSync(source, "y".repeat(5000));
            }
        };

        await assert.rejects(
            hostfs.copyFileAsync(folder.at("source.bin"), folder.at("grown.bin"), 100, grow),
            { code: "EFBIG" },
        );
        assert.equal(existsSync(join(root, "grown.bin")), false);
        // A source in a plain place copied into a sandboxed one is bounded the same.
        const plainSource = join(root, "..", "plain.bin");

        writeFileSync(plainSource, "z".repeat(100));
        chunks = 0;

        const grewPlain = () => {
            if (++chunks === 1) {
                appendFileSync(plainSource, "w".repeat(5000));
            }
        };

        await assert.rejects(
            hostfs.copyFileAsync(host.at(plainSource), folder.at("from-plain.bin"), 100, grewPlain),
            { code: "EFBIG" },
        );
        assert.equal(existsSync(join(root, "from-plain.bin")), false);
    },
);

test(
    "a copy sets the mode by the descriptor it wrote, never through a link swapped in, and reports what it copied",
    { skip: !linux },
    (t) => {
        const { root, outside, host } = lab(t);
        const folder = host.folder(root);
        const victim = join(outside, "victim.txt");

        writeFileSync(join(root, "source.txt"), "x".repeat(100));
        writeFileSync(victim, "keep");
        chmodSync(victim, 0o644);

        // The guest swaps the target's name for a link to a file outside after the bytes were written.
        const swap = () => {
            rmSync(join(root, "target.txt"));
            symlinkSync(victim, join(root, "target.txt"));
        };

        hostfs.copyFile(folder.at("source.txt"), folder.at("target.txt"), 0o600, 1000, swap);
        assert.equal(
            statSync(victim).mode & 0o777,
            0o644,
            "the outside file's mode is not changed",
        );
        assert.equal(readFileSync(victim, "utf8"), "keep");

        // The count is what was read, not what a look at the size said first.
        let grown = false;

        const grow = () => {
            if (!grown) {
                grown = true;
                appendFileSync(join(root, "source.txt"), "y".repeat(200));
            }
        };

        assert.equal(
            hostfs.copyFile(
                folder.at("source.txt"),
                folder.at("counted.txt"),
                undefined,
                1000,
                grow,
            ),
            300,
        );
        assert.equal(statSync(join(root, "counted.txt")).size, 300);
    },
);

test(
    "a pinned root keeps its descriptor, so its inode number cannot be reused by a replacement",
    { skip: !linux },
    (t) => {
        const { root, host } = lab(t);
        const nested = join(root, "sub");
        const pinned = statSync(nested, { bigint: true });
        const folder = host.folder(nested);

        assert.equal(hostfs.readText(folder.at("deep.txt")), "deep");
        assert.ok(host.heldRoots >= 2, "the sandboxed folder and the nested pin are held");

        // The guest removes the folder, then makes many: a freed inode number is reused at once on many file systems.
        rmSync(nested, { recursive: true });

        const reused: string[] = [];

        for (let index = 0; index < 200; index++) {
            const candidate = join(root, `candidate-${index}`);

            mkdirSync(candidate);

            if (statSync(candidate, { bigint: true }).ino === pinned.ino) {
                reused.push(candidate);
            }
        }

        assert.deepEqual(reused, [], "a held inode is not handed out again");
        mkdirSync(nested);
        writeFileSync(join(nested, "deep.txt"), "forged");
        assert.throws(() => hostfs.readText(folder.at("deep.txt")), { code: "ESTALE" });

        // Teardown closes the descriptor of the nested pin; shutdown closes the rest.
        const before = host.heldRoots;

        host.unpinRoot(nested);
        assert.equal(host.heldRoots, before - 1);
        host.close();
        assert.equal(host.heldRoots, 0);
    },
);

test(
    "held root descriptors are capped, the cap fails closed with EMFILE, and a sandboxed folder that is no longer listed is released",
    { skip: !linux },
    (t) => {
        const { root } = lab(t);
        const info = statSync(root, { bigint: true });
        let listed = true;
        const host = new hostfs.Hostfs(
            {
                sandboxedFolders: () =>
                    listed ? [{ path: root, dev: info.dev, ino: info.ino }] : [],
            },
            { maxPins: 2 },
        );

        for (const name of ["one", "two"]) {
            mkdirSync(join(root, name));
        }

        host.folder(join(root, "one"));
        assert.equal(host.heldRoots, 2, "the sandboxed folder and the first nested pin");
        assert.throws(() => host.folder(join(root, "two")), { code: "EMFILE" });
        // The view stops listing the folder: its descriptor goes at the next look, and the nested pin stays.
        listed = false;
        host.at(root);
        assert.equal(host.heldRoots, 1);
        host.close();
    },
);

test(
    "a sandboxed folder is listed as the entries come, and a folder past the cap is refused, not read whole",
    { skip: !linux },
    (t) => {
        const { root, host } = lab(t);
        const folder = host.folder(root);

        mkdirSync(join(root, "many"));

        for (let index = 0; index < 50; index++) {
            writeFileSync(join(root, "many", `f${index}`), "");
        }

        assert.equal(hostfs.readdir(folder.at("many")).length, 50);
        assert.throws(() => hostfs.readdir(folder.at("many"), { max: 10 }), { code: "EFBIG" });
        assert.throws(() => hostfs.readdir(folder.at("many"), { withFileTypes: true, max: 10 }), {
            code: "EFBIG",
        });
        // A plain folder is the plain call, with no cap.
        assert.equal(
            hostfs.readdir(
                host.at(join(root, "many")).sandboxed
                    ? hostfs.own(root).child("many")
                    : hostfs.own(root),
            ).length,
            50,
        );
    },
);

test(
    "a descriptor is held for every holder: ending a nested pin does not close a root that the view still lists",
    { skip: !linux },
    (t) => {
        const { root } = lab(t);
        const nested = join(root, "sub");
        const outer = statSync(root, { bigint: true });
        const inner = statSync(nested, { bigint: true });
        let listed = [
            { path: root, dev: outer.dev, ino: outer.ino },
            { path: nested, dev: inner.dev, ino: inner.ino },
        ];
        const host = new hostfs.Hostfs({ sandboxedFolders: () => listed });

        // The nested folder is pinned under the outer root, while both are listed (overlapping roots).
        const folder = host.folder(nested);

        assert.equal(hostfs.readText(folder.at("deep.txt")), "deep");
        assert.equal(host.heldRoots, 2, "the outer root, and the nested pin");

        // The outer root is no longer listed: its hold goes, and the inner root is now a root of its own, held for the view.
        listed = [{ path: nested, dev: inner.dev, ino: inner.ino }];
        assert.equal(hostfs.readText(host.at(join(nested, "deep.txt"))), "deep");
        assert.equal(
            host.heldRoots,
            1,
            "the inner root is held by the pin and by the view: one descriptor",
        );

        // Teardown of the pin: the view still lists the root, so its descriptor stays.
        host.unpinRoot(nested);
        assert.equal(host.heldRoots, 1);

        // Not listed any more, and no pin: now the last holder lets go.
        listed = [];
        host.at(root);
        assert.equal(host.heldRoots, 0);
        host.close();
    },
);

test(
    "a listed root holds a view descriptor whichever path pinned it, so ending a nested pin first does not close it",
    { skip: !linux },
    (t) => {
        const { root } = lab(t);
        const nested = join(root, "sub");
        const outer = statSync(root, { bigint: true });
        const inner = statSync(nested, { bigint: true });
        const host = new hostfs.Hostfs({
            sandboxedFolders: () => [
                { path: root, dev: outer.dev, ino: outer.ino },
                { path: nested, dev: inner.dev, ino: inner.ino },
            ],
        });

        // Both roots are listed, and the nested one is pinned first, with no other call that would hold it for the view.
        host.folder(nested);
        host.unpinRoot(nested);
        assert.equal(host.heldRoots, 2, "both listed roots keep their descriptors");
        host.close();
    },
);

test(
    "a place made from a path inside a pinned nested folder carries the pin",
    { skip: !linux },
    (t) => {
        const { root, host } = lab(t);
        const nested = join(root, "sub");

        host.folder(nested);
        rmSync(nested, { recursive: true });
        mkdirSync(nested);
        writeFileSync(join(nested, "deep.txt"), "forged");

        // Rebuilt from the stated path, not from the folder: the admitted-root check is still there.
        assert.throws(() => hostfs.readText(host.at(join(nested, "deep.txt"))), { code: "ESTALE" });
        assert.throws(() => hostfs.readText(host.at(root).child("sub").child("deep.txt")), {
            code: "ESTALE",
        });
    },
);

test(
    "a pin at every depth is checked: a root pinned below another is not accepted when it is replaced",
    { skip: !linux },
    (t) => {
        const { root, host } = lab(t);
        const outer = join(root, "sub");
        const inner = join(outer, "inner");

        mkdirSync(inner);
        writeFileSync(join(inner, "f.txt"), "real");

        const folder = host.folder(outer);

        host.folder(inner);
        assert.equal(hostfs.readText(folder.at("inner/f.txt")), "real");
        rmSync(inner, { recursive: true });
        mkdirSync(inner);
        writeFileSync(join(inner, "f.txt"), "forged");

        // The place comes from the outer folder, which is itself intact: the pin of the inner one still applies.
        assert.throws(() => hostfs.readText(folder.at("inner/f.txt")), { code: "ESTALE" });
        assert.throws(() => hostfs.readText(folder.at("inner").child("f.txt")), { code: "ESTALE" });
        assert.equal(
            hostfs.readText(folder.at("deep.txt")),
            "deep",
            "the rest of the outer folder is still read",
        );
    },
);

test("a place sent to a worker takes the nested pins with it", { skip: !linux }, (t) => {
    const { root, host } = lab(t);
    const nested = join(root, "sub");

    host.folder(nested);
    rmSync(nested, { recursive: true });
    mkdirSync(nested);
    writeFileSync(join(nested, "deep.txt"), "forged");

    const received = hostfs.receivePlace(hostfs.sendPlace(host.at(root)));

    // The worker descends from above the pinned folder: the pin is checked where it enters it.
    assert.throws(() => hostfs.readText(received.child("sub").child("deep.txt")), {
        code: "ESTALE",
    });
    assert.throws(() => hostfs.readText(received.child("sub/deep.txt")), { code: "ESTALE" });
});

test(
    "a walk over many folders holds no descriptor: only the folders sessions work in are pinned",
    { skip: !linux, timeout: 60_000 },
    async (t) => {
        const { root } = lab(t);
        const info = statSync(root, { bigint: true });
        const host = new hostfs.Hostfs(
            { sandboxedFolders: () => [{ path: root, dev: info.dev, ino: info.ino }] },
            { maxPins: 20 },
        );

        execFileSync("git", ["init", "-q", "-b", "main", root]);

        for (let index = 0; index < 60; index++) {
            mkdirSync(join(root, `d${index}`));
            writeFileSync(join(root, `d${index}`, "f.txt"), "x");
        }

        const { listFiles } = await import("../src/server/files.ts");
        const folder = host.folder(root);
        const before = host.heldRoots;
        const listed = await listFiles(folder, 10_000, {
            ordinaryTree: false,
            allow: () => true,
            children: () => undefined,
        });

        assert.ok(listed.files.includes("d59/f.txt"), "every folder was listed");
        assert.equal(host.heldRoots, before, "the listing took no pin");
    },
);

test(
    "nested pins are matched by identity along the walk: an alias, an alias two levels up, and an overlapping listed root",
    { skip: !linux },
    (t) => {
        const { root, outside, host } = lab(t);
        const nested = join(root, "sub");
        const base = join(root, "..");
        const alias = join(base, "alias");
        const up = join(base, "up");

        symlinkSync(root, alias);
        symlinkSync(base, up);
        host.folder(nested);
        rmSync(nested, { recursive: true });
        mkdirSync(nested);
        writeFileSync(join(nested, "deep.txt"), "forged");

        // Reached by an alias of the folder, and by an alias of the folder above it: the label is not the pinned path.
        assert.throws(() => hostfs.readText(host.folder(alias).at("sub/deep.txt")), {
            code: "ESTALE",
        });
        assert.throws(() => hostfs.readText(host.folder(alias).at("sub").child("deep.txt")), {
            code: "ESTALE",
        });
        assert.throws(() => hostfs.readText(host.folder(join(up, "project")).at("sub/deep.txt")), {
            code: "ESTALE",
        });
        assert.ok(outside);

        // Overlapping listed roots, and nothing that pinned the inner one: the view's own identity applies on the walk.
        const outer = statSync(root, { bigint: true });
        const inner = statSync(join(root, "inner"), { bigint: true, throwIfNoEntry: false });

        assert.equal(inner, undefined);
        mkdirSync(join(root, "inner"));
        writeFileSync(join(root, "inner", "f.txt"), "real");

        const innerInfo = statSync(join(root, "inner"), { bigint: true });
        const listing = new hostfs.Hostfs({
            sandboxedFolders: () => [
                { path: root, dev: outer.dev, ino: outer.ino },
                { path: join(root, "inner"), dev: innerInfo.dev, ino: innerInfo.ino },
            ],
        });

        assert.equal(hostfs.readText(listing.at(join(root, "inner", "f.txt"))), "real");
        rmSync(join(root, "inner"), { recursive: true });
        mkdirSync(join(root, "inner"));
        writeFileSync(join(root, "inner", "f.txt"), "forged");
        assert.throws(() => hostfs.readText(listing.at(join(root, "inner", "f.txt"))), {
            code: "ESTALE",
        });
        assert.throws(() => hostfs.readText(listing.at(root).child("inner").child("f.txt")), {
            code: "ESTALE",
        });
        listing.close();
        host.close();
    },
);

test(
    "a full table never stalls a look: a replaced root frees its place first, and plain folders are not affected",
    { skip: !linux },
    (t) => {
        const { root, outside } = lab(t);

        const make = (name: string) => {
            mkdirSync(join(root, name));
            writeFileSync(join(root, name, "f.txt"), name);

            const info = statSync(join(root, name), { bigint: true });

            return { path: join(root, name), dev: info.dev, ino: info.ino };
        };

        // Three separate roots under their own folders, and a table that holds two.
        const base = join(root, "..", "roots");

        mkdirSync(base);

        const folders = ["a", "b", "c"].map((name) => {
            mkdirSync(join(base, name));
            writeFileSync(join(base, name, "f.txt"), name);

            const info = statSync(join(base, name), { bigint: true });

            return { path: join(base, name), dev: info.dev, ino: info.ino };
        });

        assert.ok(make);

        let listed = [folders[0]!, folders[1]!];
        const host = new hostfs.Hostfs({ sandboxedFolders: () => listed }, { maxPins: 2 });

        assert.equal(hostfs.readText(host.at(join(base, "a", "f.txt"))), "a");
        assert.equal(hostfs.readText(host.at(join(base, "b", "f.txt"))), "b");
        assert.equal(host.heldRoots, 2, "the table is full");

        // `b` is replaced by `c` in the view: `b` lets go first, so `c` fits.
        listed = [folders[0]!, folders[2]!];
        assert.equal(hostfs.readText(host.at(join(base, "c", "f.txt"))), "c");
        assert.equal(host.heldRoots, 2);

        // A third root does not fit: only an operation inside it is refused, with the reason. Everything else still works.
        listed = [folders[0]!, folders[1]!, folders[2]!];
        assert.equal(
            hostfs.readText(host.at(join(outside, "secret.txt"))),
            "secret",
            "a plain path",
        );
        assert.equal(hostfs.readText(host.folder(outside).at("secret.txt")), "secret");
        assert.equal(hostfs.readText(host.traverse(outside).at("secret.txt")), "secret");
        assert.equal(host.folder(outside).sandboxed, false);
        assert.equal(hostfs.readText(host.at(join(base, "a", "f.txt"))), "a", "a held root");
        assert.throws(() => hostfs.readText(host.at(join(base, "b", "f.txt"))), {
            code: "EMFILE",
            message: /too many roots/,
        });
        host.unpinRoot(join(base, "a"));
        assert.equal(hostfs.readText(host.at(join(outside, "secret.txt"))), "secret");
        host.close();
    },
);

test(
    "one owner for each position: an alias reuses the identity, and teardown of one path keeps the position for the others",
    { skip: !linux },
    (t) => {
        const { root, host } = lab(t);
        const nested = join(root, "sub");
        const alias = join(root, "..", "alias");

        symlinkSync(root, alias);

        const admitted = statSync(nested, { bigint: true });
        const first = host.folder(nested);

        assert.equal(hostfs.readText(first.at("deep.txt")), "deep");
        rmSync(nested, { recursive: true });
        mkdirSync(nested);
        writeFileSync(join(nested, "deep.txt"), "forged");

        // The alias reaches the same position: it takes the identity of the owner, it does not make the replacement the root.
        assert.throws(() => host.folder(join(alias, "sub")), { code: "ESTALE" });
        assert.throws(() => hostfs.readText(host.at(root).child("sub").child("deep.txt")), {
            code: "ESTALE",
        });
        // An admission that names another identity for the position is refused before anything is held.
        const held = host.heldRoots;

        assert.throws(
            () => host.folder(join(alias, "sub"), { dev: admitted.dev + 1n, ino: admitted.ino }),
            { code: "ESTALE" },
        );
        assert.equal(host.heldRoots, held);

        // Two paths hold the position: ending one keeps it, ending the last drops it.
        host.unpinRoot(join(alias, "sub"));
        assert.throws(() => hostfs.readText(host.at(root).child("sub").child("deep.txt")), {
            code: "ESTALE",
        });
        host.unpinRoot(nested);
        assert.equal(hostfs.readText(host.at(root).child("sub").child("deep.txt")), "forged");
        host.close();
    },
);

test("a walk that crosses a listed root that cannot be held is refused", { skip: !linux }, (t) => {
    const { root } = lab(t);
    const outer = statSync(root, { bigint: true });
    const inner = statSync(join(root, "sub"), { bigint: true });
    const host = new hostfs.Hostfs(
        {
            sandboxedFolders: () => [
                { path: root, dev: outer.dev, ino: outer.ino },
                { path: join(root, "sub"), dev: inner.dev, ino: inner.ino },
            ],
        },
        { maxPins: 1 },
    );

    // The table holds the outer root only. A path in the outer root that is not in the inner one still works.
    assert.equal(hostfs.readText(host.at(join(root, "ok.txt"))), "ok");
    // A path that crosses the inner root is refused: its inode could be reused, as nothing holds it.
    assert.throws(() => hostfs.readText(host.at(join(root, "sub", "deep.txt"))), {
        code: "EMFILE",
    });
    assert.throws(() => hostfs.readText(host.at(root).child("sub").child("deep.txt")), {
        code: "EMFILE",
    });
    host.close();
});

test(
    "a traversal reference does not get past a listed root: capacity and replacement are checked, and the view's identity wins",
    { skip: !linux },
    (t) => {
        const { root } = lab(t);
        const nested = join(root, "sub");
        const outer = statSync(root, { bigint: true });
        const inner = statSync(nested, { bigint: true });
        const listed = [
            { path: root, dev: outer.dev, ino: outer.ino },
            { path: nested, dev: inner.dev, ino: inner.ino },
        ];

        // Capacity: the table holds the outer root only, and a folder for a walk inside the inner root is refused.
        const small = new hostfs.Hostfs({ sandboxedFolders: () => listed }, { maxPins: 1 });

        assert.equal(hostfs.readText(small.at(join(root, "ok.txt"))), "ok");
        assert.throws(() => hostfs.readText(small.traverse(nested).at("deep.txt")), {
            code: "EMFILE",
        });
        small.close();

        // Replacement: the folder for the walk is made after the inner root was replaced, so it carries the replacement's
        // identity. The view lists the original, and a conflict is refused.
        const host = new hostfs.Hostfs({ sandboxedFolders: () => listed });

        assert.equal(hostfs.readText(host.traverse(nested).at("deep.txt")), "deep");
        rmSync(nested, { recursive: true });
        mkdirSync(nested);
        writeFileSync(join(nested, "deep.txt"), "forged");
        assert.throws(() => hostfs.readText(host.traverse(nested).at("deep.txt")), {
            code: "ESTALE",
        });
        assert.throws(() => hostfs.readText(host.folder(nested).at("deep.txt")), {
            code: "ESTALE",
        });
        host.close();
    },
);

test(
    "a file in a sandboxed folder is never read or streamed without a bound",
    { skip: !linux },
    (t) => {
        const { root, host } = lab(t);
        const folder = host.folder(root);

        writeFileSync(join(root, "big.txt"), "x".repeat(hostfs.MAX_TEXT + 1));
        // Whole-file read through a descriptor: the default is the cap.
        assert.throws(() => hostfs.openSync(folder.at("big.txt")).readAll(), { code: "EFBIG" });
        assert.equal(hostfs.openSync(folder.at("ok.txt")).readAll().toString(), "ok");
        // A stream with no bound is refused at run time (and is a type error).
        assert.throws(() => hostfs.createReadStream(folder.at("ok.txt"), {} as { end: number }), {
            code: "EINVAL",
        });
        assert.throws(() => hostfs.createReadStream(folder.at("ok.txt"), { end: Infinity }), {
            code: "EINVAL",
        });
        hostfs.createReadStream(folder.at("ok.txt"), { end: 1 }).destroy();
        // A plain folder is as before: no cap on a whole-file read.
        const open = hostfs.openSync(hostfs.own(root).child("big.txt"));

        assert.equal(open.readAll().length, hostfs.MAX_TEXT + 1);
        open.close();
    },
);

test(
    "a folder that was admitted keeps its first identity when the view adds a root above it",
    { skip: !linux },
    (t) => {
        const { root } = lab(t);
        const base = join(root, "..", "outer");
        const inner = join(base, "inner");
        const sub = join(inner, "sub");

        mkdirSync(sub, { recursive: true });
        writeFileSync(join(sub, "f.txt"), "real");

        const info = (path: string) => {
            const found = statSync(path, { bigint: true });

            return { path, dev: found.dev, ino: found.ino };
        };

        let listed = [info(inner)];
        const host = new hostfs.Hostfs({ sandboxedFolders: () => listed });

        // Admitted with the inner root listed, and no identity from admission state: the first look pins it.
        assert.equal(hostfs.readText(host.folder(sub).at("f.txt")), "real");

        // Another session adds the outer root: the folder now lies in the outer root, and the position changes.
        listed = [info(base), info(inner)];
        rmSync(sub, { recursive: true });
        mkdirSync(sub);
        writeFileSync(join(sub, "f.txt"), "forged");

        // Admitted again, or reached by a path: it is still the first folder, not the replacement the guest made.
        assert.throws(() => hostfs.readText(host.folder(sub).at("f.txt")), { code: "ESTALE" });
        assert.throws(() => hostfs.readText(host.at(join(sub, "f.txt"))), { code: "ESTALE" });
        assert.throws(() => hostfs.readText(host.at(base).child("inner/sub/f.txt")), {
            code: "ESTALE",
        });
        host.close();
    },
);

test(
    "the walk checks what it opens, by the directory's identity and the name: no alias, spelling, or seed gets around a recorded entry",
    { skip: !linux },
    (t) => {
        const { root, host } = lab(t);
        const nested = join(root, "sub");
        const base = join(root, "..");
        const alias = join(base, "alias");
        const other = join(base, "other");

        symlinkSync(root, alias);
        symlinkSync(root, other);
        host.folder(nested);
        rmSync(nested, { recursive: true });
        mkdirSync(nested);
        writeFileSync(join(nested, "deep.txt"), "forged");

        // A folder for a walk, reached by an alias: it makes no pin, and the replacement is not its identity.
        assert.throws(() => hostfs.readText(host.traverse(join(alias, "sub")).at("deep.txt")), {
            code: "ESTALE",
        });
        assert.throws(() => hostfs.readText(host.traverse(join(other, "sub")).at("deep.txt")), {
            code: "ESTALE",
        });
        assert.throws(() => hostfs.readText(host.traverse(nested).at("deep.txt")), {
            code: "ESTALE",
        });
        assert.throws(() => hostfs.readText(host.traverse(root).at("sub/deep.txt")), {
            code: "ESTALE",
        });
        host.close();
    },
);

test(
    "a listed root reached under another name is still the listed root: the check does not depend on the path's spelling",
    { skip: !linux },
    (t) => {
        const { root } = lab(t);
        const nested = join(root, "sub");
        const chosen = join(root, "..", "chosen");

        symlinkSync(nested, chosen);

        const info = (path: string) => {
            const found = statSync(path, { bigint: true });

            return { path, dev: found.dev, ino: found.ino };
        };

        // `/chosen` is listed, and it is `/project/sub`: the outer root's walk to `sub` must find that identity.
        // The identities the view lists are what they were when the folders were admitted: read once.
        const listed = [info(root), info(chosen)];
        const host = new hostfs.Hostfs({ sandboxedFolders: () => listed });

        assert.equal(hostfs.readText(host.at(join(root, "sub", "deep.txt"))), "deep");
        rmSync(nested, { recursive: true });
        mkdirSync(nested);
        writeFileSync(join(nested, "deep.txt"), "forged");
        assert.throws(() => hostfs.readText(host.at(join(root, "sub", "deep.txt"))), {
            code: "ESTALE",
        });
        assert.throws(() => hostfs.readText(host.at(root).child("sub").child("deep.txt")), {
            code: "ESTALE",
        });
        assert.throws(() => hostfs.readText(host.traverse(root).at("sub/deep.txt")), {
            code: "ESTALE",
        });
        host.close();
    },
);

test(
    "the same folder pinned through two spellings at once is one pin, and a replacement is refused by either",
    { skip: !linux },
    (t) => {
        const { root, host } = lab(t);
        const nested = join(root, "sub");
        const alias = join(root, "..", "alias");

        symlinkSync(root, alias);

        const direct = host.folder(nested);
        const spelled = host.folder(join(alias, "sub"));

        assert.equal(hostfs.readText(direct.at("deep.txt")), "deep");
        assert.equal(hostfs.readText(spelled.at("deep.txt")), "deep");
        assert.equal(
            host.heldRoots,
            2,
            "the folder and its sandboxed root: one entry, however it was spelled",
        );

        rmSync(nested, { recursive: true });
        mkdirSync(nested);
        writeFileSync(join(nested, "deep.txt"), "forged");
        assert.throws(() => hostfs.readText(direct.at("deep.txt")), { code: "ESTALE" });
        assert.throws(() => hostfs.readText(spelled.at("deep.txt")), { code: "ESTALE" });
        host.close();
    },
);
