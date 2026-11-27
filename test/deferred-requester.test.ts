import assert from "node:assert/strict";
import { test } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { ScheduleDoc } from "../src/server/docs.ts";
import createSubagents from "../src/server/extensions/subagents.ts";
import { Schedules } from "../src/server/schedules.ts";
import { Shell } from "../src/server/shell.ts";
import { Approvals } from "../src/server/host.ts";
import { ask } from "../src/server/extension-points.ts";

const context = BACKGROUND_CONTEXT;

test("a direct approval requires its recorded requester; a decline does not", async () => {
    let by: string | undefined;
    const allowed = new Set(["guest", "owner"]);
    const approvals = new Approvals(
        () => by,
        (_id, person) => allowed.has(person),
    );

    for (const original of [undefined, "guest", "owner"]) {
        by = original;
        const pending = approvals.request(
            { id: "one", conversationId: 1, tool: "fixture" } as never,
            context,
        );

        by = "owner";
        allowed.delete("guest");
        assert.equal(approvals.answer("one", { allow: true, by: "Owner" }), original === "owner");

        if (original !== "owner") {
            assert.ok(approvals.answer("one", { allow: false, by: "Owner" }));
        }

        assert.equal((await pending).allow, original === "owner");
    }
});

test("a restored question uses its saved requester or declines; it never asks a replacement", async () => {
    for (const [saved, current, taskId, accepted] of [
        [undefined, "owner", 1, false],
        ["guest", "owner", 1, false],
        ["guest", "guest", 1, true],
        [undefined, "owner", 3, true],
    ] as const) {
        const pin = { by: saved as string | undefined | null };
        let shown = false;
        const app = {
            attribution: { requesterOf: () => current },
            steeringUser: (_id: unknown, by: string) => (by === current ? {} : undefined),
            harness: {
                commit: (run: (tx: unknown) => unknown) =>
                    run({
                        task: () => ({ conversationId: 10, state: { status: "running" } }),
                        doc: () => pin,
                    }),
            },
            approvals: {
                request: () => {
                    shown = true;

                    return { allow: true, by: current };
                },
            },
        };
        const result = await ask(
            app as never,
            { id: "q", title: "Fixture", taskId, conversationId: 10 } as never,
            context,
            2,
        );

        assert.equal(result.answered, accepted);
        assert.equal(shown, accepted);
    }
});

for (const who of ["allowed", "revoked before commit", "missing"] as const) {
    test(`scheduled input at delivery: ${who}`, async () => {
        const person = { id: "guest", name: "Guest", role: "guest" };
        let allowed = true;
        const service = new Schedules({
            config: { userById: () => person },
            steeringUser: (_id: unknown, by: string | undefined) =>
                allowed && by === person.id ? person : undefined,
            sessionMeta: () => ({}),
            sandboxes: { requireDelivery: () => {} },
            spend: { heldBack: () => undefined },
        } as never);
        const items = {
            job: {
                taskId: 1,
                runs: 0,
                text: "test",
                content: "test",
                ...(who === "missing" ? {} : { requestedBy: person.id }),
            },
        };
        const sent: string[] = [];
        const runtime = {
            taskId: 1,
            conversationId: 2,
            now: () => 1000,
            snapshot: () => ({ items }),
            conversation: () => ({
                submit: (_tx: unknown, input: { requestId: string }) => sent.push(input.requestId),
            }),
            commit: (run: (tx: unknown) => unknown) => {
                allowed = who !== "revoked before commit";

                return run({
                    doc: (doc: unknown) => (doc === ScheduleDoc ? { items } : { messages: [] }),
                });
            },
        };

        await service.task.definition.phases.send(
            { input: { scheduleId: "job" }, state: { checkpoint: { phase: "send" } } } as never,
            runtime as never,
            context,
        );
        assert.deepEqual(sent, who === "allowed" ? ["p:guest:schedule-1-0"] : []);
        assert.deepEqual(items, {});
    });
}

test("a resumed shell task checks the stored requester before preparing its command", async () => {
    const checked: unknown[] = [];
    const shell = new Shell({
        steeringUser: (...args: unknown[]) => {
            checked.push(args);

            return undefined;
        },
    } as never);
    const state = await shell.task.definition.phases.run(
        { input: { by: "former-guest", command: "fixture" }, id: 8 } as never,
        { conversationId: 2, commit: (run: () => unknown) => run() } as never,
        context,
    );

    assert.deepEqual(checked, [[2, "former-guest"]]);
    assert.deepEqual(state, { status: "terminal", outcome: { status: "completed", result: null } });
});

test("a resumed subagent courier separates requesters and excludes revoked and legacy reports", async () => {
    const extension = createSubagents({
        canSteer: (_id: unknown, by: string) => by === "a" || by === "b",
    } as never);
    const courier = extension.tasks!.find(
        (task) => task.definition.name === "pocket.subagent-courier",
    )!;
    const outbox = ["a", "former-guest", "b", undefined, "a"].map((requestedBy, i) => ({
        name: "helper",
        text: String(i),
        requestedBy,
    }));
    const state: { outbox: typeof outbox; sending?: { request: string; reports: typeof outbox } } =
        { outbox };
    const runtime = {
        conversationId: 2,
        commit: (run: (tx: unknown) => unknown) => run({ doc: () => state }),
    };

    const next = courier.definition.phases.next as (
        task: { id: number },
        runtime: unknown,
        ctx: typeof context,
    ) => Promise<void>;

    await next({ id: 7 }, runtime, context);
    assert.equal(state.sending?.request, "p:a:subagent-reports-7-1");
    assert.deepEqual(
        state.sending?.reports.map((r) => r.text),
        ["0", "4"],
    );
    assert.deepEqual(
        state.outbox.map((r) => r.requestedBy),
        ["b"],
    );
});
