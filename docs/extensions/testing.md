# Testing

Test a module before you turn it on for everyone, and before you share it. Do not test on the data of the Pi Pocket that people use. This page gives three ways to test, from the strictest to the lightest.

## Write a test

A test runs Pi Pocket on a temporary data folder, with a scripted model. Nothing goes to a real model provider, and nothing touches your data. Pi Pocket's own test helpers (`test/helpers.ts`) do the work.

Put the test beside the module in the drop-in folder, with a name that ends in `.test.ts`. Pi Pocket does not load such a file as a module. This test is for the module of [Your first extension](first-extension.md):

```typescript
// Pi Pocket's test helpers first: they point Pi Pocket at a temporary folder before it loads.
import {
    cleanUp,
    lastText,
    modelTexts,
    newSession,
    openApp,
    owner,
    root,
    say,
    scriptedModel,
} from "/path/to/pi-pocket/test/helpers.ts";
import assert from "node:assert/strict";
import { copyFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { after, test } from "node:test";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";

// A scripted model: it calls the tool, then says what the tool returned.
const model = scriptedModel((context) => {
    const { role, text } = lastText(context as never);

    if (role === "toolResult") {
        return fauxAssistantMessage([fauxText(`tool said: ${text}`)]);
    }

    return fauxAssistantMessage([fauxToolCall("my_word_count", { text: "one two three" })], {
        stopReason: "toolUse",
    });
});

after(cleanUp);

test("my_word_count counts the words", async () => {
    // The module, in the drop-in folder of a Pi Pocket that has its own data.
    const dropIns = join(root, "data", "extensions");

    mkdirSync(dropIns, { recursive: true });
    copyFileSync(join(import.meta.dirname, "my-words.ts"), join(dropIns, "my-words.ts"));

    const app = await openApp(model);

    try {
        await app.setExtensionEnabled(owner(app), "my-words.ts", true);
        const id = await newSession(app);

        await say(app, id, "How many words?");
        assert.match((await modelTexts(app, id)).at(-1) ?? "", /tool said: 3 words/);
    } finally {
        await app.close();
    }
});
```

1. Change `/path/to/pi-pocket` to the folder of your Pi Pocket.
2. Run the test: `node --test my-words.test.ts`.

The test copies the module into a temporary data folder, turns it on as the owner, and starts a session. The scripted model calls the tool, and the test checks what the tool returned.

Pi Pocket's own tests show more:

- `test/docs-examples.test.ts` loads the examples of these docs as drop-ins, and uses them.
- `test/extension-commands.test.ts` runs a module's commands as different people, across a restart and a reload.
- `test/extension-web.test.ts` calls routes over HTTP as different people.
- `test/extension-ui.test.ts` loads the app in a real Chromium, and uses a module's rail button and page.

## Check it on a copy

A copy of Pi Pocket runs your code on a temporary data folder, with a scripted model that answers "echo: …". Use it to check routes, browser modules, and commands. The scripted model does not call your tools: use a test for them.

1. In Pi Pocket's folder, start a copy: `node test/serve.ts`. It prints its data folder, and sign-in links for an owner and a guest.
2. Copy your module into `extensions/` in the copy's `data/` folder.
3. Open the owner's link, and turn on the module in Menu → Extensions.
4. Keep the browser's console open, and use what the module adds.
5. Stop the copy with the `kill` command that it printed. This also deletes its data.

[Check it on a copy](../self-editing.md#check-it-on-a-copy) tells more about the copy.

## Check it on your own server

For a drop-in, you can also check it by hand on your own Pi Pocket:

1. Turn it on in Menu → Extensions.
2. Ask Pi to use it, in a session that you make for this purpose.
3. Watch Menu → Extensions, and the app's notices, for errors.

Remember that a drop-in runs with your rights, in each session. Turn it off when it does something wrong.
