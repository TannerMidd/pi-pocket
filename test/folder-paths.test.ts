/**
 * The folder picker's paths (`web/folder-paths.js`): a Windows drive is a whole path, so typing `D:\` goes to D:
 * rather than to a folder named `D:` in the one you are in, and its root is a step of the breadcrumbs.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
// @ts-expect-error: a browser module, without types.
import { crumbsOf, driveOf, joined, whole } from "../web/folder-paths.js";

test("a typed path is whole for a Windows drive, ~ and /", () => {
    for (const text of ["D:", "D:\\", "D:/", "D:\\AI Proj", "D:/AI Proj", "~/code", "/srv"]) {
        assert.equal(whole(text), true, text);
    }

    // These stay relative: the picker adds them to the folder it is in.
    for (const text of ["", "foo", "AI Proj", "..\\bar", "a/b"]) {
        assert.equal(whole(text), false, text);
    }

    // A drive-relative path (`D:AI Proj`, the folder `AI Proj` on D:'s current one) is left alone.
    assert.equal(whole("D:AI Proj"), false);
});

test("a Windows path's drive root is read from either separator", () => {
    assert.equal(driveOf("D:\\AI Proj"), "D:\\");
    assert.equal(driveOf("D:/AI Proj"), "D:/");
    assert.equal(driveOf("D:"), null);
    assert.equal(driveOf("/srv"), null);
    assert.equal(driveOf("/mnt/d"), null);
});

test("the breadcrumbs of a path on another drive start at its root", () => {
    assert.deepEqual(crumbsOf("D:\\", "C:\\Users\\me"), [{ name: "D:\\", path: "D:\\" }]);

    assert.deepEqual(crumbsOf("D:\\AI Proj\\Android", "C:\\Users\\me"), [
        { name: "D:\\", path: "D:\\" },
        { name: "AI Proj", path: "D:/AI Proj" },
        { name: "Android", path: "D:/AI Proj/Android" },
    ]);

    // The same path with a forward slash, as a typed one is just as likely to be.
    assert.deepEqual(crumbsOf("D:/AI Proj", "C:\\Users\\me"), [
        { name: "D:/", path: "D:/" },
        { name: "AI Proj", path: "D:/AI Proj" },
    ]);
});

test("the breadcrumbs of a path under home or the root are as they were", () => {
    assert.deepEqual(crumbsOf("/srv/app", "/home/me"), [
        { name: "/", path: "/" },
        { name: "srv", path: "/srv" },
        { name: "app", path: "/srv/app" },
    ]);

    assert.deepEqual(crumbsOf("/home/me/code", "/home/me"), [
        { name: "~", path: "/home/me" },
        { name: "code", path: "/home/me/code" },
    ]);

    // A Windows home reads as ~ too, though it sits on a drive.
    assert.deepEqual(crumbsOf("C:\\Users\\me", "C:\\Users\\me"), [
        { name: "~", path: "C:\\Users\\me" },
    ]);
});

test("a name is added to a folder's path", () => {
    assert.equal(joined("/a", "b"), "/a/b");
    assert.equal(joined("/", "b"), "/b");
    assert.equal(joined("/a/", "/b"), "/a/b");
    // Windows: the server takes either separator, so the child is the same folder.
    assert.equal(joined("D:\\AI Proj", "Android"), "D:\\AI Proj/Android");
});
