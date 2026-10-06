/**
 * "Done when": a session's goal is a check command, such as `npm test`. After each of Pi's final answers the goals
 * extension (`extensions/goals.ts`) runs the check in the session's folder; while it fails, Pi is told so, with the
 * end of the output, and keeps going, up to a number of checks. This module keeps the goal and runs the check.
 */
import type { Context } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { ConversationId, TaskId } from "@earendil-works/pi-durable";
import type { PocketApp } from "./app.ts";
import { type Goal, type GoalCheck, GoalDoc } from "./docs.ts";
import { HttpError } from "./errors.ts";

const context = BACKGROUND_CONTEXT;

/** The extension that runs checks after Pi's answers; while it is off, goals do nothing. */
export const GOALS_EXTENSION = "pocket-goals";
/** How the message telling Pi that a check failed starts. The web app shows these as check cards. */
export const GOAL_PREFIX = "[goal] ";
/** How many checks a goal gets before Pi stops trying. */
export const MAX_CHECKS = 5;
/** How long a check may run. */
const CHECK_TIMEOUT_SECONDS = 600;
/** How much of a failing check's output Pi gets: its end, where the failures usually are. */
const TAIL_CHARS = 3000;
const MAX_COMMAND = 2000;
/** Answers remembered as checked: enough for any run that is still going. */
const COUNTED = 50;

export class Goals {
    readonly #app: PocketApp;

    constructor(app: PocketApp) {
        this.#app = app;
    }

    /** A conversation's goal, if it has one. */
    async get(id: ConversationId): Promise<Goal | undefined> {
        return (await this.#app.harness.snapshot(GoalDoc, id, context))?.goal;
    }

    /**
     * Set a goal. With Lancet Guard on, it must allow the command outright: the check runs after every answer without
     * asking anyone, so it may not be a command the guard would have asked about or blocked.
     */
    async set(id: ConversationId, by: string, command: string): Promise<Goal> {
        const app = this.#app;
        const check = command.trim();

        if (check === "") {
            throw new HttpError(400, "Say which command has to pass, such as npm test.");
        }

        if (check.length > MAX_COMMAND) {
            throw new HttpError(413, `Check commands are limited to ${MAX_COMMAND} characters.`);
        }

        if (!app.loader.extensionNames().includes(GOALS_EXTENSION)) {
            throw new HttpError(409, "Goals are turned off in Extensions.");
        }

        if (app.guardOn()) {
            const judged = await app.guard.judge("bash", { command: check }, app.cwdOf(id));

            if (judged !== undefined && judged.decision.action !== "allow") {
                throw new HttpError(
                    403,
                    `Lancet Guard does not allow this check to run unasked: ${judged.decision.reason}`,
                );
            }
        }

        const goal: Goal = {
            command: check,
            by,
            max: MAX_CHECKS,
            tries: 0,
            status: "working",
            counted: [],
        };

        await app.harness.commit(async (tx) => {
            (await tx.doc(GoalDoc, id)).goal = goal;
        }, context);

        return goal;
    }

    /** Drop the goal; true when there was one. */
    async clear(id: ConversationId): Promise<boolean> {
        return this.#app.harness.commit(async (tx) => {
            const doc = await tx.doc(GoalDoc, id);

            if (doc.goal === undefined) {
                return false;
            }

            delete doc.goal;

            return true;
        }, context);
    }

    /** Whether Pi may take another round toward the goal: not past a spend limit. When not, the session is told why. */
    mayContinue(id: ConversationId): boolean {
        const why = this.#app.spend.heldBack(id);

        if (why !== undefined) {
            this.#app.notice("warning", `The check still fails, but ${why}, so Pi stopped.`, id);
        }

        return why === undefined;
    }

    /** Run a goal's check in the conversation's folder. */
    async run(
        id: ConversationId,
        command: string,
        context: Context,
    ): Promise<Omit<GoalCheck, "at">> {
        let output = "";
        const env = this.#app.envFor(id);
        const result = await env.exec(
            command,
            {
                timeout: CHECK_TIMEOUT_SECONDS,
                onOutput: (text) => (output = (output + text).slice(-TAIL_CHARS)),
            },
            context,
        );

        if (!result.ok) {
            const why =
                result.error.code === "timeout"
                    ? `It did not finish within ${CHECK_TIMEOUT_SECONDS / 60} minutes.`
                    : result.error.message;

            return { passed: false, code: -1, tail: `${output}\n${why}`.trim().slice(-TAIL_CHARS) };
        }

        return {
            passed: result.value.exitCode === 0,
            code: result.value.exitCode,
            tail: output.trim(),
        };
    }

    /**
     * Count the check of one answer (by its generation task) and say where the goal stands. Counting the same answer
     * again changes nothing. Undefined when the goal is gone or is another one by now.
     */
    async record(
        id: ConversationId,
        answer: TaskId,
        command: string,
        check: Omit<GoalCheck, "at">,
    ): Promise<Goal | undefined> {
        const app = this.#app;
        const goal = await app.harness.commit(async (tx) => {
            const doc = await tx.doc(GoalDoc, id);
            const goal = doc.goal;

            if (goal === undefined || goal.command !== command || goal.status !== "working") {
                return undefined;
            }

            if (!goal.counted.includes(String(answer))) {
                goal.counted.push(String(answer));

                if (goal.counted.length > COUNTED) {
                    goal.counted.splice(0, goal.counted.length - COUNTED);
                }

                goal.tries += 1;
                goal.last = { ...check, at: app.now() };

                if (check.passed) {
                    goal.status = "met";
                } else if (goal.tries >= goal.max) {
                    goal.status = "gave-up";
                }
            }

            return JSON.parse(JSON.stringify(goal)) as Goal;
        }, context);

        if (goal?.status === "met") {
            app.notice("info", `${goal.command} passes: the goal is met.`, id);
        } else if (goal?.status === "gave-up") {
            app.notice(
                "warning",
                `${goal.command} still fails after ${goal.max} checks: Pi stopped trying.`,
                id,
            );
        }

        return goal;
    }
}
