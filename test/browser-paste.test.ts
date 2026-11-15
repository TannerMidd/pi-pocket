// A paste reaches the Browser panel's page only while the screen has the focus (web/browser-paste.js).
import assert from "node:assert/strict";
import { test } from "node:test";

const { screenPaste } = (await import(
    new URL("../web/browser-paste.js", import.meta.url).href
)) as {
    screenPaste(event: unknown, screen: unknown, active: unknown): string | null;
};
const paste = (text: string) => ({ clipboardData: { getData: () => text } });

test("a paste is the page's only while the screen has the focus and the paste has text", () => {
    const screen = {};

    assert.equal(screenPaste(paste("123456"), screen, screen), "123456");
    assert.equal(screenPaste(paste("123456"), screen, {}), null);
    assert.equal(screenPaste(paste(""), screen, screen), null);
});
