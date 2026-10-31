import { cleanUp, lastText, newSession, openApp, owner, scriptedModel, until } from "./helpers.ts";
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { checkValues } from "../src/server/extension-points.ts";

const options = [
    { label: "Postgres", description: "One server" },
    { label: "SQLite", description: "A file" },
];
const questions = [
    { header: "Database", question: "Which database?", options, multiSelect: false },
    { header: "Parts", question: "Which parts?", options, multiSelect: true },
];
const app = await openApp(
    scriptedModel((request) => {
        const { role, text } = lastText(request as never);

        return role === "toolResult" || !text.endsWith("ask me")
            ? fauxAssistantMessage([fauxText(`ok: ${text}`)])
            : fauxAssistantMessage([fauxToolCall("ask", { questions })], { stopReason: "toolUse" });
    }),
);
const stored = async (id: number) =>
    JSON.stringify(await app.transcripts.allEntries(id as never, true));

after(async () => {
    await app.close();
    cleanUp();
});

test("a choice field takes one of its labels, several with multiple, or any text with other", () => {
    const field = { name: "q1", label: "Which database?", choices: options };
    const check = (more: object, q1: string) => checkValues([{ ...field, ...more }], { q1 });

    assert.deepEqual(check({}, "SQLite"), { q1: "SQLite" });
    assert.throws(() => check({}, "MySQL"), /^Error: Choose an answer to Which database\?$/);
    assert.throws(() => check({ multiple: true }, "SQLite\nSQLite"), /Choose/);
    assert.ok(check({ multiple: true }, "SQLite\nPostgres") && check({ other: true }, "MySQL"));
});

test("Pi's questions show on a card, and the answer comes back as one line for each", async () => {
    const id = await newSession(app);

    await app.commands.submit(id, owner(app), { text: "please ask me", requestId: "ask-1" });
    await until(() => app.approvals.forConversation(id).length === 1, "the card");
    const [card] = app.approvals.forConversation(id);

    assert.equal(card!.form?.title, "Pi asks");
    assert.equal(card!.reason, "Which database? · Which parts?");
    await app.answerApproval(card!.id, true, owner(app), { q1: "SQLite", q2: "SQLite\nnew" });
    await until(async () => (await stored(id)).includes("ok: Database"), "the answer");
    assert.match(await stored(id), /ok: Database: SQLite\\nParts: Other: \\"SQLite new\\"/);
});
