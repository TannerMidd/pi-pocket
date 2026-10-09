/**
 * A clock tool with a preferred time zone for each session. Copy it into `~/.pi-pocket/extensions/`,
 * turn it on in Menu → Extensions, then use /clock-zone to see or change the preference without asking Pi.
 */
import { Type } from "@earendil-works/pi-ai";
import { defineDoc, defineExtension, defineTool } from "@earendil-works/pi-durable";
import type { PocketHost } from "../../src/server/host.ts";

const ClockSettings = defineDoc<{ zone?: string }>({
    kind: "example.clock-settings",
    version: 1,
    scope: "conversation",
    history: "latest",
    fork: "current",
    initial: () => ({}),
});

const clock = defineTool({
    name: "clock",
    description:
        "The date and time now, in a time zone such as Europe/Berlin (by default, this session's preference or the server's).",
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

export default function createClock(host: PocketHost) {
    host.commands.register({
        name: "clock-zone",
        description: "Show or set this session's preferred time zone",
        args: "[zone]",
        scope: "conversation",
        handler: async (args, ctx) => {
            const zone = args.trim();

            if (zone === "") {
                const settings = await ctx.snapshot(ClockSettings, ctx.conversationId, ctx.context);
                const current = settings?.zone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;

                return { type: "card", output: `Clock time zone: ${current}` };
            }

            try {
                new Intl.DateTimeFormat("en-US", { timeZone: zone }).format();
            } catch {
                throw new Error(`There is no time zone ${zone}.`);
            }

            await ctx.commit(async (tx) => {
                const settings = await tx.doc(ClockSettings, ctx.conversationId);

                settings.zone = zone;
            });

            return { type: "toast", level: "info", message: `Clock time zone set to ${zone}.` };
        },
    });

    return defineExtension({ name: "example-clock", tools: [clock] });
}
