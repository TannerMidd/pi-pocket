/**
 * A note the transcript can fold: one line in the app, and the whole message for the model.
 * An example drop-in: copy it and `quiet-note.js` into `~/.pi-pocket/extensions/`, then turn it on in Menu → Extensions.
 */
import { Type } from "@earendil-works/pi-ai";
import { defineExtension, defineTool } from "@earendil-works/pi-durable";
// A type import is gone when the module runs. In the drop-in folder, import the types from "./_pocket.d.ts".
import type { Web } from "../../types/pocket.d.ts";

/** The start of a note nobody wrote. A message a person sends that starts this way stays theirs. */
const NOTE = "NOTE ";

const leaveNote = defineTool({
    name: "quiet_note",
    description:
        "Leave a note in this session. The app may show one line; you still read the whole note.",
    parameters: Type.Object({
        text: Type.String({ description: "The whole note" }),
        summary: Type.String({ description: "A few words for the one line" }),
    }),
    // The request id is this call's, so a replay finds the note instead of leaving another.
    replay: "safe",
    execute: async (args, api, context) => {
        const text = args.text.trim();
        const summary = args.summary.replace(/\s+/g, " ").trim();

        if (text === "" || summary === "") {
            throw new Error("Give the whole note and a short summary.");
        }

        const body = text.startsWith(NOTE) ? text : `${NOTE}${text}`;
        const conversation = await api.conversation(api.conversationId, context);

        if (conversation === undefined) {
            throw new Error("This session is gone.");
        }

        // After this turn: the note is the next message the model reads, in full.
        await conversation.submit(
            {
                type: "input",
                content: body,
                whenBusy: "followUp",
                requestId: `quiet-note:${api.taskId}:${api.callId}`,
                entry: { kind: "x.quiet-note.note", data: { summary } },
            },
            context,
        );

        return {
            output: [
                {
                    type: "text" as const,
                    text: "The note is in the session. You still read it in full.",
                },
            ],
        };
    },
});

// It returns `output`, so it needs version 2 of the extension API.
export const pocketApi = 2;

export default function createQuietNote(_host: unknown, web: Web) {
    web.presentEntry({
        kind: "x.quiet-note.note",
        label: "Note",
        userPrefix: NOTE,
    });
    web.client("quiet-note.js");

    return defineExtension({ name: "example-quiet-note", tools: [leaveNote] });
}
