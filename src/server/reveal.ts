/**
 * Show a file in a file manager (Files, Dolphin, Finder, Explorer), selected in its folder; a folder opens itself. For
 * the owner: a Ctrl+click on a path (`web/ui.js`). A session's own machine shows it: this one, or for a session on
 * another computer, that computer (`revealOn`), where its runner runs the same commands.
 */
import { spawn } from "node:child_process";
import { statSync } from "node:fs";
import { dirname } from "node:path";
import { pathToFileURL } from "node:url";
import { HttpError } from "./errors.ts";

/** A command to run, and the arguments: never through a shell. */
export type Command = [string, string[]];

/** How to show `path` on this platform: the commands to try in turn, the first that runs wins. */
export function revealCommands(
    path: string,
    folder: boolean,
    platform: NodeJS.Platform = process.platform,
): Command[] {
    if (platform === "darwin") {
        return [folder ? ["open", [path]] : ["open", ["-R", path]]];
    }

    if (platform === "win32") {
        return [folder ? ["explorer.exe", [path]] : ["explorer.exe", [`/select,${path}`]]];
    }

    // The freedesktop file manager interface selects the file in its folder (Files, Dolphin, Thunar, Nemo); without it,
    // the folder opens.
    const showItems: Command = [
        "gdbus",
        [
            "call",
            "--session",
            "--dest",
            "org.freedesktop.FileManager1",
            "--object-path",
            "/org/freedesktop/FileManager1",
            "--method",
            folder
                ? "org.freedesktop.FileManager1.ShowFolders"
                : "org.freedesktop.FileManager1.ShowItems",
            `['${pathToFileURL(path).href.replace(/'/g, "%27")}']`,
            "",
        ],
    ];

    return [showItems, ["xdg-open", [folder ? path : dirname(path)]]];
}

/** Run one command to its end, or 5 seconds: whether it worked. */
function run([command, args]: Command): Promise<boolean> {
    return new Promise((resolve) => {
        const child = spawn(command, args, { stdio: "ignore", windowsHide: true });
        const timer = setTimeout(() => {
            child.kill();
            resolve(false);
        }, 5000);

        child.on("error", () => {
            clearTimeout(timer);
            resolve(false);
        });
        child.on("exit", (code) => {
            clearTimeout(timer);
            // Explorer answers 1 even when it showed the file.
            resolve(code === 0 || command === "explorer.exe");
        });
    });
}

/** Whether this machine has a desktop to show a file manager on: a Mac or Windows does; Linux needs a display. */
export function hasDesktop(env = process.env, platform: NodeJS.Platform = process.platform) {
    return platform !== "linux" || Boolean(env.WAYLAND_DISPLAY || env.DISPLAY);
}

/**
 * Show an absolute path in the file manager. Throws 404 when it is not there, 409 when nothing can show it. `runner`
 * runs each command: tests give their own, so no window opens.
 */
export async function reveal(
    path: string,
    runner: (command: Command) => Promise<boolean> = run,
): Promise<void> {
    let folder: boolean;

    try {
        folder = statSync(path).isDirectory();
    } catch {
        throw new HttpError(404, `${path} is not there`);
    }

    if (!hasDesktop()) {
        throw new HttpError(409, "The server has no desktop to show it on");
    }

    for (const command of revealCommands(path, folder)) {
        if (await runner(command)) {
            return;
        }
    }

    throw new HttpError(409, "No file manager could show it");
}

/** The Node platform name of a runner's system, as pi-env's `hello` names it. */
export function platformOf(os: string): NodeJS.Platform {
    return os === "macos" ? "darwin" : os === "windows" ? "win32" : "linux";
}

/**
 * Show a path on another computer, in its file manager: `run` runs each command there (its runner), and says whether
 * it worked. A computer without a desktop (a headless server) has nothing that works: a 409 that names it.
 */
export async function revealOn(
    computer: string,
    path: string,
    folder: boolean,
    os: string,
    run: (command: Command) => Promise<boolean>,
): Promise<void> {
    for (const command of revealCommands(path, folder, platformOf(os))) {
        if (await run(command)) {
            return;
        }
    }

    throw new HttpError(
        409,
        `No file manager on ${computer} could show it. Its runner may have no desktop session there.`,
    );
}
