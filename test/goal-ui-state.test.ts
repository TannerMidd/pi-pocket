import assert from "node:assert/strict";
import { test } from "node:test";

const { createGoalState, goalNeedsBudget, goalSummary } = await import(
    new URL("../src/server/extensions/objective-goal/state.js", import.meta.url).href
);

type Goal = {
    revision: string;
    objective: string;
    status: string;
    budget: number | null;
    tokens: number;
    turns: number;
    reason: string | null;
};
type Answer = { goal: Goal | null; canSteer: boolean };
type State = Answer & { id: number | null; loaded: boolean; busy: boolean; error: string | null };
type Pending = {
    path: string;
    body?: { args: string; revision: string | null; requestId: string };
    signal: AbortSignal;
    resolve: (answer: Answer) => void;
    reject: (error: Error) => void;
};
type Controller = {
    follow(id: number | null): void;
    refresh(): Promise<void>;
    change(args: string, revision: string | null): Promise<boolean>;
    get(): State;
    subscribe(listener: (state: State) => void): () => void;
    dispose(): void;
};
const goal: Goal = {
    revision: "original",
    objective: "Verify the authentication tests.",
    status: "active",
    budget: 5000,
    tokens: 20,
    turns: 1,
    reason: "The second test still fails.",
};
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

function fixture() {
    const calls: Pending[] = [];
    const timers = new Set<() => void>();
    const delays: number[] = [];
    let keys = 0;
    const model = createGoalState(
        (path: string, body: Pending["body"], { signal }: { signal: AbortSignal }) =>
            new Promise<Answer>((resolve, reject) =>
                calls.push({ path, body, signal, resolve, reject }),
            ),
        {
            requestId: () => `request-${++keys}`,
            schedule: (run: () => void, ms: number) => {
                timers.add(run);
                delays.push(ms);

                return run;
            },
            cancel: (run: () => void) => timers.delete(run),
        },
    ) as Controller;

    return { model, calls, timers, delays };
}

test("goal reads reset immediately on navigation and ignore late replies", async () => {
    const { model, calls, timers } = fixture();

    model.follow(1);
    model.follow(2);
    assert.equal(calls[0]!.signal.aborted, true);
    calls[1]!.resolve({ goal: null, canSteer: true });
    await tick();
    calls[0]!.resolve({ goal, canSteer: true });
    await tick();
    assert.equal(model.get().id, 2);
    assert.equal(model.get().goal, null);
    assert.equal(timers.size, 1);
    model.follow(null);
    assert.equal(model.get().loaded, false);
    assert.equal(timers.size, 0);
    model.dispose();
});

test("goal changes wait for a committed answer and invalidate older reads", async () => {
    const { model, calls } = fixture();

    model.follow(1);
    calls[0]!.resolve({ goal, canSteer: true });
    await tick();
    const reading = model.refresh();
    const changing = model.change("pause", "original");

    assert.equal(model.get().goal?.status, "active", "no optimistic state before the commit");
    assert.equal(model.get().busy, true);
    assert.equal(await model.change("pause", "original"), false, "one mutation at a time");
    calls[2]!.resolve({ goal: { ...goal, revision: "paused", status: "paused" }, canSteer: true });
    assert.equal(await changing, true);
    calls[1]!.resolve({ goal, canSteer: true });
    await reading;
    assert.equal(model.get().goal?.status, "paused");
    assert.equal(model.get().busy, false);
    model.dispose();
});

test("a lost mutation response retries with the same key; errors stay visible after polling", async () => {
    const { model, calls } = fixture();

    model.follow(1);
    calls[0]!.resolve({ goal, canSteer: true });
    await tick();
    const first = model.change("pause", "original");

    calls[1]!.reject(new Error("Network unavailable"));
    assert.equal(await first, false);
    const reading = model.refresh();

    calls[2]!.resolve({ goal, canSteer: true });
    await reading;
    assert.equal(model.get().error, "Network unavailable");
    const retry = model.change("pause", "original");

    assert.deepEqual(calls[3]!.body, calls[1]!.body);
    calls[3]!.resolve({ goal: { ...goal, status: "paused" }, canSteer: true });
    assert.equal(await retry, true);
    assert.equal(model.get().error, null);
    model.dispose();
});

test("a mutation from the old session cannot replace the new session or its busy state", async () => {
    const { model, calls } = fixture();

    model.follow(1);
    calls[0]!.resolve({ goal, canSteer: true });
    await tick();
    const changing = model.change("clear", "original");

    model.follow(2);
    calls[2]!.resolve({ goal: { ...goal, objective: "The second session" }, canSteer: true });
    await tick();
    calls[1]!.resolve({ goal: null, canSteer: true });
    assert.equal(await changing, false);
    assert.equal(model.get().goal?.objective, "The second session");
    assert.equal(model.get().busy, false);
    model.dispose();
});

test("read failures disable controls, viewers do not mutate, and disposal cancels all work", async () => {
    const { model, calls, timers } = fixture();
    let changes = 0;

    model.subscribe(() => changes++);
    model.follow(1);
    calls[0]!.reject(new Error("Not available"));
    await tick();
    assert.equal(model.get().loaded, true);
    assert.equal(model.get().error, "Not available");
    assert.equal(await model.change("clear", null), false);
    const reading = model.refresh();

    calls[1]!.resolve({ goal, canSteer: false });
    await reading;
    assert.equal(await model.change("clear", "original"), false);
    assert.equal(calls.length, 2);
    const before = changes;

    model.dispose();
    assert.equal(timers.size, 0);
    assert.equal(calls[1]!.signal.aborted, true);
    model.follow(3);
    assert.equal(changes, before);
});

test("read failures back off and an access refusal stops polling until an explicit refresh", async () => {
    const { model, calls, timers, delays } = fixture();

    model.follow(1);
    calls[0]!.reject(new Error("Offline"));
    await tick();
    assert.equal(delays.at(-1), 4000);
    const denied = model.refresh();

    calls[1]!.reject(Object.assign(new Error("Access removed"), { status: 403 }));
    await denied;
    assert.equal(timers.size, 0);
    const restored = model.refresh();

    calls[2]!.resolve({ goal, canSteer: true });
    await restored;
    assert.equal(delays.at(-1), 2000);
    assert.equal(model.get().canSteer, true);
    model.dispose();
});

test("a spent budget needs adjustment, while an increased or removed budget can resume", () => {
    assert.equal(goalNeedsBudget({ ...goal, status: "budget", tokens: 5000 }), true);
    assert.equal(goalNeedsBudget({ ...goal, status: "budget", budget: 10000 }), false);
    assert.equal(goalNeedsBudget({ ...goal, status: "budget", budget: null }), false);
    assert.equal(goalNeedsBudget(goal), false);
});

test("the goal summary reports evidence and real token use, not a completion percentage", () => {
    assert.equal(
        goalSummary(goal),
        [
            "Goal: Verify the authentication tests.",
            "Status: Active",
            "Turns evaluated: 1",
            "Tokens: 20 / 5000",
            "Latest result: The second test still fails.",
        ].join("\n"),
    );
});
