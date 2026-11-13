// Reply hooks, the pure parts: a reply address must be https, or http to this machine; a reply is signed over its
// timestamp and body, and a signature that is old, changed, or made with another secret does not pass.
import assert from "node:assert/strict";
import { test } from "node:test";
import {
    MAX_REPLY_TEXT,
    REPLY_SKEW_MS,
    replyBody,
    replyUrlProblem,
    signReply,
    verifyReply,
} from "../src/server/reply-hooks.ts";

test("a reply address is https, or http to this machine only", () => {
    assert.equal(replyUrlProblem("https://bridge.example.com/reply"), undefined);
    assert.equal(replyUrlProblem("http://127.0.0.1:8787/v1/reply"), undefined);
    assert.equal(replyUrlProblem("http://localhost:8787/v1/reply"), undefined);
    assert.equal(replyUrlProblem("http://[::1]:8787/v1/reply"), undefined);
    assert.ok(replyUrlProblem("http://example.com/reply"));
    assert.ok(replyUrlProblem("ftp://127.0.0.1/reply"));
    assert.ok(replyUrlProblem("https://user:pw@example.com/reply"));
    assert.ok(replyUrlProblem("https://example.com/reply?token=1"));
    assert.ok(replyUrlProblem("https://example.com/reply#x"));
    assert.ok(replyUrlProblem("not a url"));
    assert.ok(replyUrlProblem(""));
    assert.ok(replyUrlProblem(42));
});

test("a signature passes only with the same secret, timestamp, and body", () => {
    const secret = "s".repeat(32);
    const now = 1_800_000_000_000;
    const body = replyBody({
        hook: "h",
        request: "request",
        session: 3,
        entry: "e1",
        text: "answer",
    });
    const sig = signReply(secret, now, body);

    assert.match(sig, /^sha256=[0-9a-f]{64}$/);
    assert.equal(verifyReply(secret, now, body, sig, now), true);
    assert.equal(verifyReply("t".repeat(32), now, body, sig, now), false);
    assert.equal(verifyReply(secret, now + 1, body, sig, now), false);
    assert.equal(verifyReply(secret, now, body.replace("answer", "other"), sig, now), false);
    assert.equal(verifyReply(secret, now, body, sig.slice(0, -1), now), false);
});

test("an old or future timestamp is refused, so a payload cannot be replayed", () => {
    const secret = "s".repeat(32);
    const now = 1_800_000_000_000;
    const body = "{}";
    const old = now - REPLY_SKEW_MS - 1;

    assert.equal(verifyReply(secret, old, body, signReply(secret, old, body), now), false);
    const later = now + REPLY_SKEW_MS + 1;

    assert.equal(verifyReply(secret, later, body, signReply(secret, later, body), now), false);
    assert.equal(verifyReply(secret, Number.NaN, body, "sha256=x", now), false);
});

test("a long answer is cut and marked, a short one is whole", () => {
    const short = JSON.parse(
        replyBody({ hook: "h", request: "request", session: 1, entry: "e", text: "hi" }),
    );

    assert.deepEqual(short, {
        hook: "h",
        request: "request",
        session: 1,
        entry: "e",
        text: "hi",
        truncated: false,
    });

    const long = JSON.parse(
        replyBody({
            hook: "h",
            request: "request",
            session: 1,
            entry: "e",
            text: "x".repeat(MAX_REPLY_TEXT + 5),
        }),
    );

    assert.equal(long.text.length, MAX_REPLY_TEXT);
    assert.equal(long.truncated, true);
});
