/**
 * Show a file in the file manager of the machine Pi Pocket runs on (Files, Dolphin, Finder, Explorer), selected in its
 * folder; a folder opens itself. For the owner at that machine: a Ctrl+click on a path (`web/ui.js`).
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
