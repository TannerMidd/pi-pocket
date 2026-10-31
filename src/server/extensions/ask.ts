/**
 * Ask: Pi asks you up to 4 questions on a card in the session, each with 2 to 4 answers to tap or one of your own.
 */
import { Type } from "@earendil-works/pi-ai";
import { defineExtension, defineTool, section } from "@earendil-works/pi-durable";
import type { AskField, PocketHost } from "../host.ts";

const DESCRIPTION =
    "Ask the person you work for 1 to 4 questions on a card, each with 2 to 4 answers to tap; they can also type their own. " +
    "It waits for their answer, which can take hours, and gives you one line per question: `header: answer`.";

const GUIDE = `Use the ask tool when a decision changes the work and only the person can make it: the scope, a behavior choice, or a trade-off.
Put all your questions in one call. Put the option you recommend first, with "(Recommended)" at the end of its label.
Do not use it for a yes or no that a plain sentence covers, or for permission to run tools: the guard asks for that.
Never ask the same thing twice.`;

const DECLINED =
    "The person declined to answer. Do not ask again at once; go on with your best judgment, or ask in plain text.";

type Reply = { text: string; answers?: { header: string; question: string; answer: string }[] };

const flat = (text: string) => text.replace(/\s+/g, " ").trim();

const Choice = Type.Object({
    label: Type.String({ minLength: 1, maxLength: 60, description: "The answer, 1 to 5 words" }),
    description: Type.Optional(
        Type.String({ maxLength: 160, description: "What it means or costs, in one line" }),
    ),
});

const Question = Type.Object({
    question: Type.String({
        minLength: 1,
        maxLength: 300,
        description: "The whole question, ending with a question mark",
    }),
    header: Type.String({
        minLength: 1,
        maxLength: 12,
        description: "A short tag for it, such as Database or Scope",
    }),
    options: Type.Array(Choice, { minItems: 2, maxItems: 4 }),
    multiSelect: Type.Optional(
        Type.Boolean({ description: "Whether the person can choose more than one" }),
    ),
});

export default function createAsk(host: PocketHost) {
    const ask = defineTool({
        name: "ask",
        description: DESCRIPTION,
        parameters: Type.Object({
            questions: Type.Array(Question, { minItems: 1, maxItems: 4 }),
        }),
        // The card's id comes from the call: after a restart, the same card asks again unless the memo has the answer.
        replay: "safe",
        execute: async (args, api, context) => {
            // Nobody reads a subagent's chat; a subagent started before `subagents.ts` hid `ask` still has it.
            const agent = await api.agent(context);

            if (agent.instructions?.startsWith('You are the subagent "')) {
                throw new Error(
                    "A subagent cannot ask the person: put the question in your report.",
                );
            }

            const questions = args.questions.map((each) => ({
                question: flat(each.question),
                header: flat(each.header),
                options: each.options.map((option) => ({
                    label: flat(option.label),
                    ...(option.description === undefined || flat(option.description) === ""
                        ? {}
                        : { description: flat(option.description) }),
                })),
                multiple: each.multiSelect === true,
            }));
            let reply = await api.memo<Reply>("pocket.ask", context);

            if (reply === undefined) {
                const fields: AskField[] = questions.map((each, at) => ({
                    name: `q${at + 1}`,
                    label: each.question,
                    header: each.header,
                    choices: each.options,
                    ...(each.multiple ? { multiple: true } : {}),
                    other: true,
                    placeholder: "Or type your own answer",
                }));
                const answer = await host.ask(
                    {
                        conversationId: api.conversationId,
                        id: `${api.taskId}:${api.callId}`,
                        taskId: api.taskId,
                        callId: api.callId,
                        title: "Pi asks",
                        fields,
                    },
                    context,
                );
                const answers = answer.answered
                    ? questions.map((each, at) => {
                          const value = answer.values[`q${at + 1}`] ?? "";
                          const labels = each.options.map((option) => option.label);
                          const picked = each.multiple ? value.split("\n") : [value];

                          return {
                              header: each.header,
                              question: each.question,
                              answer:
                                  picked.every((label) => labels.includes(label)) &&
                                  new Set(picked).size === picked.length
                                      ? picked.join("; ")
                                      : `Other: "${flat(value)}"`,
                          };
                      })
                    : undefined;

                reply = await api.memo<Reply>(
                    "pocket.ask",
                    answers === undefined
                        ? { text: DECLINED }
                        : {
                              text: answers
                                  .map((each) => `${each.header}: ${each.answer}`)
                                  .join("\n"),
                              answers,
                          },
                    context,
                );
            }

            return {
                output: [{ type: "text" as const, text: reply.text }],
                ...(reply.answers === undefined ? {} : { details: { answers: reply.answers } }),
            };
        },
    });

    return defineExtension({
        name: "pocket-ask",
        // Asking only waits for the person: plan mode lets it run (`plan.ts` trusts no built-in's hint, so it lists it).
        tools: [Object.assign(ask, { annotations: { readOnlyHint: true } })],
        sections: [section("ask", () => GUIDE)],
    });
}
