/**
 * Session titles. A session is named after its first message at once; when that message is long, a small model of the
 * session's provider writes a short title in its place, unless someone renamed the session first. What it costs counts
 * as the session's spend, like Pi's own requests.
 */
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Api, Model, Usage } from "@earendil-works/pi-ai";
import { type ConversationId, UsageDoc } from "@earendil-works/pi-durable";
import type { PocketApp } from "./app.ts";
import { SessionsDoc } from "./docs.ts";
import { describe } from "./errors.ts";

const context = BACKGROUND_CONTEXT;

/** First messages this long or longer get a written title; shorter ones are a title already. */
const LONG_WORDS = 9;
const MAX_TITLE = 60;
/** How much of the first message the model reads. */
const READ_CHARS = 3000;
const SMALL = /(^|[-_./])(haiku|mini|flash|nano|lite|small)([-_.]|$)/i;

/** What the model is asked, before the first message. */
export const TITLE_PROMPT =
    "You name chat sessions. Reply with only a title of 3 to 6 words for a session that starts with the message below: plain words, no quotes, no punctuation at the end, in the message's language.";

/** Whether the title a first message gives is worth replacing: it is long, or more than one line. */
export function wantsTitle(text: string): boolean {
    const words = text.trim().split(/\s+/).length;

    return words >= LONG_WORDS || text.trim().includes("\n");
}

/** The cheapest small model of the same provider that can be used now, or the session's own. */
export function titleModel(models: readonly Model<Api>[], current: Model<Api>): Model<Api> {
    const small = models
        .filter(
            (model) =>
                model.provider === current.provider &&
                model.input.includes("text") &&
                SMALL.test(model.id),
        )
        .sort((a, b) => a.cost.input + a.cost.output - (b.cost.input + b.cost.output));

    return small[0] ?? current;
}

/** A model's reply as a title: one line, no quotes or label, not too long. Undefined when nothing is left. */
export function cleanTitle(reply: string): string | undefined {
    const line = reply
        .trim()
        .split("\n")[0]!
        .replace(/^(title|session title)\s*:\s*/i, "")
        .replace(/^["'“‘*#\s]+|["'”’*\s.!?:;,]+$/g, "")
        .trim();

    if (line === "") {
        return undefined;
    }

    return line.length > MAX_TITLE ? `${line.slice(0, MAX_TITLE - 1).trimEnd()}…` : line;
}

/** Add one response's usage to the session's ledger, as Pi Durable does for its own. */
function addUsage(total: Usage, usage: Usage): void {
    total.input += usage.input;
    total.output += usage.output;
    total.cacheRead += usage.cacheRead;
    total.cacheWrite += usage.cacheWrite;
    total.totalTokens += usage.totalTokens;

    for (const key of ["input", "output", "cacheRead", "cacheWrite", "total"] as const) {
        total.cost[key] += usage.cost[key];
    }
}

/**
 * Ask for a title for a session whose first message is `text`, and use it if the session still has the title that
 * message gave it (`provisional`). Failures only leave that title in place.
 */
export async function writeTitle(
    app: PocketApp,
    id: ConversationId,
    text: string,
    provisional: string,
): Promise<void> {
    try {
        if (app.spend.heldBack(id) !== undefined) {
            return;
        }

        const agent = await app.agentState(id);
        const current =
            agent?.model === undefined
                ? undefined
                : app.models.getModel(agent.model.provider, agent.model.modelId);

        if (current === undefined) {
            return;
        }

        const model = titleModel(app.models.getAvailableSnapshot(), current);
        const reply = await app.models.completeSimple(
            model,
            {
                messages: [
                    {
                        role: "user",
                        content: [
                            {
                                type: "text",
                                text: `${TITLE_PROMPT}\n\n<message>\n${text.slice(0, READ_CHARS)}\n</message>`,
                            },
                        ],
                        timestamp: Date.now(),
                    },
                ],
            },
            { maxTokens: 1024 },
        );
        const title = cleanTitle(
            reply.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join(""),
        );

        await app.harness.commit(async (tx) => {
            const usage = await tx.doc(UsageDoc, id);
            const key = `${model.provider}/${model.id}`;

            usage.models[key] ??= {
                input: 0,
                output: 0,
                cacheRead: 0,
                cacheWrite: 0,
                totalTokens: 0,
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
            };
            addUsage(usage.models[key] as Usage, reply.usage);

            if (title === undefined || reply.stopReason === "error") {
                return;
            }

            const meta = (await tx.doc(SessionsDoc)).items[String(id)];

            if (meta !== undefined && meta.title === provisional) {
                meta.title = title;
            }
        }, context);
    } catch (error) {
        app.log(`no title for session ${String(id)}: ${describe(error)}`);
    }
}
