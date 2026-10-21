/**
 * Triggers start work from outside the app: a PR watch tells Pi when its pull request's checks fail, it has conflicts,
 * or reviewers comment, until it is merged; repository watches tell PiP what happens on the owner's repositories;
 * webhooks turn posts from other services into messages to a session or to PiP. While this is off, watches wait and
 * webhooks answer 503.
 */
import { Type } from "@earendil-works/pi-ai";
import { defineExtension, defineTool } from "@earendil-works/pi-durable";
import type { PrWatch } from "../docs.ts";
import { quoted } from "../fence.ts";
import type { PocketHost } from "../host.ts";
import { endedText, MAX_SENT, TRIGGERS_EXTENSION, WATCH_VIA } from "../watches.ts";

const reply = (text: string) => ({ output: [{ type: "text" as const, text }] });

/** A watch in a line, as Pi reads it: a note with no failed look says why it waits. */
export function describeWatch(watch: PrWatch): string {
    const head = `PR #${watch.number} ${quoted(watch.title)} (${watch.url})`;

    if (watch.status !== "watching") {
        return `${head}: watched ${endedText(watch)}.`;
    }

    const checks =
        watch.checks === undefined || watch.checks === "none"
            ? ""
            : `, checks ${watch.checks === "pending" ? "running" : watch.checks}`;

    const note = watch.note?.replace(/\.$/, "");

    const unchecked =
        watch.unchecked === true
            ? `; only the repository owner's comments count: gh's account cannot push to ${watch.repo}, so GitHub does not tell it who else can write there`
            : "";

    return `${head}: watching${checks}, ${watch.sent} of ${watch.max} messages sent${unchecked}${note === undefined ? "" : watch.errors > 0 ? `; last look failed: ${note}` : `; waiting: ${note}`}.`;
}

export default function createTriggers(host: PocketHost) {
    const watchPr = defineTool({
        name: "watch_pr",
        description:
            `Watch this session's pull request on GitHub until it is merged or closed: when its checks fail (with their logs), it has conflicts, or reviewers comment, you get a message starting "[via ${WATCH_VIA}]". ` +
            `Start it after you open a PR (gh pr create) when the person wants it seen through. At most ${MAX_SENT} messages. Actions: start (pr: its number in this folder's repository, or the address or owner/name#12 of one in another repository you can push to; default the PR of the current branch), status, stop.`,
        parameters: Type.Object({
            action: Type.Union([
                Type.Literal("start"),
                Type.Literal("status"),
                Type.Literal("stop"),
            ]),
            pr: Type.Optional(
                Type.String({
                    description:
                        "start: the PR's number, address, or owner/name#12; default the current branch's",
                }),
            ),
        }),
        // Safe to run again: a start finds the watch this very call made, status only reads, and stopping twice is
        // stopping once.
        replay: "safe",
        execute: async (args, api) => {
            if (args.action === "status") {
                const watch = await host.watches.get(api.conversationId);

                return reply(
                    watch === undefined ? "No pull request is watched here." : describeWatch(watch),
                );
            }

            if (args.action === "stop") {
                const watch = await host.watches.stop(api.conversationId);

                return reply(
                    watch === undefined
                        ? "No pull request was watched here."
                        : `Stopped watching PR #${watch.number}.`,
                );
            }

            const watch = await host.watches.start(
                api.conversationId,
                host.requesterOf(api.conversationId),
                {
                    ...(args.pr === undefined ? {} : { pr: args.pr }),
                    byPi: true,
                    key: `${String(api.taskId)}:${api.callId}`,
                },
            );

            return reply(
                `Watching PR #${watch.number} ${quoted(watch.title)}. Messages come when its checks fail, it has conflicts, or reviewers comment; it stops when the PR is merged or closed.`,
            );
        },
    });

    // A server started before repository watches has none to run: they come with its restart.
    const repoWatches = (host as Partial<PocketHost>).repoWatches;

    return defineExtension({
        name: TRIGGERS_EXTENSION,
        tasks: [host.watches.task, ...(repoWatches === undefined ? [] : [repoWatches.task])],
        tools: [watchPr],
    });
}
