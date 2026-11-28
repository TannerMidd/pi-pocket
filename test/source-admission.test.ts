import assert from "node:assert/strict";
import test from "node:test";
import { AgentDoc, type ConversationId } from "@earendil-works/pi-durable";
import { PocketApp } from "../src/server/app.ts";
import { Commands } from "../src/server/commands.ts";
import {
    LinkedSessionCallsDoc,
    LinkedSessionPeersDoc,
    PlanDoc,
    TurnsDoc,
} from "../src/server/docs.ts";
import { ExtensionSessions } from "../src/server/extension-sessions.ts";
import { LinkedSessions } from "../src/server/linked-sessions.ts";
import { TurnNotes } from "../src/server/turn-notes.ts";

type Delivery = "send" | "report" | "extension first message";
const lead = 1 as unknown as ConversationId;
const child = 2 as unknown as ConversationId;
const user = { id: "writer", role: "owner", name: "Writer" };

/** Use the real delivery and admission paths with an in-memory destination. */
function delivery(kind: Delivery) {
    const source = kind === "report" ? child : lead;
    const target = source === child ? lead : child;
    const allowed = new Set([source, target]);
    const drivers = new Map<ConversationId, string>();
    const plan = new Set<ConversationId>();
    const entered = Promise.withResolvers<void>();
    const annotation = Promise.withResolvers<string | undefined>();
    const messages: string[] = [];
    const notices: string[] = [];
    const calls = { items: {} };
    const sessions = [{ id: lead }, { id: child, linkedFrom: { id: lead } }];

    const doc = (kind: unknown, id: ConversationId) => {
        if (kind === TurnsDoc) {
            return { on: drivers.has(id), driver: drivers.get(id) };
        }

        if (kind === PlanDoc) {
            return { on: plan.has(id) };
        }

        if (kind === LinkedSessionPeersDoc) {
            return { peers: { peer: Number(id === lead ? child : lead) } };
        }

        if (kind === AgentDoc) {
            return { model: {} };
        }

        return kind === LinkedSessionCallsDoc ? calls : { items: [] };
    };

    const tx = {
        doc,
        submissionByRequest: () => undefined,
        latestEntryId: () => 1,
        scanEntries: () => ({ items: [] }),
    };
    let inCommit = false;
    let report!: (event: object) => Promise<void>;
    const app = {
        now: () => 1,
        hidden: { replace: (text: string) => text },
        sessions: () => sessions,
        sessionMeta: (id: ConversationId) => sessions.find((session) => session.id === id),
        attribution: { requesterOf: () => user.id },
        steeringUser: (id: ConversationId, by: string) =>
            allowed.has(id) && by === user.id ? user : undefined,
        requireSee: (_user: unknown, id: ConversationId) => assert.ok(allowed.has(id)),
        requireSteer: () => {},
        requireDriver: PocketApp.prototype.requireDriver,
        rootOf: (id: ConversationId) => id,
        parentOf: () => undefined,
        isIsolatedWorkspace: () => false,
        isIsolatedConversation: () => false,
        spend: { check: () => {} },
        pip: { ownerOf: () => undefined },
        config: { subagentModels: [], users: [user], userById: () => undefined },
        agentState: () => ({ model: { provider: "fixture", modelId: "fixture" } }),
        models: { getModel: () => ({ input: ["text"] }) },
        events: {
            emit: () => {},
            on: (_event: string, callback: typeof report) => {
                report = callback;

                return () => {};
            },
        },
        collab: { setTyping: () => {} },
        notice: (_level: string, text: string) => notices.push(text),
        harness: {
            snapshot: (kind: unknown, id: ConversationId) => {
                assert.equal(inCommit, false, "use the active transaction for policy reads");

                return doc(kind, id);
            },
            commit: async (change: (transaction: typeof tx) => unknown) => {
                assert.equal(inCommit, false, "do not nest transactions");
                inCommit = true;

                try {
                    return await change(tx);
                } finally {
                    inCommit = false;
                }
            },
            submission: () => ({ id: 1, wait: async () => ({ status: "answered" }) }),
        },
        conversation: (id: ConversationId) => ({
            id,
            entries: () => ({ items: [] }),
            submit: (transaction: unknown, draft: { content: string }) => {
                assert.equal(transaction, tx);
                assert.equal(id, target);
                messages.push(draft.content);

                return 1;
            },
        }),
    } as unknown as PocketApp;
    const linked = new LinkedSessions(app);
    const notes = new TurnNotes(app);
    const commands = new Commands(app);

    Object.assign(app, { commands, turnNotes: notes });
    Object.assign(commands, {
        createSession: async (
            _user: unknown,
            _request: unknown,
            options: { init: (transaction: typeof tx, id: ConversationId) => Promise<void> },
        ) => {
            await options.init(tx, child);

            return { id: child };
        },
    });
    notes.add("fixture", () => {
        entered.resolve();

        return annotation.promise;
    });

    const run = () => {
        if (kind === "report") {
            linked.watch();

            return report({ conversationId: source, session: source, outcome: "done" });
        }

        if (kind === "send") {
            return linked.send(source, { to: "peer", message: "hello" }, "send");
        }

        return new ExtensionSessions(app).start(source, { message: "hello" }, "start");
    };

    return {
        run,
        entered: entered.promise,
        annotation,
        allowed,
        drivers,
        plan,
        source,
        target,
        messages,
        notices,
    };
}

for (const kind of ["send", "report", "extension first message"] as const) {
    for (const change of [
        "requester takes the wheel",
        "source access",
        "source driver",
        "target driver",
        "source plan",
        "target plan",
    ] as const) {
        const rejected =
            change === "source access" ||
            change === "target driver" ||
            (kind !== "extension first message" &&
                (change === "source plan" || change === "source driver"));

        test(`${kind}: ${change} during annotation ${rejected ? "blocks" : "permits"} delivery`, async () => {
            const f = delivery(kind);
            const result = f.run();

            await Promise.race([
                f.entered,
                result.then(() => assert.fail("delivery did not reach annotation")),
            ]);

            switch (change) {
                case "source access":
                    f.allowed.delete(f.source);
                    break;
                case "source driver":
                case "target driver":
                    f.drivers.set(change === "source driver" ? f.source : f.target, "other");
                    break;
                case "source plan":
                case "target plan":
                    f.plan.add(change === "source plan" ? f.source : f.target);
                    break;
                case "requester takes the wheel":
                    f.drivers.set(f.source, user.id);
                    f.drivers.set(f.target, user.id);
                    break;
            }

            f.annotation.resolve("fixture note");

            if (rejected && kind !== "report") {
                await assert.rejects(result, { status: change === "source access" ? 403 : 409 });
            } else {
                await result;
            }

            assert.equal(f.messages.length, rejected ? 0 : 1, f.notices.join("\n"));
            assert.equal(f.notices.length, rejected && kind === "report" ? 1 : 0);

            if (rejected && kind === "report") {
                assert.match(f.notices[0]!, /report was not taken/);
                assert.match(
                    f.notices[0]!,
                    change === "source plan"
                        ? /plan mode/i
                        : change === "source access"
                          ? /where Pi works for someone/
                          : /drive|wheel/i,
                );
            } else if (kind === "report") {
                assert.match(f.messages[0]!, /finished its run/);
            }
        });
    }
}

for (const kind of ["send", "extension first message"] as const) {
    test(`${kind}: the plain transaction rejects a policy change when an annotator returns no note`, async () => {
        const f = delivery(kind);
        const result = f.run();

        await Promise.race([f.entered, result.then(() => assert.fail("no annotation"))]);

        if (kind === "send") {
            f.plan.add(f.source);
        } else {
            f.drivers.set(f.target, "other");
        }

        f.annotation.resolve(undefined);
        await assert.rejects(result, { status: 409 });
        assert.deepEqual(f.messages, []);
    });
}
