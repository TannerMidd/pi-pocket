/**
 * A clock tool, and a /clock-zone command that sets the time zone it uses in a session. An example drop-in extension:
 * copy it into `~/.pi-pocket/extensions/`, then turn it on in Menu → Extensions.
 */
import { Type } from "@earendil-works/pi-ai";
import { defineDoc, defineExtension, defineTool } from "@earendil-works/pi-durable";
// A type import is gone when the module runs. In the drop-in folder, import the types from "./_pocket.d.ts".
import type { Web } from "../../types/pocket.d.ts";

/** Each session's time zone, as /clock-zone set it. A document kind is stored data: named after the module. */
const ClockSettings = defineDoc<{ zone?: string }>({
    kind: "x.clock.settings",
    version: 1,
    scope: "conversation",
    history: "latest",
    fork: "current",
    initial: () => ({}),
});

const clock = defineTool({
    name: "clock",
    description:
        "The date and time now, in a time zone such as Europe/Berlin (by default, the session's or the server's).",
    parameters: Type.Object({
        zone: Type.Optional(
            Type.String({ description: "An IANA time zone, such as America/Chicago" }),
        ),
    }),
    // It only reads the clock: running it again after a restart cut it off is harmless.
    replay: "safe",
    execute: async (args, api, context) => {
        const zone =
            args.zone ??
            (await api.snapshot(ClockSettings, api.conversationId, context))?.zone ??
            Intl.DateTimeFormat().resolvedOptions().timeZone;
        let now: string;

        try {
            now = new Date().toLocaleString("en-US", {
                timeZone: zone,
                dateStyle: "full",
                timeStyle: "long",
            });
        } catch {
            // Thrown, it becomes an error result the model reads.
            throw new Error(`There is no time zone ${zone}.`);
        }

        return { content: [{ type: "text" as const, text: `${now} (${zone})` }] };
    },
});

/** A time zone's name, when the clock knows it. */
function known(zone: string): boolean {
    try {
        new Intl.DateTimeFormat("en-US", { timeZone: zone });

        return true;
    } catch {
        return false;
    }
}

export default function createClock(_host: unknown, web: Web) {
    // `/clock-zone` shows the session's time zone, and `/clock-zone Europe/Berlin` sets it, without asking Pi.
    web.command("clock-zone", {
        description: "Show or set this session's time zone for the clock",
        args: "[zone]",
        scope: "conversation",
        handler: async (args, ctx) => {
            const zone = args.trim();

            if (zone === "") {
                const settings = await ctx.snapshot(ClockSettings, ctx.conversationId, ctx.context);

                return {
                    type: "card",
                    output: `Clock time zone: ${settings?.zone ?? Intl.DateTimeFormat().resolvedOptions().timeZone}`,
                };
            }

            // An error made with web.error reaches the person who ran the command; others say only that it failed.
            if (!known(zone)) {
                throw web.error(400, `There is no time zone ${zone}.`);
            }

            await ctx.commit(async (tx) => {
                (await tx.doc(ClockSettings, ctx.conversationId)).zone = zone;
            });

            return { type: "toast", level: "info", message: `Clock time zone set to ${zone}.` };
        },
    });

    return defineExtension({ name: "example-clock", tools: [clock] });
}
