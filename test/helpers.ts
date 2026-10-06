// What the server tests share: an isolated Pi install and data folder, a scripted model, and small helpers. Import
// this before anything from src/: it points Pi's config at a temporary folder first.
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { FauxResponseStep } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxProvider, fauxText } from "@earendil-works/pi-ai/providers/faux";
import { type ConversationId, UsageDoc } from "@earendil-works/pi-durable";
import type { Attachment } from "../src/server/commands.ts";
import type { User } from "../src/server/config.ts";
import type { Client } from "../src/server/room.ts";

export const context = BACKGROUND_CONTEXT;

export const root = mkdtempSync(join(tmpdir(), "pi-pocket-test-"));
// Isolate from the real Pi install: its auth, settings, skills, and Lancet Guard.
process.env.PI_CODING_AGENT_DIR = join(root, "agent");
process.env.PI_POCKET_GUARD = "off";
mkdirSync(process.env.PI_CODING_AGENT_DIR, { recursive: true });
/** The folder test sessions work in. */
export const work = join(root, "work");
mkdirSync(work);

const { PocketApp } = await import("../src/server/app.ts");

export type App = Awaited<ReturnType<typeof PocketApp.open>>;

/** The text of the newest message a model request carries, and who sent it. */
export function lastText(context: { messages: readonly { role: string; content: unknown }[] }): {
    role: string;
    text: string;
} {
    const last = context.messages.findLast((message) => message.role !== "system")!;
    const content =
        typeof last.content === "string"
            ? [{ type: "text", text: last.content }]
            : (last.content as { type: string; text?: string }[]);

    return {
        role: last.role,
        text: content.flatMap((part) => (part.type === "text" ? [part.text ?? ""] : [])).join(""),
    };
}

/** Echoes the last message: enough for tests that do not care what Pi says. */
export const echo: FauxResponseStep = (context) =>
    fauxAssistantMessage([fauxText(`echo: ${lastText(context as never).text}`)]);

/** A scripted provider, "faux", that answers every request with `route`. */
export function scriptedModel(route: FauxResponseStep = echo) {
    const faux = fauxProvider({
        tokensPerSecond: 2000,
        models: [
            { id: "faux-1" },
            { id: "faux-2" },
            { id: "faux-vision", input: ["text", "image"] },
        ],
    });

    faux.setResponses(Array.from({ length: 200 }, () => route));

    return faux;
}

/** Open the app on `dataDir` with the scripted model. Opening the same folder again is a restart; `now` moves its clock. */
export function openApp(
    model: ReturnType<typeof scriptedModel>,
    dataDir = join(root, "data"),
    now?: () => number,
): Promise<App> {
    return PocketApp.open({
        dataDir,
        defaultCwd: work,
        supervised: false,
        log: () => {},
        configureModels: (models) => models.registerNativeProvider(model.provider),
        ...(now === undefined ? {} : { now }),
    });
}

/** Wait until `check` holds, polling. */
export async function until(
    check: () => Promise<boolean> | boolean,
    what: string,
    timeoutMs = 10_000,
): Promise<void> {
    const started = Date.now();

    while (!(await check())) {
        if (Date.now() - started > timeoutMs) {
            throw new Error(`Timed out waiting for ${what}`);
        }

        await new Promise((resolve) => setTimeout(resolve, 20));
    }
}

/** Record `dollars` more of model usage in a conversation, the way a model response does: the scripted model costs nothing. */
export async function recordCost(app: App, id: ConversationId, dollars: number): Promise<void> {
    await app.harness.commit(async (tx) => {
        const usage = await tx.doc(UsageDoc, id);

        usage.models["faux/faux-1"] ??= {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 0,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        };
        usage.models["faux/faux-1"].cost.output += dollars;
        usage.models["faux/faux-1"].cost.total += dollars;
    }, context);
}

export const owner = (app: App) => app.config.users.find((user) => user.role === "owner")!;

/** A session in `cwd` with the scripted model, no thinking. */
export async function newSession(app: App, cwd = work): Promise<ConversationId> {
    const { id } = await app.commands.createSession(owner(app), { cwd });

    await app.commands.configure(id, owner(app), {
        model: { provider: "faux", modelId: "faux-1" },
        thinkingLevel: "off",
    });

    return id;
}

/** Send a message as the owner and wait for Pi's answer. */
export async function say(
    app: App,
    id: ConversationId,
    text: string,
    attachments?: Attachment[],
): Promise<void> {
    const { submissionId } = await app.commands.submit(id, owner(app), {
        text,
        requestId: crypto.randomUUID(),
        ...(attachments === undefined ? {} : { attachments }),
    });

    await (await app.harness.submission(submissionId, context))!.wait(context);
}

/** The texts of a conversation's entries as the model sees them, oldest first. */
export async function modelTexts(app: App, id: ConversationId): Promise<string[]> {
    const view = await (await app.harness.conversation(id, context))!.context(context);

    return view.messages.map((message) => JSON.stringify(message.content));
}

/** A browser tab as the app sees it, recording every event it is sent. Attach it with `app.attach(tab.client)`. */
export function fakeTab(id: ConversationId | undefined, user: User) {
    const events: { event: string; data: Record<string, unknown> }[] = [];
    const client: Client = {
        id: `tab-${crypto.randomUUID()}`,
        connection: `connection-${crypto.randomUUID()}`,
        user,
        conversationId: id,
        sentEntries: new Set<number>(),
        orderKey: "",
        send: (event: string, data: unknown) =>
            events.push({ event, data: data as Record<string, unknown> }),
    };
    const last = (event: string) => events.findLast((each) => each.event === event)?.data;
    /** A view field as a browser has it: updates leave out the fields that did not change. */
    const field = (name: string) =>
        events.findLast((each) => each.event === "view" && name in each.data)?.data[name];

    return { client, events, last, field };
}

/** Remove the temporary folder: call from `after`, once the app is closed. */
export function cleanUp(): void {
    rmSync(root, { recursive: true, force: true });
}
