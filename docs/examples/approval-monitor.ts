/**
 * Reports approval waits, then shows a notice when a wait starts or ends. Copy this drop-in into
 * `~/.pi-pocket/extensions/` and turn it on in Menu → Extensions. Call `approval_status` in a source session first.
 */
import { obj } from "@earendil-works/pi-schema";
import { type ConversationId, defineExtension, defineTool } from "@earendil-works/pi-durable";
// In the drop-in folder, import these types from "./_pocket.d.ts".
import type { Host, Web } from "../../types/pocket.d.ts";

export const pocketApi = 2;

export default function createApprovalMonitor(host: Host, web: Web) {
    const approvals = host.pendingApprovals;
    const watching = new Set<ConversationId>();
    const disposers: (() => void)[] = [];

    web.onDispose(() => {
        for (const dispose of disposers) {
            dispose();
        }
    });

    return defineExtension({
        name: "approval-monitor",
        tools: [
            Object.assign(
                defineTool({
                    name: "approval_status",
                    description:
                        "List visible approval waits and watch for human decisions. Never answers a card.",
                    parameters: obj({}),
                    replay: "safe",
                    execute: async (_args, api) => {
                        if (approvals === undefined) {
                            return {
                                output: [
                                    {
                                        type: "text",
                                        text: "Approval waits are not available on this server.",
                                    },
                                ],
                            };
                        }

                        const source = api.conversationId;

                        if (!watching.has(source)) {
                            // Subscribe first. A snapshot reconciles state; events alone are not a restart log.
                            disposers.push(
                                approvals.on(source, "created", (approval) => {
                                    host.notice(
                                        "info",
                                        `Waiting for a person: ${approval.summary}`,
                                        source,
                                    );
                                }),
                                approvals.on(source, "resolved", (approval) => {
                                    host.notice(
                                        "info",
                                        `Approval wait ended: ${approval.outcome}`,
                                        source,
                                    );
                                }),
                            );
                            watching.add(source);
                        }

                        return {
                            output: [
                                {
                                    type: "text",
                                    text: JSON.stringify(approvals.list(source)),
                                },
                            ],
                        };
                    },
                }),
                { annotations: { readOnlyHint: true } },
            ),
        ],
    });
}
