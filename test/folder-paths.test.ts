// Folders outside drive C: on a Windows server: the folder picker lists each drive, goes up to a drive's top folder
// and no further, and takes paths typed as `D:`, `D:\work`, or `D:/work`. Linux and macOS paths stay as they were.
import assert from "node:assert/strict";
import { posix, win32 } from "node:path";
import { test } from "node:test";
import { expandFolder, expandHome, parentFolder, rootFolders } from "../src/server/paths.ts";
// @ts-expect-error: a browser module, without types.
import * as picker from "../web/folder-paths.js";

type Crumb = { name: string; path: string };

const crumbs = picker.crumbsOf as (path: string, home: string) => Crumb[];
const HOME = "C:\\Users\\Ann";

test("a Windows server lists each drive that is there, and Linux and macOS the root", async () => {
    const there = new Set(["C:\\", "D:\\", "T:\\"]);
    const asked: string[] = [];

    const isThere = (drive: string) => {
        asked.push(drive);

        return Promise.resolve(there.has(drive));
    };

    assert.deepEqual(await rootFolders("win32", isThere), ["C:\\", "D:\\", "T:\\"]);
    assert.equal(asked.length, 26);
    assert.deepEqual(await rootFolders("linux", isThere), ["/"]);
    assert.deepEqual(await rootFolders("darwin", isThere), ["/"]);
    assert.equal(asked.length, 26);
});

test("a drive that fails or does not answer is left out, and the others still show", async () => {
    const isThere = (drive: string) =>
        drive === "Y:\\"
            ? Promise.reject(new Error("not ready"))
            : drive === "Z:\\"
              ? new Promise<boolean>(() => {})
              : Promise.resolve(drive === "D:\\");
    const started = Date.now();

    assert.deepEqual(await rootFolders("win32", isThere, 50), ["D:\\"]);
    assert.ok(Date.now() - started < 1000);
});

test("a typed drive is its top folder, and D:/work and D:\\work are the same folder", () => {
    assert.equal(expandFolder("D:", HOME, win32), "D:\\");
    assert.equal(expandFolder("d:", HOME, win32), "d:\\");
    assert.equal(win32.resolve(expandFolder("D:", HOME, win32)), "D:\\");
    assert.equal(win32.resolve(expandFolder("D:/work", HOME, win32)), "D:\\work");
    assert.equal(win32.resolve(expandFolder("D:\\work\\", HOME, win32)), "D:\\work");
    assert.equal(win32.resolve(expandFolder("T:/", HOME, win32)), "T:\\");
    assert.equal(expandFolder("~", HOME, win32), HOME);
    assert.equal(expandFolder("~\\code", HOME, win32), "C:\\Users\\Ann\\code");
    assert.equal(expandFolder("~/code", HOME, win32), "C:\\Users\\Ann\\code");
    // A bare drive is no special case elsewhere; `~\` is not a home path on Linux and macOS.
    assert.equal(expandFolder("D:", "/home/ann", posix), "D:");
    assert.equal(expandHome("~\\code", "/home/ann", posix), "~\\code");
    assert.equal(expandFolder("~/code", "/home/ann", posix), "/home/ann/code");
});

test("up stops at a drive's top folder, as it does at /", () => {
    assert.equal(parentFolder("D:\\work", win32), "D:\\");
    assert.equal(parentFolder("D:\\", win32), null);
    assert.equal(parentFolder("\\\\nas\\share\\a", win32), "\\\\nas\\share\\");
    assert.equal(parentFolder("\\\\nas\\share\\", win32), null);
    assert.equal(parentFolder("/srv/a", posix), "/srv");
    assert.equal(parentFolder("/", posix), null);
});

test("the picker's path steps start at the drive, or at ~ in home", () => {
    assert.deepEqual(crumbs("D:\\work\\app", HOME), [
        { name: "D:", path: "D:\\" },
        { name: "work", path: "D:\\work" },
        { name: "app", path: "D:\\work\\app" },
    ]);
    assert.deepEqual(crumbs("T:\\", HOME), [{ name: "T:", path: "T:\\" }]);
    assert.deepEqual(crumbs("C:\\Users\\Ann\\code", HOME), [
        { name: "~", path: HOME },
        { name: "code", path: "C:\\Users\\Ann\\code" },
    ]);
    // A folder whose name starts as home's does is not in home.
    assert.deepEqual(crumbs("C:\\Users\\Anna", HOME), [
        { name: "C:", path: "C:\\" },
        { name: "Users", path: "C:\\Users" },
        { name: "Anna", path: "C:\\Users\\Anna" },
    ]);
    assert.deepEqual(crumbs("/srv/app", "/home/ann"), [
        { name: "/", path: "/" },
        { name: "srv", path: "/srv" },
        { name: "app", path: "/srv/app" },
    ]);
    assert.deepEqual(crumbs("/home/ann/code", "/home/ann"), [
        { name: "~", path: "/home/ann" },
        { name: "code", path: "/home/ann/code" },
    ]);
    assert.deepEqual(crumbs("/", "/home/ann"), [{ name: "/", path: "/" }]);
});

test("a typed drive path is a whole path, and a name goes in the folder you are in", () => {
    for (const text of ["D:", "D:\\work", "d:/work", "\\\\nas\\share", "~", "~\\code", "/srv"]) {
        assert.equal(picker.isWholePath(text), true, text);
    }

    for (const text of ["work", "D", "D:work", "my:folder"]) {
        assert.equal(picker.isWholePath(text), false, text);
    }

    assert.equal(picker.joined("D:\\", "work"), "D:\\work");
    assert.equal(picker.joined("D:\\work", "app"), "D:\\work\\app");
    assert.equal(picker.joined("/", "srv"), "/srv");
    assert.equal(picker.joined("/srv/", "app"), "/srv/app");
});

test("names and short paths: drives by their letter, home as ~", () => {
    assert.equal(picker.nameOf("D:\\", HOME), "D:");
    assert.equal(picker.nameOf("D:\\work", HOME), "work");
    assert.equal(picker.nameOf(HOME, HOME), "~");
    assert.equal(picker.nameOf("/", "/home/ann"), "/");
    assert.equal(picker.nameOf("/srv/app/", "/home/ann"), "app");
    assert.equal(picker.shortPath("C:\\Users\\Ann\\code", HOME), "~\\code");
    assert.equal(picker.shortPath("C:\\Users\\Anna", HOME), "C:\\Users\\Anna");
    assert.equal(picker.shortPath("D:\\work", HOME), "D:\\work");
    assert.equal(picker.shortPath("/home/ann/code", "/home/ann"), "~/code");
    assert.deepEqual(picker.recentLabels(["D:\\a\\app", "T:\\b\\app", "D:\\work"], HOME), [
        "a\\app",
        "b\\app",
        "work",
    ]);
    assert.deepEqual(picker.recentLabels(["/a/app", "/b/app"], "/home/ann"), ["a/app", "b/app"]);
});
