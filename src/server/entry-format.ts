/**
 * What Pi Pocket writes into stored conversations: the kinds of its own entries, and the markers it puts into message
 * text. Stored entries and the web app depend on these exact values: never change them.
 */

/** How a file sent along with a message starts (`<file name="path">`): such parts show as the file's name only. */
export const FILE_BLOCK = '<file name="';
/** The entry kind of a note about what a person did (`Commands.note`). */
export const NOTE_ENTRY = "pocket.note";

/** The speaker prefix Pi Pocket adds to messages when several people share the server. */
export const FROM_PREFIX = /^\[from: ([^\]\n]{1,60})\] /;

/** What separates a message from the list of files attached to it. The web app splits messages on it too. */
export const ATTACHMENTS_HEADING = "\n\nAttached files (saved on the server):\n";

/** The entry kind of a command someone ran. */
export const SHELL_ENTRY = "pocket.shell";

/**
 * The entry kind that ends a session continued from Pi in the terminal: what comes before it is Pi's. It gives the model
 * nothing; it carries the context edits Pi had made to that history.
 */
export const FROM_PI_ENTRY = "pocket.from-pi";

/** What that entry holds: the Pi session's id, its title, and its file. */
export type FromPiData = { session: string; title: string; file: string };

/** What a command's entry holds. */
export type ShellData = {
    command: string;
    by: string;
    name: string;
    /** Pi sees this command and its output. */
    context: boolean;
    output: string;
    /** Absent when the command did not get to exit. */
    code?: number;
    status: "done" | "timeout" | "failed" | "interrupted" | "stopped";
    /** The output was longer: this is its end. */
    clipped?: boolean;
    taskId: number;
};
