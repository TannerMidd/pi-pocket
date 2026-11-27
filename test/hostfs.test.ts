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
        const pinned = statSync(root, { bigint: true });
        const folder = host.folder(root);

        assert.equal(hostfs.readText(folder.at("ok.txt")), "ok");
        assert.equal(host.heldRoots, 1, "the sandboxed root is pinned once");

        // The guest (or anyone) removes the root and makes many folders: a freed inode number is reused at once on many
        // file systems, and a held one is not handed out again.
        const moved = `${root}.gone`;

        execFileSync("mv", [root, moved]);

        const reused: string[] = [];

        for (let index = 0; index < 200; index++) {
            const candidate = join(root, "..", `candidate-${index}`);

            mkdirSync(candidate);

            if (statSync(candidate, { bigint: true }).ino === pinned.ino) {
                reused.push(candidate);
            }
        }

        assert.deepEqual(reused, []);
        // The path now names another folder: nothing is touched, whatever the call.
        mkdirSync(root);
        writeFileSync(join(root, "ok.txt"), "forged");
        assert.throws(() => hostfs.readText(folder.at("ok.txt")), { code: "ESTALE" });
        assert.throws(() => hostfs.writeFile(folder.at("new.txt"), "x"), { code: "ESTALE" });
        assert.equal(
            existsSync(join(root, "new.txt")),
            false,
            "nothing was created in the replacement",
        );
        // Shutdown closes the descriptor.
        host.close();
        assert.equal(host.heldRoots, 0);
        execFileSync("mv", [moved, `${root}.back`]);
    },
);

test(
    "held root descriptors are capped, the cap fails closed with EMFILE, and a root that is no longer listed is released",
    { skip: !linux },
    (t) => {
        const { root } = lab(t);
        const base = join(root, "..", "roots");

        mkdirSync(base);

        const folders = ["a", "b", "c"].map((name) => {
            mkdirSync(join(base, name));
            writeFileSync(join(base, name, "f.txt"), name);

            const info = statSync(join(base, name), { bigint: true });

            return { path: join(base, name), dev: info.dev, ino: info.ino };
        });
        let listed = [folders[0]!, folders[1]!];
        const host = new hostfs.Hostfs({ sandboxedFolders: () => listed }, { maxPins: 2 });

        host.at(base);
        assert.equal(host.heldRoots, 2);
        // A third root does not fit: only an operation inside it is refused.
        listed = [folders[0]!, folders[1]!, folders[2]!];
        assert.throws(() => hostfs.readText(host.at(join(base, "c", "f.txt"))), { code: "EMFILE" });
        assert.equal(hostfs.readText(host.at(join(base, "a", "f.txt"))), "a");
        // `b` is not listed any more: its descriptor goes, and `c` fits.
        listed = [folders[0]!, folders[2]!];
        assert.equal(hostfs.readText(host.at(join(base, "c", "f.txt"))), "c");
        assert.equal(host.heldRoots, 2);
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

        folder.at("");

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
        assert.equal(hostfs.readText(host.at(join(outside, "secret.txt"))), "secret");
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
    "every kind of write works in a sandboxed root: create, mkdir, rename to a new name, temporary folder",
    { skip: !linux },
    async (t) => {
        const { root, host } = lab(t);
        const folder = host.folder(root);
        const place = (rest: string) => folder.at(`top-${rest}`);
        const path = (rest: string) => join(root, `top-${rest}`);

        // A new file, and a file that is replaced.
        hostfs.writeFile(place("new.txt"), "one");
        assert.equal(readFileSync(path("new.txt"), "utf8"), "one");
        hostfs.writeFile(place("new.txt"), "two");
        assert.equal(readFileSync(path("new.txt"), "utf8"), "two");
        // A new folder, one level and several.
        hostfs.mkdir(place("dir"));
        assert.equal(statSync(path("dir")).isDirectory(), true);
        hostfs.mkdir(place("deep/er/still"), { recursive: true });
        assert.equal(statSync(path("deep/er/still")).isDirectory(), true);
        await hostfs.mkdirAsync(place("async"), { recursive: true });
        // A rename to a name that is not there.
        hostfs.rename(place("new.txt"), place("renamed.txt"));
        assert.equal(readFileSync(path("renamed.txt"), "utf8"), "two");
        await hostfs.renameAsync(place("renamed.txt"), place("again.txt"));
        // Atomic write: a temporary name, then a rename.
        hostfs.writeFileAtomic(place("atomic.txt"), "atomic");
        assert.equal(readFileSync(path("atomic.txt"), "utf8"), "atomic");
        // A copy to a new name, and an append that makes the file.
        hostfs.copyFile(place("atomic.txt"), place("copy.txt"));
        assert.equal(readFileSync(path("copy.txt"), "utf8"), "atomic");
        hostfs.append(place("log.txt"), "line");
        assert.equal(readFileSync(path("log.txt"), "utf8"), "line");
        // A temporary folder with a name of its own.
        const made = hostfs.makeTemporaryFolder(folder.at(""), "top-tmp-");

        assert.equal(statSync(join(root, made.name)).isDirectory(), true);
        // Remove what was made.
        hostfs.rm(place("deep"), { recursive: true });
        hostfs.unlink(place("again.txt"));
        hostfs.rm(made, { recursive: true });
        host.close();
    },
);

test(
    "a place that was plain is classified again when the view adds the folder it is in",
    { skip: !linux },
    (t) => {
        const { root, secret } = lab(t);

        symlinkSync(secret, join(root, "link.txt"));

        const info = statSync(root, { bigint: true });
        let listed: { path: string; dev: bigint; ino: bigint }[] = [];
        const host = new hostfs.Hostfs({ sandboxedFolders: () => listed });
        const saved = host.at(join(root, "link.txt"));
        const savedFolder = host.folder(root).at("link.txt");

        // Nothing is sandboxed yet: a plain place follows the link, as ever.
        assert.equal(hostfs.readText(saved), "secret");
        // The view adds the folder: the saved places are in a sandboxed folder now, and do not follow the guest's link.
        listed = [{ path: root, dev: info.dev, ino: info.ino }];
        assert.throws(() => hostfs.readText(saved), { code: "EACCES" });
        assert.throws(() => hostfs.readText(savedFolder), { code: "EACCES" });
        assert.equal(saved.sandboxed, true);
        host.close();
    },
);

test(
    "a resource opened in a plain folder is revoked when the folder becomes sandboxed, and is never raw",
    { skip: !linux },
    async (t) => {
        const { root, secret } = lab(t);
        const info = statSync(root, { bigint: true });
        let listed: { path: string; dev: bigint; ino: bigint }[] = [];
        const host = new hostfs.Hostfs({ sandboxedFolders: () => listed });

        writeFileSync(join(root, "big.txt"), "x".repeat(hostfs.MAX_TEXT + 100));

        const file = hostfs.openSync(host.at(join(root, "big.txt")));
        const handle = await hostfs.open(host.at(join(root, "big.txt")));
        const dir = await hostfs.opendir(host.at(root));
        const stream = hostfs.createReadStream(host.at(join(root, "big.txt")), { end: 10 });
        const noFollow = await hostfs.openNoFollow(host.at(join(root, "big.txt")));
        const syncDir = hostfs.opendirSyncAt(host.at(root));

        // Plain: nothing is bounded or refused, as ever.
        assert.equal(file.readAll().length, hostfs.MAX_TEXT + 100);
        assert.equal((await handle.stat()).size, hostfs.MAX_TEXT + 100);
        assert.ok(syncDir.readSync() !== null);

        // The folder becomes sandboxed: every live resource is revoked (ESTALE) on its next operation.
        listed = [{ path: root, dev: info.dev, ino: info.ino }];
        assert.throws(() => file.readAll(), { code: "ESTALE" });
        assert.throws(() => file.read(Buffer.alloc(4), 0, 4, 0), { code: "ESTALE" });
        await assert.rejects(handle.stat(), { code: "ESTALE" });
        await assert.rejects(handle.readFile(), { code: "ESTALE" });
        await assert.rejects(noFollow.read(Buffer.alloc(4), 0, 4, 0), { code: "ESTALE" });
        await assert.rejects(dir.read(), { code: "ESTALE" });
        assert.throws(() => syncDir.readSync(), { code: "ESTALE" });
        await assert.rejects(
            (async () => {
                for await (const chunk of stream) {
                    assert.ok(chunk);
                }
            })(),
            { code: "ESTALE" },
        );
        await handle.close();
        await noFollow.close();
        dir.closeSync?.call(dir);
        assert.ok(secret);
        host.close();
    },
);

test(
    "a handle in a sandboxed folder has no unbounded read, and a stream is opened by descriptor before it is returned",
    { skip: !linux },
    async (t) => {
        const { root, outside, secret, host } = lab(t);
        const folder = host.folder(root);
        const handle = await hostfs.open(folder.at("ok.txt"));

        await assert.rejects(handle.readFile(), { code: "EINVAL" });
        assert.throws(() => handle.createReadStream(), { code: "EINVAL" });
        assert.equal((await handle.read(Buffer.alloc(2), 0, 2, 0)).bytesRead, 2);
        await handle.close();

        // A plain stream, with its link swapped in before the first read: it was opened already, so it reads the file.
        const plain = join(outside, "plain.txt");

        writeFileSync(plain, "PLAIN");

        const stream = hostfs.createReadStream(hostfs.own(outside).child("plain.txt"), {
            end: 100,
        });

        rmSync(plain);
        symlinkSync(secret, plain);

        const read: Buffer[] = [];

        for await (const chunk of stream) {
            read.push(chunk as Buffer);
        }

        assert.equal(Buffer.concat(read).toString(), "PLAIN");
    },
);

test("a plain folder gives the native errors", { skip: !linux }, (t) => {
    const { root } = lab(t);
    const plain = hostfs.own(root);

    // `ok.txt` is a file: a name below it is ENOTDIR, as the plain call says (a sandboxed walk says EACCES).
    assert.throws(() => hostfs.openSync(plain.child("ok.txt/below")), { code: "ENOTDIR" });
    assert.throws(() => hostfs.openSync(plain.child("missing")), { code: "ENOENT" });
});

test(
    "overlapping roots in the view are refused: the inner root is not supported",
    { skip: !linux },
    (t) => {
        const { root } = lab(t);
        const nested = join(root, "sub");
        const chosen = join(root, "..", "chosen");
        const outer = statSync(root, { bigint: true });
        const inner = statSync(nested, { bigint: true });

        symlinkSync(nested, chosen);

        // The view lists the folder and, by another name, a folder inside it.
        const host = new hostfs.Hostfs({
            sandboxedFolders: () => [
                { path: root, dev: outer.dev, ino: outer.ino },
                { path: chosen, dev: inner.dev, ino: inner.ino },
            ],
        });

        // The outer root works, and what is in it (the inner folder too) is read through the outer root.
        assert.equal(hostfs.readText(host.at(join(root, "ok.txt"))), "ok");
        assert.equal(hostfs.readText(host.at(join(nested, "deep.txt"))), "deep");
        // The inner root as a root of its own is refused, whatever the call, and is not pinned.
        assert.throws(() => host.at(join(chosen, "deep.txt")), {
            code: "EPERM",
            message: /nested sandboxed folders are refused/,
        });
        assert.throws(() => hostfs.readText(host.folder(chosen).at("deep.txt")), { code: "EPERM" });
        assert.equal(host.heldRoots, 1, "only the outer root is pinned");
        host.close();
    },
);
