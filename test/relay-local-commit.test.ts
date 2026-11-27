import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { readdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { InboxDoc, LiveDoc, type ConversationId } from "@earendil-works/pi-durable";
import { Commands } from "../src/server/commands.ts";
import { TurnNotes } from "../src/server/turn-notes.ts";
import type { PocketApp } from "../src/server/app.ts";
import { Inbox } from "../src/server/inbox.ts";
import { publishFetchedFile } from "../src/server/extensions/pocket-relay/files.ts";

test("inbox delivery checks the current route after lookup and gives admission the same guard", async () => {
    const person = { id: "person", role: "owner" };
    const checked: string[] = [];
    let phase = "lookup";
    const checkCurrent = () => checked.push(phase);
    const inbox = new Inbox({
        config: { userById: () => person },
        steeringUser: (_target: unknown, by: string) => (by === person.id ? person : undefined),
        sessionMeta: () => ({}),
        canSee: () => true,
        now: () => 1,
        harness: {
            commit: async () => {
                phase = "after lookup";
            },
        },
        commands: {
            submit: async (...args: Parameters<PocketApp["commands"]["submit"]>) => {
                phase = "admission";
                assert.equal(args[5], checkCurrent);
                args[5]!();
            },
        },
    } as unknown as PocketApp);

    assert.deepEqual(
        await inbox.deliver(
            1 as unknown as ConversationId,
            {
                by: person.id,
                via: "fixture",
                payload: "message",
                key: "fixture-input",
            },
            checkCurrent,
        ),
        { sent: true },
    );
    assert.deepEqual(checked, ["lookup", "after lookup", "admission"]);
});

for (const annotated of [false, true]) {
    test(`guarded admission rolls back a cancelled ${annotated ? "annotated" : "plain"} input`, async () => {
        const owner = { id: "owner", role: "owner", name: "Owner" };
        const route = new AbortController();
        const staged: string[] = [];
        const committed: string[] = [];
        const log: string[] = [];
        const tx = {
            submissionByRequest: async () => undefined,
            doc: async (kind: unknown) =>
                kind === LiveDoc && staged.length > 0
                    ? { run: { inputs: ["submission"] } }
                    : { items: [] },
            appendEntry: async () => {
                staged.push("note");
                route.abort();
            },
        };
        const app = {
            config: { users: [owner], userById: () => owner },
            steeringUser: (_target: unknown, by: string) => (by === owner.id ? owner : undefined),
            canSee: () => true,
            requireSee: () => {},
            requireSteer: (user: unknown) => assert.equal(user, owner),
            requireDriver: async () => {},
            sessionMeta: () => ({}),
            agentState: async () => ({ model: { provider: "fixture", modelId: "fixture" } }),
            models: { getModel: () => ({ input: ["text"] }) },
            spend: { check: () => {} },
            hidden: { replace: (value: string) => value },
            now: () => 1,
            pip: { ownerOf: () => undefined },
            sandboxes: { requireDelivery: () => {} },
            parentOf: () => undefined,
            log: (line: string) => log.push(line),
            conversation: async () => ({
                id: 1,
                entries: async () => ({ items: [] }),
                submit: async (transaction: unknown) => {
                    assert.equal(transaction, tx);
                    staged.push("input");

                    if (!annotated) {
                        route.abort();
                    }

                    return "submission";
                },
            }),
            harness: {
                snapshot: async (kind: unknown) => (kind === InboxDoc ? { items: [] } : {}),
                commit: async (prepare: (transaction: typeof tx) => Promise<unknown>) => {
                    const result = await prepare(tx);

                    committed.push(...staged);

                    return result;
                },
            },
        } as unknown as PocketApp;
        const notes = new TurnNotes(app);
        const commands = new Commands(app);

        Object.assign(app, { turnNotes: notes, commands });

        if (annotated) {
            notes.add("fixture", () => "note");
        }

        const inbox = new Inbox(app);

        await assert.rejects(
            inbox.deliver(
                1 as unknown as ConversationId,
                {
                    by: owner.id,
                    via: "fixture",
                    payload: "message",
                    key: "input",
                },
                () => route.signal.throwIfAborted(),
            ),
            /does not take messages now/,
        );
        assert.deepEqual(staged, annotated ? ["input", "note"] : ["input"], log.join("\n"));
        assert.deepEqual(committed, []);
    });
}

for (const cancelled of [false, true]) {
    test(`attachment publication ${cancelled ? "keeps the previous file on cancellation" : "commits the complete staged file"}`, async (t) => {
        const folder = await mkdtemp(join(tmpdir(), "relay-publish-"));

        t.after(() => rm(folder, { recursive: true, force: true }));
        const path = join(folder, "note.txt");
        const data = Buffer.from("updated");

        await writeFile(path, "previous");
        let checkedStaged = false;
        const publish = publishFetchedFile(path, data, () => {
            const staged = readdirSync(folder).find((name) => name.endsWith(".tmp"));

            if (staged !== undefined && statSync(join(folder, staged)).size === data.length) {
                checkedStaged = true;

                if (cancelled) {
                    throw new Error("Cancelled");
                }
            }
        });

        if (cancelled) {
            await assert.rejects(publish, /Cancelled/);
        } else {
            await publish;
        }

        assert.equal(checkedStaged, true);
        assert.equal(await readFile(path, "utf8"), cancelled ? "previous" : "updated");
        assert.deepEqual(await readdir(folder), ["note.txt"]);
    });
}
