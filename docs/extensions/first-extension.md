# Your first extension

In this tutorial, you write a drop-in extension. It gives Pi a tool that counts the words in a text. It also gives people a slash command that does the same. Then you turn it on, and you use it. The tutorial takes about 15 minutes.

## Before you start

- You must be the owner of the Pi Pocket. Only the owner can turn on an extension.
- You must have Pi Pocket 0.14.0 or later.
- You must be able to write a file on the machine where Pi Pocket runs. You can also ask Pi to write the file for you.

Drop-ins go in the drop-in folder: `~/.pi-pocket/extensions/`, or `extensions/` in `PI_POCKET_DIR`. Menu → **Extensions** shows the path at the bottom of the sheet.

## 1. Write the module

In the drop-in folder, make the file `my-words.ts` with this text:

```typescript title="my-words.ts"
/**
 * Counts the words in a text: a tool for Pi, and a /my-words command for people.
 */
import { Type } from "@earendil-works/pi-ai";
import { defineExtension, defineTool } from "@earendil-works/pi-durable";
import type { Web } from "./_pocket.d.ts";

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
```

Each name starts with `my`. Change `my` to a prefix of your own, for example your initials. Pi Pocket does not load a module that uses a name that another module has ([Names](reference/names.md)).

What each part does:

- **The comment at the top** is the description of the module. The Extensions sheet shows its first sentence.
- **`import type`** gives your editor the types of `web`. Node removes this line when the module runs, so the module works without it. See [Types for your editor](reference/types.md).
- **`defineTool`** makes the tool. Pi gets its `name`, `description`, and `parameters` with each request, so keep them short.
- **`replay: "safe"`** tells Pi Pocket that the tool can run again after a restart. A count does not change anything, so this is safe. See [Tools](tools.md).
- **`execute`** gets the arguments that Pi gives, and returns the text that Pi reads.
- **`web.command`** adds the command `/my-words`. The command runs on the server, and does not ask Pi. See [Slash commands](commands.md).
- **The default export** returns the extension. Pi Pocket installs it when the owner turns on the module.

## 2. Turn it on

1. Open Menu → **Extensions**.
2. Find **my-words** in the group **Yours**. It is off: a new drop-in always starts off.
3. Turn it on, and confirm.

If the module does not load, the sheet shows "failed to load", and the error. Correct the file, and save it. Pi Pocket loads it again a moment after you save.

## 3. Ask Pi to use the tool

1. Start a new session.
2. Send this message: "How many words are in this sentence: the quick brown fox jumps over the lazy dog?"

Pi calls `my_word_count`, and answers with the count. The session shows the call with the name of the tool and its arguments. To show the call in words, see [How tool calls show](tool-calls.md).

## 4. Use the command

In the message box, type `/my-words the quick brown fox`, and send it. A notice shows "4 words". Only you see the notice, and Pi does not get it.

## 5. Change the module

1. In `my-words.ts`, change `words` to `words in total` in the command's message.
2. Save the file.
3. Send `/my-words the quick brown fox` again. The notice shows "4 words in total".

Pi Pocket loads the new version of the module a moment after you save. A tool call that runs at that time finishes with the old version. If the new version does not load, the old version stays on, and the sheet shows the error.

## 6. Turn it off, or remove it

To stop the module, turn it off in Menu → **Extensions**. To remove it, delete the file.

## Next steps

- Read [the rules that are easy to break](../extensions.md#rules-that-are-easy-to-break) before you share a module.
- Test the module: see [Testing](testing.md).
- Add a page or a button to the app: see [Adding to the app](app.md).
- Share the module with other people: see [Publishing to the gallery](publishing.md).

The tests of Pi Pocket load this module, and use its tool: [examples/my-words.ts](../examples/my-words.ts).
