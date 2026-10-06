/**
 * Request ids of messages to Pi say whose each message is, and they are stored durably with Pi Durable's record of
 * the message. `u:<user id>:<key>` is a person's own message. `p:<user id>:<key>` is a message Pi Pocket sends for a
 * person, such as a scheduled message Pi set up or a subagent's task. A request id is unique in its conversation, so
 * a message retried with the same one is not sent twice.
 */
import { randomUUID } from "node:crypto";

/** The key a browser gave a request it may retry, made safe for an id; a new one when it gave none. */
export const clientKey = (key: string) =>
    key.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 64) || randomUUID();

/** A person's own message. */
export const ownRequest = (userId: string, key: string) => `u:${userId}:${key}`;

/** A message Pi Pocket sends for a person: they did not write it, but Pi works for them on it. */
export const requestFor = (userId: string, key: string) => `p:${userId}:${key}`;

/** Whose a message is, from its request id, and whether they wrote it. Undefined for messages that are nobody's. */
export function requestPerson(
    requestId: string | undefined,
): { userId: string; wrote: boolean } | undefined {
    const match = /^([up]):([^:]+):/.exec(requestId ?? "");

    return match === null ? undefined : { userId: match[2]!, wrote: match[1] === "u" };
}
