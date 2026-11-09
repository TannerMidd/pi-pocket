/**
 * Voice output: reads Pi's answers aloud in this browser, from under an answer or as each one ends, with one voice
 * and one speed that the owner sets for every tab. It reads only Pi's answers, and it calls no other service.
 */
// Types only: at run time this module uses nothing of Pi Pocket's but the host and web, as a drop-in would.
import type { ExtensionWeb as Web, PocketHost } from "../../src/server/host.ts";

/** The voice names that the owner can pick. Each browser has its own list; "best" takes the first good English one. */
export const VOICES = [
    "best",
    "auto",
    "Google US English",
    "Google UK English Female",
    "Google UK English Male",
    "Samantha",
    "Alex",
    "Ava",
    "Zoe",
    "Daniel",
    "Karen",
    "Moira",
];

/** The first Pi Pocket with people's settings and the app's events: 0.22.0. */
function supported(version: string | undefined): boolean {
    const [major = 0, minor = 0] = (version ?? "0.0.0").split(".").map(Number);

    return major > 0 || minor >= 22;
}

export default function createVoiceOutput(host: PocketHost, web?: Web) {
    // A server that runs older code, which loaded this file as its checkout changed, has none of what this uses.
    if (web === undefined || !supported(host.pocketVersion) || typeof host.on !== "function") {
        return;
    }

    web.settings([
        {
            name: "voice",
            label: "Voice",
            description:
                "Best takes the first good English voice of this browser; Auto its own default.",
            type: "choice",
            default: "best",
            choices: VOICES.map((value) => ({ value, label: value })),
        },
        {
            name: "rate",
            label: "Speed",
            description: "1 is normal. 1.25 is a quarter faster.",
            type: "number",
            default: 1,
            min: 0.5,
            max: 2,
        },
    ]);

    web.client("voice-output");

    // A tab reads the session's new answers when its run ends, so it hears both ends of the run.
    const hear = (running: boolean) => (event: { conversationId: number }) =>
        web.send("running", { session: event.conversationId, running });

    web.onDispose(host.on("run.started", hear(true)));
    web.onDispose(host.on("run.ended", hear(false)));
}
