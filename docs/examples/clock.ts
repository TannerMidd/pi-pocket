/**
 * A clock tool: the date and time now, in any time zone. An example drop-in extension: copy it into
 * `~/.pi-pocket/extensions/`, then turn it on in Menu → Extensions.
 */
import { Type } from "@earendil-works/pi-ai";
import { defineExtension, defineTool } from "@earendil-works/pi-durable";

const clock = defineTool({
    name: "clock",
    description:
        "The date and time now, in a time zone such as Europe/Berlin (by default, the server's).",
    parameters: Type.Object({
        zone: Type.Optional(
            Type.String({ description: "An IANA time zone, such as America/Chicago" }),
        ),
    }),
    // It only reads the clock: running it again after a restart cut it off is harmless.
    replay: "safe",
    execute: async (args) => {
        const zone = args.zone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
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

// The host (what Pi Pocket gives its extensions) is the first argument; this one needs nothing from it.
export default function createClock() {
    return defineExtension({ name: "example-clock", tools: [clock] });
}
