/**
 * Time gap: tells Pi how long a session was quiet when a person writes after a long silence.
 */
import type { Host, Turn, Web } from "../../types/pocket.d.ts";

const HOUR = 3_600_000;

function gap(turn: Turn): string | undefined {
    if (turn.previousActivityAt === undefined) {
        return undefined;
    }

    const hours = (turn.at - turn.previousActivityAt) / HOUR;

    if (hours < 3) {
        return undefined;
    }

    const days = Math.round(hours / 24);

    return hours < 36 ? `About ${Math.round(hours)} hours` : `About ${days} days`;
}

export default function createTimeGap(host: Host, web: Web) {
    // A server older than 0.30.0 has no turn notes: do nothing there.
    if (typeof host.annotateTurns !== "function") {
        return;
    }

    web.onDispose(
        host.annotateTurns("time-gap", (turn) => {
            const passed = gap(turn);

            return passed === undefined
                ? undefined
                : `<system-reminder>\n${passed} have passed since the previous message.\n</system-reminder>`;
        }),
    );
}
