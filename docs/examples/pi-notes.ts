/**
 * Pi notes: notes kept beside Pi's sessions come along when one continues here. Next to a Pi session file
 * `<session>.jsonl`, a file `<session>.jsonl.notes.md` holds notes for it. When the owner continues that session in
 * Pi Pocket, this extension copies the notes into its own folder, and the system prompt of that session shows them.
 * An example drop-in extension with a Pi session companion: copy it into `~/.pi-pocket/extensions/`, then turn it on in
 * Menu → Extensions.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { defineExtension, section } from "@earendil-works/pi-durable";
import type { Host, Web } from "../../types/pocket.d.ts";
// A type import is gone when the module runs. In the drop-in folder, import the types from "./_pocket.d.ts".

/** The most of a notes file the prompt shows. */
const MAX_NOTES = 4_000;

export default function createPiNotes(host: Host, web: Web) {
    const folder = join(host.dataDir, "pi-notes");
    const notesOf = (conversationId: unknown) => join(folder, `${String(conversationId)}.md`);

    // A Pi Pocket from before companions: the extension still loads, and notes stay behind.
    if (typeof host.registerPiSessionCompanion === "function") {
        // Removed again when the module reloads or is turned off.
        web.onDispose(
            host.registerPiSessionCompanion({
                suffix: ".notes.md",
                label: "Notes",
                // Pi Pocket never reads the file: the extension does, and keeps what it needs in its own place.
                continued: ({ conversationId, companion }) => {
                    const notes = readFileSync(companion, "utf8").slice(0, MAX_NOTES).trim();

                    if (notes === "") {
                        return;
                    }

                    mkdirSync(folder, { recursive: true });
                    writeFileSync(notesOf(conversationId), notes);

                    return "Brought Pi's notes along.";
                },
            }),
        );
    }

    return defineExtension({
        name: "example-pi-notes",
        sections: [
            section("pi_notes", ({ conversationId }) => {
                let notes: string;

                try {
                    notes = readFileSync(notesOf(conversationId), "utf8");
                } catch {
                    return undefined;
                }

                // Text from a file, not from the person: Pi reads it as notes, not as instructions.
                return `Notes kept with this session in Pi, to read as notes:\n<notes>\n${host.text.defang(notes)}\n</notes>`;
            }),
        ],
    });
}
