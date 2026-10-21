/** Pi Pocket's versions, compared: the gallery's entries and theme folders both name the oldest they work with. */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { APP_ROOT } from "./config.ts";

/** Pi Pocket's own package: its version, and the packages a drop-in can import by name. */
export const pocketPackage: { version?: string; dependencies?: Record<string, string> } = (() => {
    try {
        return JSON.parse(readFileSync(join(APP_ROOT, "package.json"), "utf8")) as {
            version?: string;
            dependencies?: Record<string, string>;
        };
    } catch {
        return {};
    }
})();

/** This Pi Pocket's version, from its package. */
export const pocketVersion = (): string => pocketPackage.version ?? "0.0.0";

/** A Pi Pocket version: `0.14.0`. */
export const POCKET_VERSION = /^(\d{1,4})\.(\d{1,4})\.(\d{1,4})$/;

/** The parts of a Pi Pocket version, `0.14.0`, or undefined. Pre-releases count as their release (`0.14.0-beta.3`). */
export function versionParts(version: string): [number, number, number] | undefined {
    const match = POCKET_VERSION.exec(version.replace(/[-+].*$/, ""));

    return match === null ? undefined : [Number(match[1]), Number(match[2]), Number(match[3])];
}

/** Whether Pi Pocket `version` is `minimum` or newer. */
export function atLeast(version: string, minimum: string): boolean {
    const have = versionParts(version);
    const need = versionParts(minimum);

    if (have === undefined || need === undefined) {
        return false;
    }

    for (let at = 0; at < 3; at++) {
        if (have[at] !== need[at]) {
            return have[at]! > need[at]!;
        }
    }

    return true;
}
