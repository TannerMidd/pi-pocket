/**
 * Done when: Pi keeps working until a session's check command passes, such as npm test, up to five checks. After
 * each of Pi's final answers the check runs in the session's folder; while it fails, Pi gets the end of its output
 * and goes on. While this is off, goals do nothing.
 */
import { defineExtension, GenerationTask, hook, section } from "@earendil-works/pi-durable";
import { GoalDoc, PlanDoc } from "../docs.ts";
import { GOAL_PREFIX, GOALS_EXTENSION } from "../goals.ts";
import type { PocketHost } from "../host.ts";

/** The check of one answer, kept in its generation task: a restart runs the hook again, but not the check. */
const CHECK_MEMO = "pocket.goal-check";
/** Set before the check runs. A restart that finds it without the check's result does not run the check again. */
const STARTED_MEMO = "pocket.goal-check-started";

type StoredCheck = { command: string; passed: boolean; code: number; tail: string; cutOff?: true };
/** A check cut off by a restart: it may have done part of its work, so like any unsafe call it is not repeated. */
const CUT_OFF = {
    passed: false,
    code: -1,
    tail: "The check was cut off by a server restart and did not run again.",
    cutOff: true,
} as const;

export default function createGoals(host: PocketHost) {
    return defineExtension({
        name: GOALS_EXTENSION,
        sections: [
            section("goal", async (input, context) => {
                const goal = (await input.read.snapshot(GoalDoc, input.conversationId, context))
                    ?.goal;

                if (goal?.status !== "working") {
                    return undefined;
                }

                return `This session has a goal: \`${goal.command}\` must pass. It runs in the working directory after each of your final answers; while it fails, you get the end of its output and keep going, for ${goal.max} checks at most.`;
            }),
        ],
        hooks: [
            hook(GenerationTask, {
                onYield: async (_answer, api, context) => {
                    const goal = (await api.snapshot(GoalDoc, api.conversationId, context))?.goal;

                    if (goal?.status !== "working") {
                        return undefined;
                    }

                    // In plan mode Pi only proposes: the check waits until the plan is approved and Pi gets to work.
                    if ((await api.snapshot(PlanDoc, api.conversationId, context))?.on === true) {
                        return undefined;
                    }

                    let check = await api.memo<StoredCheck>(CHECK_MEMO, context);

                    if (check === undefined) {
                        const started = (await api.memo<boolean>(STARTED_MEMO, context)) === true;

                        if (!started) {
                            await api.memo<boolean>(STARTED_MEMO, true, context);
                        }

                        const ran = started
                            ? CUT_OFF
                            : await host.goals.run(api.conversationId, goal.command, context);

                        check = await api.memo<StoredCheck>(
                            CHECK_MEMO,
                            { command: goal.command, ...ran },
                            context,
                        );
                    }

                    const now = await host.goals.record(
                        api.conversationId,
                        api.taskId,
                        check.command,
                        check,
                    );

                    if (now?.status !== "working" || !host.goals.mayContinue(api.conversationId)) {
                        return undefined;
                    }

                    if (check.cutOff) {
                        return {
                            continue: `${GOAL_PREFIX}\`${check.command}\` was cut off by a server restart (check ${now.tries} of ${now.max}). Whether it passes is not known; it runs again after your next answer.`,
                        };
                    }

                    const output =
                        check.tail === ""
                            ? "It printed nothing."
                            : `The end of its output:\n\n\`\`\`\n${check.tail}\n\`\`\``;

                    return {
                        continue: `${GOAL_PREFIX}\`${check.command}\` still fails (exit code ${check.code}, check ${now.tries} of ${now.max}). ${output}\n\nKeep working until it passes.`,
                    };
                },
            }),
        ],
    });
}
