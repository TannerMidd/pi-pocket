/**
 * Counts the words in a text: a tool for Pi, and a /my-words command for people.
 */
import { Type } from "@earendil-works/pi-ai";
import { defineExtension, defineTool } from "@earendil-works/pi-durable";
import type { Web } from "../../types/pocket.d.ts";

/** The number of words in a text: the parts between spaces, tabs, and line breaks. */
function countWords(text: string): number {
    return text.split(/\s+/).filter((word) => word !== "").length;
}

const wordCount = defineTool({
    name: "my_word_count",
    description: "Count the words in a text.",
    parameters: Type.Object({ text: Type.String({ description: "The text to count" }) }),
    replay: "safe",
    execute: async (args) => ({
        content: [{ type: "text" as const, text: `${countWords(args.text)} words` }],
    }),
});

export default function createMyWords(_host: unknown, web: Web) {
    web.command("my-words", {
        description: "Count the words in a text",
        args: "<text>",
        scope: "conversation",
        handler: (args) => ({
            type: "toast",
            level: "info",
            message: `${countWords(args)} words`,
        }),
    });

    return defineExtension({ name: "my-words", tools: [wordCount] });
}
