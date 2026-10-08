/**
 * No force-pushing: a bash call that force-pushes with git is blocked before it runs, and the system prompt says so.
 * An example drop-in extension with a hook and a prompt section: copy it into `~/.pi-pocket/extensions/`, then turn it
 * on in Menu → Extensions.
 */
import { defineExtension, hook, section, ToolTask } from "@earendil-works/pi-durable";

/** `git push` with `--force`, `--force-with-lease`, a short flag group with `f` (`-f`, `-uf`), or a `+branch` refspec. */
const FORCE_PUSH =
    /\bgit\b[^\n;&|]*\bpush\b[^\n;&|]*\s(--force(-with-lease)?\b|-[a-zA-Z]*f\b|\+\S)/;

export default function createNoForcePush() {
    return defineExtension({
        name: "example-no-force-push",
        // A section renders before every request; returning the same text keeps the provider's prompt cache warm.
        sections: [
            section(
                "no_force_push",
                () =>
                    "Do not force-push with git: such a bash call is blocked. Push normally, or ask the user to.",
            ),
        ],
        hooks: [
            hook(ToolTask, {
                // Runs before every tool call, a codemode script's calls too. A block becomes the call's error result.
                beforeTool: (call) => {
                    const command = (call.arguments as { command?: unknown }).command;

                    return call.name === "bash" &&
                        typeof command === "string" &&
                        FORCE_PUSH.test(command)
                        ? { block: "Force-pushing is turned off here (no-force-push extension)." }
                        : undefined;
                },
            }),
        ],
    });
}
