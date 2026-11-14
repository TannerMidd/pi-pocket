/**
 * Reply hooks: the outgoing half of a webhook. When a session answers a post that a hook sent, Pi Pocket POSTs the
 * answer to the hook's reply address, signed with the hook's reply secret. This file has the pure parts only: the
 * address rules, the signature, its check, and the payload. Delivery lives in `reply-delivery.ts`.
 */
import { createHmac, timingSafeEqual } from "node:crypto";

/** Longest reply text sent in one payload. A longer answer is cut, and the payload says so. */
export const MAX_REPLY_TEXT = 60_000;

/** How far a signed timestamp may differ from the receiver's clock. */
export const REPLY_SKEW_MS = 5 * 60_000;

const LOOPBACK = new Set(["127.0.0.1", "[::1]", "localhost"]);

/**
 * The address a reply goes to. `https` for any host; `http` only to this machine (the bridge runs on loopback). No
 * credentials, no query, no fragment. Returns the problem, or `undefined` when the address is fine.
 */
export function replyUrlProblem(raw: unknown): string | undefined {
    if (typeof raw !== "string" || raw.length === 0 || raw.length > 2048) {
        return "Give a reply address, up to 2048 characters.";
    }

    let url: URL;

    try {
        url = new URL(raw);
    } catch {
        return "The reply address is not a valid URL.";
    }

    if (url.username !== "" || url.password !== "") {
        return "The reply address must not hold a username or password.";
    }

    if (url.search !== "" || url.hash !== "") {
        return "The reply address must not hold a query or a fragment.";
    }

    if (url.protocol === "https:") {
        return undefined;
    }

    if (url.protocol === "http:" && LOOPBACK.has(url.hostname)) {
        return undefined;
    }

    return "Reply addresses use https, or http to this machine only.";
}

/** The signature header value: `sha256=` and the hex HMAC of `<timestamp>.<body>`. */
export function signReply(secret: string, timestamp: number, body: string): string {
    return `sha256=${createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex")}`;
}

/**
 * Checks a signature from a reply. The receiver calls this. A timestamp far from `now` is refused, so an old payload
 * cannot be replayed later.
 */
export function verifyReply(
    secret: string,
    timestamp: number,
    body: string,
    signature: string,
    now: number,
): boolean {
    if (!Number.isFinite(timestamp) || Math.abs(now - timestamp) > REPLY_SKEW_MS) {
        return false;
    }

    const expected = Buffer.from(signReply(secret, timestamp, body));
    const given = Buffer.from(signature);

    return expected.length === given.length && timingSafeEqual(expected, given);
}

/** A reply names the original delivery key and the exact answer entry. Derived replies set `protocol: 2`. */
export type ReplyPayload = {
    /** Present only for a derived follow-up receipt. */
    protocol?: 2;
    hook: string;
    request: string;
    session: number;
    entry: string;
    text: string;
    truncated: boolean;
};

/** The JSON body of a reply, with its text cut to `MAX_REPLY_TEXT` characters at most. */
export function replyBody(payload: Omit<ReplyPayload, "truncated">): string {
    const truncated = payload.text.length > MAX_REPLY_TEXT;
    const body: ReplyPayload = {
        ...payload,
        text: truncated ? payload.text.slice(0, MAX_REPLY_TEXT) : payload.text,
        truncated,
    };

    return JSON.stringify(body);
}
