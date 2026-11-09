/**
 * Ask someone: Pi writes a question that someone outside the chat can answer, and you share it by link or as text. The
 * link opens a page with no sign-in, where they answer once; the answer comes back to the session for you to give Pi.
 */
import { createHash } from "node:crypto";
import { obj, str } from "@earendil-works/pi-schema";
import { defineDoc, defineExtension, defineTool } from "@earendil-works/pi-durable";
// Types only: at run time this module uses nothing of Pi Pocket's but the host and web, as a drop-in would.
import type {
    ConversationWebRequest,
    ExtensionWeb,
    PocketHost,
    PublicPageRequest,
} from "../host.ts";

/** A question for someone outside the chat, and what became of it. */
type Question = {
    conversation: number;
    createdAt: number;
    /** Who Pi wrote it for. */
    by?: string;
    title: string;
    text: string;
    /** A draft is only here; sent has an open link; answered has its answer. */
    status: "draft" | "sent" | "answered";
    link?: { token: string; path: string; url: string | null; expiresAt: number };
    /** Who shared it, by name, as the page shows it. */
    sentBy?: string;
    /** Who shared it, by id: the notice of an answer goes to them alone. */
    sharedBy?: string;
    answer?: { text: string; name?: string; at: number };
    /** Whether someone put the answer in the message box. */
    used?: boolean;
};

/** Every question, by id. Stored data: never rename the kind. */
const Questions = defineDoc<{ items: Record<string, Question> }>({
    kind: "x.ask-someone.questions",
    version: 1,
    scope: "session",
    checkpointWhen: () => false,
    initial: () => ({ items: {} }),
});

const MAX_TITLE = 120;
const MAX_TEXT = 8000;
const MAX_ANSWER = 8000;
const MAX_NAME = 80;
/** The most questions one session keeps: delete answered ones to make room. */
const MAX_PER_SESSION = 50;
/** How long a link stays open, in hours: a day, a week, or a month. */
const LINK_HOURS = [24, 7 * 24, 30 * 24];
const ID = /^[0-9a-f]{16}$/;

const DESCRIPTION =
    "Write a question for someone outside this chat, such as a manager, a client, or an expert, who has not seen it. " +
    "Use it when the person asks to ask someone else, or when a decision needs someone who is not here and the person agrees. " +
    "Nothing is sent: it saves a draft that the person reviews, edits, and then shares as a link or as text. " +
    "The question must stand alone: give the background the reader needs, the question itself, the options with their costs, and your recommendation. " +
    "Keep it short and plain. Leave out keys, passwords, private data, and internal details that the reader does not need.";

/** One line, with no control or direction characters, cut to `max`. */
function line(value: unknown, max: number): string {
    return String(value ?? "")
        .replace(/[\p{Cc}\p{Bidi_Control}\u2028\u2029]+/gu, " ")
        .trim()
        .slice(0, max);
}

/** Text of several lines, with no control characters but line breaks and tabs, cut to `max`. */
function body(value: unknown, max: number): string {
    return String(value ?? "")
        .replace(/\r\n?/g, "\n")
        .replace(/[\p{Bidi_Control}\u2028\u2029]|[^\P{Cc}\n\t]/gu, "")
        .trim()
        .slice(0, max);
}

function escape(text: string): string {
    return text.replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`);
}

/** The few marks of Markdown that Pi writes most, as HTML, after the text is escaped: bold, code, and lists. */
function render(text: string): string {
    const inline = (part: string) =>
        escape(part)
            .replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>")
            .replace(/`([^`\n]+)`/g, "<code>$1</code>");
    const out: string[] = [];
    let list: "ul" | "ol" | undefined;

    for (const raw of text.split("\n")) {
        const bullet = /^\s*[-*]\s+(.*)$/.exec(raw);
        const numbered = /^\s*\d+[.)]\s+(.*)$/.exec(raw);
        const kind = bullet ? "ul" : numbered ? "ol" : undefined;

        if (list !== undefined && kind !== list) {
            out.push(`</${list}>`);
            list = undefined;
        }

        if (kind !== undefined) {
            if (list === undefined) {
                out.push(`<${kind}>`);
                list = kind;
            }

            out.push(`<li>${inline((bullet ?? numbered)![1]!)}</li>`);
            continue;
        }

        const heading = /^#{1,6}\s+(.*)$/.exec(raw);

        if (heading) {
            out.push(`<h3>${inline(heading[1]!)}</h3>`);
        } else if (raw.trim() === "") {
            out.push("");
        } else {
            out.push(`<p>${inline(raw)}</p>`);
        }
    }

    if (list !== undefined) {
        out.push(`</${list}>`);
    }

    return out.join("\n");
}

const STYLE = `
:root { color-scheme: light dark; }
body { font: 17px/1.55 system-ui, -apple-system, sans-serif; margin: 0; padding: 32px 18px 48px; color: #1d1d1f; background: #f5f5f2; }
main { max-width: 36rem; margin: 0 auto; }
.from { color: #6b6b6b; font-size: 0.9rem; margin: 0 0 6px; }
h1 { font-size: 1.35rem; line-height: 1.3; margin: 0 0 18px; }
h3 { font-size: 1.05rem; margin: 20px 0 6px; }
.question { background: #fff; border: 1px solid #e2e2dc; border-radius: 14px; padding: 4px 18px; margin-bottom: 24px; }
.question p { margin: 12px 0; }
code { font: 0.9em ui-monospace, monospace; background: rgba(127,127,127,0.15); padding: 1px 4px; border-radius: 4px; }
label { display: block; font-weight: 600; margin: 16px 0 6px; }
input, textarea { box-sizing: border-box; width: 100%; font: inherit; padding: 10px 12px; border: 1px solid #c9c9c2; border-radius: 10px; background: #fff; color: inherit; }
textarea { min-height: 9rem; resize: vertical; }
button { margin-top: 18px; width: 100%; min-height: 48px; font: inherit; font-weight: 600; border: 0; border-radius: 12px; background: #2f6fec; color: #fff; }
.note { color: #6b6b6b; font-size: 0.88rem; margin-top: 14px; }
.error { color: #b3261e; font-weight: 600; }
@media (prefers-color-scheme: dark) {
  body { color: #ececec; background: #151515; }
  .question { background: #1f1f1f; border-color: #333; }
  input, textarea { background: #1f1f1f; border-color: #444; }
  .from, .note { color: #a0a0a0; }
  .error { color: #ff8a80; }
}
`;

function page(title: string, content: string): string {
    return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escape(title)}</title>
<style>${STYLE}</style>
</head>
<body><main>
${content}
</main></body>
</html>
`;
}

function questionPage(
    question: Question,
    error?: string,
    form?: { name?: string; answer?: string },
) {
    const from = question.sentBy ? `${escape(question.sentBy)} asks you` : "A question for you";

    return page(
        question.title,
        `<p class="from">${from}</p>
<h1>${escape(question.title)}</h1>
<div class="question">
${render(question.text)}
</div>
<form method="post">
${error ? `<p class="error">${escape(error)}</p>` : ""}
<label for="answer">Your answer</label>
<textarea id="answer" name="answer" required maxlength="${MAX_ANSWER}">${escape(form?.answer ?? "")}</textarea>
<label for="name">Your name (optional)</label>
<input id="name" name="name" maxlength="${MAX_NAME}" autocomplete="name" value="${escape(form?.name ?? "")}">
<button type="submit">Send answer</button>
<p class="note">Your answer goes back to ${question.sentBy ? escape(question.sentBy) : "the person who sent this"}. This link takes one answer, then closes.</p>
</form>`,
    );
}

/** Whether Pi Pocket `version` has public links (0.22.0 or newer): an older server loaded this file before a restart. */
function supported(web: ExtensionWeb | undefined): web is ExtensionWeb {
    return (
        web !== undefined &&
        typeof (web as Partial<ExtensionWeb>).publicPage === "function" &&
        typeof (web as Partial<ExtensionWeb>).links === "object"
    );
}

export default function createAskSomeone(host: PocketHost, web?: ExtensionWeb) {
    if (!supported(web)) {
        return;
    }

    // The people who can steer every session: they share questions and read answers. Viewers and people invited to one
    // session do not load it.
    web.client("ask-someone", { access: "steer" });

    /** A question of this request's session, or a 404. */
    const mine = (
        doc: { items: Record<string, Question> } | undefined,
        request: ConversationWebRequest,
    ): Question => {
        const id = request.params.id ?? "";
        const question = ID.test(id) && doc?.items[id];

        if (!question || question.conversation !== Number(request.conversation.id)) {
            throw web.error(404, "That question is not here anymore.");
        }

        return question;
    };

    /** The session's questions, newest first, for its browser module. */
    const list = (doc: { items: Record<string, Question> } | undefined, conversation: number) =>
        Object.entries(doc?.items ?? {})
            .filter(([, question]) => question.conversation === conversation)
            .sort(([, a], [, b]) => b.createdAt - a.createdAt)
            .map(([id, question]) => ({ id, ...question }));

    const changed = (conversation: number) => web.send("changed", { conversation });

    web.conversationRoute(
        "GET",
        "questions/:source",
        async (request) => {
            const doc = await request.snapshot(Questions, request.context);

            return { questions: list(doc, Number(request.conversation.id)) };
        },
        { conversation: "source", access: "steer" },
    );

    // Edit a draft: once it is shared, the page shows what was shared.
    web.conversationRoute(
        "PUT",
        "questions/:source/:id",
        async (request) => {
            const title = line(request.body.title, MAX_TITLE);
            const text = body(request.body.text, MAX_TEXT);

            if (title === "" || text === "") {
                throw web.error(400, "A question needs a title and its words.");
            }

            await request.commit(async (tx) => {
                const doc = await tx.doc(Questions);
                const question = mine(doc, request);

                if (question.status !== "draft") {
                    throw web.error(
                        409,
                        "End its link first: a shared question stays as it was sent.",
                    );
                }

                question.title = title;
                question.text = text;
            });
            changed(Number(request.conversation.id));

            return {};
        },
        { conversation: "source", access: "steer" },
    );

    // Share a draft: a link for one answer, open for a day, a week, or a month.
    web.conversationRoute(
        "POST",
        "questions/:source/:id/link",
        async (request) => {
            const hours = LINK_HOURS.find((each) => each === request.body.hours);

            if (hours === undefined) {
                throw web.error(400, "A link stays open for a day, a week, or a month.");
            }

            const before = mine(await request.snapshot(Questions, request.context), request);

            if (before.status !== "draft") {
                throw web.error(409, "This question is already shared.");
            }

            const link = await web.links.create({
                hours,
                uses: 1,
                by: request.user.id,
                conversation: Number(request.conversation.id),
                data: { id: request.params.id! },
            });

            try {
                await request.commit(async (tx) => {
                    const doc = await tx.doc(Questions);
                    const question = mine(doc, request);

                    if (question.status !== "draft") {
                        throw web.error(409, "This question is already shared.");
                    }

                    question.status = "sent";
                    question.sentBy = line(request.user.name, MAX_NAME);
                    question.sharedBy = request.user.id;
                    question.link = {
                        token: link.token,
                        path: link.path,
                        url: link.url,
                        expiresAt: link.expiresAt,
                    };
                });
            } catch (error) {
                // Not saved: a link nobody can see must not stay open.
                await web.links.end(link.token);

                throw error;
            }

            changed(Number(request.conversation.id));

            return { link };
        },
        { conversation: "source", access: "steer" },
    );

    // End a question's link: it goes back to a draft, which can be edited and shared again.
    web.conversationRoute(
        "DELETE",
        "questions/:source/:id/link",
        async (request) => {
            const token = await request.commit(async (tx) => {
                const doc = await tx.doc(Questions);
                const question = mine(doc, request);

                if (question.status !== "sent") {
                    return undefined;
                }

                const was = question.link?.token;

                question.status = "draft";
                delete question.link;
                delete question.sentBy;
                delete question.sharedBy;

                return was;
            });

            if (token !== undefined) {
                await web.links.end(token);
            }

            changed(Number(request.conversation.id));

            return {};
        },
        { conversation: "source", access: "steer" },
    );

    web.conversationRoute(
        "DELETE",
        "questions/:source/:id",
        async (request) => {
            const token = await request.commit(async (tx) => {
                const doc = await tx.doc(Questions);
                const question = mine(doc, request);

                delete doc.items[request.params.id!];

                return question.link?.token;
            });

            if (token !== undefined) {
                await web.links.end(token);
            }

            changed(Number(request.conversation.id));

            return {};
        },
        { conversation: "source", access: "steer" },
    );

    // The answer went to the message box: it no longer counts as new.
    web.conversationRoute(
        "POST",
        "questions/:source/:id/used",
        async (request) => {
            await request.commit(async (tx) => {
                mine(await tx.doc(Questions), request).used = true;
            });
            changed(Number(request.conversation.id));

            return {};
        },
        { conversation: "source", access: "steer" },
    );

    // The page for anyone with a question's link: the question, and a form for one answer.
    web.publicPage(async (request: PublicPageRequest) => {
        const id = (request.link.data as { id?: unknown } | null)?.id;
        const found =
            typeof id === "string" && ID.test(id)
                ? (await request.snapshot(Questions, request.context))?.items[id]
                : undefined;

        if (found === undefined || found.link?.token !== request.link.token) {
            return {
                status: 404,
                html: page(
                    "This question is not open",
                    "<h1>This question is not open</h1><p>It may have been withdrawn. Ask whoever sent it for a new link.</p>",
                ),
            };
        }

        if (request.method === "GET") {
            return questionPage(found);
        }

        const answer = body(request.form.answer, MAX_ANSWER);
        const name = line(request.form.name, MAX_NAME);

        if (answer === "") {
            return {
                status: 400,
                html: questionPage(found, "Write an answer before you send it.", { name }),
            };
        }

        const saved = await request.commit(async (tx) => {
            const doc = await tx.doc(Questions);
            const question = doc.items[id as string];

            if (question?.status !== "sent" || question.link?.token !== request.link.token) {
                return undefined;
            }

            question.status = "answered";
            question.answer = { text: answer, at: Date.now(), ...(name === "" ? {} : { name }) };
            delete question.link;

            // A copy: the document's own object is not to be read once the change is stored.
            return {
                conversation: question.conversation,
                title: question.title,
                sentBy: question.sentBy,
                // Who shared it; for one shared before this was kept, who made its link.
                to: question.sharedBy ?? request.link.by ?? question.by,
            };
        });

        if (saved === undefined) {
            return {
                status: 410,
                html: page(
                    "This question is not open",
                    "<h1>This question is not open</h1><p>It was withdrawn while you wrote. Ask whoever sent it for a new link.</p>",
                ),
            };
        }

        await web.links.end(request.link.token);
        changed(saved.conversation);

        // Only to who shared it: the question's title and who answered are theirs, not every tab's.
        if (saved.to !== undefined) {
            web.send(
                "answered",
                {
                    conversation: saved.conversation,
                    title: saved.title,
                    name: name === "" ? null : name,
                },
                { to: saved.to },
            );
        }

        return page(
            "Answer sent",
            `<h1>Thank you</h1><p>Your answer went to ${saved.sentBy ? escape(saved.sentBy) : "the person who asked"}. You can close this page.</p>`,
        );
    });

    const askSomeone = defineTool({
        name: "ask_someone",
        description: DESCRIPTION,
        parameters: obj(
            {
                title: str({
                    description: "The question in a short line, up to 120 characters",
                }),
                question: str({
                    description:
                        "The whole question for the reader, in Markdown: background, the question, options, and your recommendation",
                }),
            },
            { open: true },
        ),
        // The draft's id comes from the call: a replay finds the draft it saved.
        replay: "safe",
        execute: async (args, api, context) => {
            const title = line(args.title, MAX_TITLE);
            const text = body(args.question, MAX_TEXT);

            if (title === "" || text === "") {
                throw new Error("Give the question a title and its words.");
            }

            const id = createHash("sha256")
                .update(`${api.taskId}:${api.callId}`)
                .digest("hex")
                .slice(0, 16);
            const conversation = Number(api.conversationId);
            const by = host.requesterOf(api.conversationId);

            await api.commit(async (tx) => {
                const doc = await tx.doc(Questions);

                if (doc.items[id] !== undefined) {
                    return;
                }

                const here = Object.values(doc.items).filter(
                    (each) => each.conversation === conversation,
                );

                if (here.length >= MAX_PER_SESSION) {
                    throw new Error(
                        `This session has ${MAX_PER_SESSION} questions. Ask the person to delete answered ones in Questions first.`,
                    );
                }

                doc.items[id] = {
                    conversation,
                    createdAt: Date.now(),
                    ...(by === undefined ? {} : { by }),
                    title,
                    text,
                    status: "draft",
                };
            }, context);

            changed(conversation);
            web.send("drafted", { conversation, title }, by === undefined ? {} : { to: by });

            return {
                output: [
                    {
                        type: "text" as const,
                        text: `Saved the draft "${title}". Nothing was sent. The person reviews and edits it under Questions (the status line under the message box, or the session menu), then shares it as a link that takes one answer, or copies it as text. An answer comes back to them, and they can give it to you. Tell them the draft is ready in a sentence, and do not repeat it in full.`,
                    },
                ],
            };
        },
    });

    return defineExtension({ name: "pocket-ask-someone", tools: [askSomeone] });
}
