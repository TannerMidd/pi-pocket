/** Finding a Chromium-based browser on this machine, and where its profile goes. */
import { createHash } from "node:crypto";
import { closeSync, openSync, readdirSync, readSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, delimiter, join } from "node:path";

const isFile = (path: string) => {
    try {
        return statSync(path).isFile();
    } catch {
        return false;
    }
};

/** The newest Playwright download of Chromium, if there is one. */
function playwrightChromium(): string | undefined {
    const root =
        process.env.PLAYWRIGHT_BROWSERS_PATH ??
        (process.platform === "darwin"
            ? join(homedir(), "Library", "Caches", "ms-playwright")
            : process.platform === "win32"
              ? join(process.env.LOCALAPPDATA ?? homedir(), "ms-playwright")
              : join(homedir(), ".cache", "ms-playwright"));
    let folders: string[];

    try {
        folders = readdirSync(root).filter((name) => /^chromium-\d+$/.test(name));
    } catch {
        return undefined;
    }

    folders.sort((a, b) => Number(b.split("-")[1]) - Number(a.split("-")[1]));

    for (const folder of folders) {
        for (const path of [
            join(root, folder, "chrome-linux64", "chrome"),
            join(root, folder, "chrome-linux", "chrome"),
            join(root, folder, "chrome-mac", "Chromium.app", "Contents", "MacOS", "Chromium"),
            join(root, folder, "chrome-mac-arm64", "Chromium.app", "Contents", "MacOS", "Chromium"),
            join(root, folder, "chrome-win", "chrome.exe"),
            join(root, folder, "chrome-win64", "chrome.exe"),
        ]) {
            if (isFile(path)) {
                return path;
            }
        }
    }

    return undefined;
}

/** Where snapd puts the commands that run snaps. */
const SNAP_BIN = "/snap/bin";

/**
 * The snap a browser command runs, if it is one: `/snap/bin/chromium`, or a script that runs one, as Ubuntu's
 * `/usr/bin/chromium-browser` is. `command` is what to run: the snap's own command, which the script would run.
 */
export function snapOf(
    path: string,
    snapBin = SNAP_BIN,
): { name: string; command: string } | undefined {
    if (path.startsWith(`${snapBin}/`)) {
        return { name: basename(path), command: path };
    }

    if (path.startsWith("/snap/")) {
        return { name: path.split("/")[2] ?? "", command: path };
    }

    let head = "";

    try {
        const fd = openSync(path, "r");

        try {
            const buffer = Buffer.alloc(4096);

            head = buffer.subarray(0, readSync(fd, buffer, 0, buffer.length, 0)).toString("latin1");
        } finally {
            closeSync(fd);
        }
    } catch {
        return undefined;
    }

    if (!head.startsWith("#!")) {
        return undefined;
    }

    const escaped = snapBin.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const name = new RegExp(`${escaped}/([\\w.-]+)`).exec(head)?.[1];

    return name === undefined ? undefined : { name, command: join(snapBin, name) };
}

/**
 * Where the browser keeps its profile. A snap may not write to hidden folders in the home folder, as the data folder
 * usually is (`~/.pi-pocket`): its profile goes in the snap's own folder instead, one per data folder.
 */
export function profileFolder(executable: string, dataDir: string, snapBin = SNAP_BIN): string {
    const snap = snapOf(executable, snapBin);

    if (snap === undefined) {
        return join(dataDir, "browser", "profile");
    }

    const id = createHash("sha256").update(dataDir).digest("hex").slice(0, 12);

    return join(homedir(), "snap", snap.name, "common", "pi-pocket", id);
}

/**
 * A Chromium-based browser to run: `PI_POCKET_BROWSER` if set, else Chromium, Chrome, Brave, or Edge where they are
 * usually installed, else a Playwright download. On Linux the real Chromium binary comes before the launcher scripts
 * distributions put on the PATH, which add the desktop's own flags and extensions. A snap comes last (Ubuntu's
 * Chromium is one): it cannot open files outside the home folder, so a browser installed otherwise is the better choice.
 */
export function findBrowser(
    env: NodeJS.ProcessEnv = process.env,
    options: { snapBin?: string; places?: readonly string[] } = {},
): string | undefined {
    const configured = env.PI_POCKET_BROWSER?.trim();

    if (configured) {
        return isFile(configured) ? configured : undefined;
    }

    const snapBin = options.snapBin ?? SNAP_BIN;
    const candidates = [...(options.places ?? installPlaces(env))];
    const names = [
        "chromium",
        "chromium-browser",
        "google-chrome-stable",
        "google-chrome",
        "brave-browser",
        "brave",
        "microsoft-edge-stable",
        "microsoft-edge",
    ];
    const extension = process.platform === "win32" ? ".exe" : "";

    for (const folder of (env.PATH ?? "").split(delimiter)) {
        if (folder === "") {
            continue;
        }

        for (const name of names) {
            candidates.push(join(folder, name + extension));
        }
    }

    let snap: string | undefined;

    for (const candidate of candidates) {
        if (!isFile(candidate)) {
            continue;
        }

        const found = process.platform === "linux" ? snapOf(candidate, snapBin) : undefined;

        if (found === undefined) {
            return candidate;
        }

        // A script for a snap that is not installed only says so.
        if (snap === undefined && isFile(found.command)) {
            snap = found.command;
        }
    }

    return playwrightChromium() ?? snap;
}

/** Where browsers are usually installed on this system, besides the PATH. */
function installPlaces(env: NodeJS.ProcessEnv): string[] {
    const candidates: string[] = [];

    if (process.platform === "darwin") {
        // Installed for everyone, or for this user alone.
        for (const folder of ["/Applications", join(homedir(), "Applications")]) {
            for (const app of ["Google Chrome", "Chromium", "Brave Browser", "Microsoft Edge"]) {
                candidates.push(join(folder, `${app}.app`, "Contents", "MacOS", app));
            }
        }
    } else if (process.platform === "win32") {
        for (const base of [env.PROGRAMFILES, env["PROGRAMFILES(X86)"], env.LOCALAPPDATA]) {
            if (base === undefined) {
                continue;
            }

            candidates.push(
                join(base, "Google", "Chrome", "Application", "chrome.exe"),
                join(base, "Chromium", "Application", "chrome.exe"),
                join(base, "Microsoft", "Edge", "Application", "msedge.exe"),
            );
        }
    } else {
        candidates.push("/usr/lib/chromium/chromium", "/usr/lib/chromium-browser/chromium-browser");
    }

    return candidates;
}
