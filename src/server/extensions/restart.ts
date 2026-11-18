/**
 * Restart tool lets Pi restart the server when a change needs it (Pi Pocket's own server code, or a file an extension
 * module imports), in a session where it works for the owner. The restart waits until no call runs that it would cut
 * off, Pi's own aside (`restart.ts`), and holds new model requests meanwhile; Pi's next request goes out after the
 * restart. Off until the owner turns it on.
 */
import { obj, opt, str } from "@earendil-works/pi-schema";
import { defineExtension, defineTool, section } from "@earendil-works/pi-durable";
import type { PocketHost } from "../host.ts";

const GUIDE = `After a change that needs a restart, once its checks pass: call restart_server instead of asking the person to restart. The restart waits until no other call runs that it would cut off; then the server restarts, and your run goes on after it. End your turn right after the call: start no other tool call, as it would make the restart wait for it. Never restart for a change that does not need it. A change to Pi Pocket's server code needs one, and so does a change to a file an extension module imports, as only the module's own file loads again. A web file, an extension module's own file, a theme, or a setting does not: those load again by themselves.`;

export default function createRestart(host: PocketHost) {
    // A server from before restart when safe: its next start has it.
    if (host.restartWhenSafe === undefined) {
        return defineExtension({ name: "pocket-restart" });
    }

    const restartWhenSafe = host.restartWhenSafe.bind(host);

    const tool = defineTool({
        name: "restart_server",
        description:
            "Restart the Pi Pocket server, once no call runs that a restart would cut off (this one aside). New model requests wait meanwhile, yours too: your run goes on after the restart. Only where you work for the owner.",
        parameters: obj(
            {
                reason: opt(
                    str({ maxLength: 200, description: "Why, in a few words: for the log" }),
                ),
            },
            { open: true },
        ),
        // Not replay-safe on purpose: a rerun after the very restart it asked for would ask for another.
        replay: "unsafe",
        execute: async (args, api) => {
            const answer = await restartWhenSafe(api.conversationId, api.callId, args.reason);
            // This call is one of them until its result is stored.
            const others = (answer.pending?.blockers ?? []).filter(
                (each) => each.callId !== api.callId,
            );
            const deadline = answer.pending?.deadline;
            const text =
                answer.restarting || others.length === 0
                    ? "The server restarts in a moment. End your turn now; your run goes on after the restart."
                    : `The server restarts once these calls end: ${others.map((each) => each.tool).join(", ")}${deadline === undefined ? "" : `, or at ${new Date(deadline).toISOString().slice(11, 16)} UTC at the latest`}. End your turn now and start no other call.`;

            return { output: [{ type: "text" as const, text }] };
        },
    });

    return defineExtension({
        name: "pocket-restart",
        tools: [tool],
        sections: [section("restart", () => GUIDE)],
    });
}
