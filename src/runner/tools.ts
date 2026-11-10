/** Readiness of git and GitHub on this computer; informational only, never a condition for running sessions. */
import { execFile } from "node:child_process";
import type { RunnerTools } from "./protocol.ts";

/** A missing program, a failed check, or 5 s without an answer means it is not ready. */
function succeeds(program: string, args: string[]): Promise<boolean> {
    return new Promise((resolve) => {
        execFile(
            program,
            args,
            { timeout: 5000, killSignal: "SIGKILL", windowsHide: true },
            (error) => resolve(error === null),
        );
    });
}

/** Asked again before every connection, so installs and sign-ins show without restarting the runner. */
export async function checkTools(): Promise<RunnerTools> {
    const [git, gh] = await Promise.all([
        succeeds("git", ["--version"]),
        succeeds("gh", ["--version"]),
    ]);
    const github = await succeeds("gh", ["auth", "status"]);

    return { git, gh, github };
}

/** The same facts and remedies shown in the Runners sheet. */
export function toolsStatus(tools: RunnerTools, os: string): string {
    const git =
        os === "darwin"
            ? "xcode-select --install"
            : os === "windows" || os === "win32"
              ? "winget install Git.Git"
              : "sudo apt install git";
    const gh =
        os === "darwin"
            ? "brew install gh"
            : os === "windows" || os === "win32"
              ? "winget install GitHub.cli"
              : "https://github.com/cli/cli#installation";

    return [
        tools.git ? "git ✓" : `git not found: ${git}`,
        !tools.gh
            ? `GitHub: gh not found: ${gh}`
            : tools.github
              ? "GitHub ✓"
              : "GitHub: sign in with gh auth login",
    ].join(" · ");
}
