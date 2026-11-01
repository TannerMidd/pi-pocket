/**
 * Two members of the host for extensions (since 0.22.0, experimental), built on core's own parts:
 *
 * - `ask`: a question for the person Pi works for, on a card in the session, through `Approvals` (it waits, notifies,
 *   and shows as an approval does). What they type goes back to the asker alone: the request that tabs see has the
 *   fields, never the values, and the answer route checks them (`PocketApp.answerApproval`).
 * - `browser`: a session's browser page (`browser.ts`), with the actions an extension needs and nothing of the page's
 *   internals: no script to run in it, and a `fill` for a person's value that core never shows.
 */
import type { Context } from "@earendil-works/chord";
import type { Browsers } from "./browser.ts";
import type { BrowserPage, Target } from "./browser/page.ts";
import { normalizeUrl } from "./browser/urls.ts";
import type {
    Approvals,
    AskAnswer,
    AskChoice,
    AskField,
    AskRequest,
    BrowserPageHandle,
    BrowserTarget,
} from "./host.ts";

/** The most fields on one card, and the longest value each takes. */
export const MAX_ASK_FIELDS = 6;
export const MAX_ASK_VALUE = 4096;
const FIELD_NAME = /^[A-Za-z][A-Za-z0-9_]{0,39}$/;
const AUTOCOMPLETE = /^[a-z][a-z0-9 -]{0,39}$/;

/** One line of text, at most `max` characters: what an extension says on a card. */
function line(value: unknown, what: string, max: number): string {
    if (
        typeof value !== "string" ||
        value.trim() === "" ||
        value.length > max ||
        /[\r\n]/.test(value)
    ) {
        throw new Error(`host.ask: ${what} is one line of 1 to ${max} characters`);
    }

    return value.trim();
}

function choicesOf(given: unknown): AskChoice[] {
    if (!Array.isArray(given) || given.length < 2 || given.length > 4) {
        throw new Error("host.ask: a field's choices are a list of 2 to 4");
    }

    const choices = given.map((choice: AskChoice) => ({
        label: line(choice?.label, "a choice's label", 60),
        ...(choice?.description === undefined
            ? {}
            : { description: line(choice.description, "a choice's description", 160) }),
    }));

    if (new Set(choices.map((choice) => choice.label)).size !== choices.length) {
        throw new Error("host.ask: two choices of a field have the same label");
    }

    return choices;
}

export async function ask(
    approvals: Approvals,
    request: AskRequest,
    context: Context,
): Promise<AskAnswer> {
    const { conversationId, id, taskId, callId } = request ?? ({} as AskRequest);

    if (typeof id !== "string" || id === "" || id.length > 200) {
        throw new Error("host.ask: give it an id, such as `${api.taskId}:${api.callId}`");
    }

    if (conversationId === undefined || taskId === undefined) {
        throw new Error("host.ask: give it the conversationId and the taskId that asks");
    }

    const title = line(request.title, "the title", 120);
    const text =
        request.text === undefined
            ? undefined
            : typeof request.text === "string" && request.text.length <= 2000
              ? request.text.trim()
              : (() => {
                    throw new Error("host.ask: text is up to 2000 characters");
                })();
    const given = request.fields ?? [];

    if (!Array.isArray(given) || given.length > MAX_ASK_FIELDS) {
        throw new Error(`host.ask: fields is a list of up to ${MAX_ASK_FIELDS}`);
    }

    const fields: AskField[] = given.map((field: AskField) => {
        if (typeof field?.name !== "string" || !FIELD_NAME.test(field.name)) {
            throw new Error(
                "host.ask: a field's name is letters, digits, and _, starting with a letter",
            );
        }

        const choices = field.choices === undefined ? undefined : choicesOf(field.choices);

        return {
            name: field.name,
            label: line(field.label, "a field's label", choices === undefined ? 80 : 300),
            ...(field.header === undefined ? {} : { header: line(field.header, "a header", 12) }),
            ...(field.placeholder === undefined
                ? {}
                : { placeholder: line(field.placeholder, "a placeholder", 80) }),
            ...(choices === undefined
                ? {
                      ...(field.secret === true ? { secret: true } : {}),
                      ...(typeof field.autocomplete === "string" &&
                      AUTOCOMPLETE.test(field.autocomplete)
                          ? { autocomplete: field.autocomplete }
                          : {}),
                  }
                : {
                      choices,
                      ...(field.multiple === true ? { multiple: true } : {}),
                      ...(field.other === true ? { other: true } : {}),
                  }),
        };
    });

    if (new Set(fields.map((field) => field.name)).size !== fields.length) {
        throw new Error("host.ask: two fields have the same name");
    }

    const submit =
        request.submit === undefined
            ? fields.length === 0
                ? "Done"
                : "Send"
            : line(request.submit, "submit", 30);
    const answer = await approvals.request(
        {
            id,
            conversationId,
            taskId,
            ...(callId === undefined ? {} : { callId }),
            tool: "ask",
            subject: title,
            reason:
                text ??
                fields
                    .filter((field) => field.choices !== undefined)
                    .map((field) => field.label)
                    .join(" · "),
            createdAt: Date.now(),
            form: { title, ...(text ? { text } : {}), fields, submit },
        },
        context,
    );

    if (!answer.allow) {
        return Object.freeze({ answered: false, by: answer.by });
    }

    return Object.freeze({
        answered: true,
        by: answer.by,
        values: Object.freeze({ ...(answer.values ?? {}) }),
    });
}

/** An error says what is wrong, never a value. */
export function checkValues(fields: readonly AskField[], values: unknown): Record<string, string> {
    if (typeof values !== "object" || values === null || Array.isArray(values)) {
        if (fields.length === 0 && (values === undefined || values === null)) {
            return {};
        }

        throw new Error("Fill in the fields.");
    }

    const out: Record<string, string> = {};

    for (const field of fields) {
        const value = (values as Record<string, unknown>)[field.name];

        if (typeof value !== "string" || value === "") {
            throw new Error(`Fill in ${field.label}.`);
        }

        if (value.length > MAX_ASK_VALUE) {
            throw new Error(`${field.label} is too long.`);
        }

        if (field.choices !== undefined) {
            const labels = field.choices.map((choice) => choice.label);
            const picked = field.multiple === true ? value.split("\n") : [value];
            const chosen =
                picked.every((label) => labels.includes(label)) &&
                new Set(picked).size === picked.length;

            if (!chosen && (field.other !== true || value.trim() === "")) {
                throw new Error(`Choose an answer to ${field.label}`);
            }
        }

        out[field.name] = value;
    }

    if (Object.keys(values).some((key) => !fields.some((field) => field.name === key))) {
        throw new Error("That is not a field of this card.");
    }

    return out;
}

function target(given: BrowserTarget | undefined, what: string): Target {
    if (typeof given !== "object" || given === null) {
        throw new Error(
            `host.browser: ${what} needs a target: a ref, a selector, a label, or x and y`,
        );
    }

    return {
        ...(typeof given.ref === "string" ? { ref: given.ref } : {}),
        ...(typeof given.selector === "string" ? { selector: given.selector } : {}),
        ...(typeof given.label === "string" ? { label: given.label } : {}),
        ...(typeof given.x === "number" && typeof given.y === "number"
            ? { x: given.x, y: given.y }
            : {}),
    };
}

/** The page's actions for extensions, each one checked, and the page's internals out of reach. */
export function browserHandle(page: BrowserPage): BrowserPageHandle {
    return Object.freeze({
        get url() {
            return page.url;
        },
        get title() {
            return page.title;
        },
        snapshot: async () => {
            const outline = await page.snapshot();

            return {
                text: outline.lines,
                controls: outline.items ?? [],
                truncated: outline.truncated,
                scroll: {
                    y: outline.scrollY,
                    viewport: outline.innerHeight,
                    height: outline.scrollHeight,
                },
            };
        },
        inspect: async (at: BrowserTarget) => {
            const where = target(at, "inspect");

            // A point names what is there: a hook that guards password fields must see one Pi points at by x and y.
            if (
                typeof where.x === "number" &&
                typeof where.y === "number" &&
                where.ref === undefined &&
                where.selector === undefined &&
                where.label === undefined
            ) {
                return await page.describeAt(where.x, where.y);
            }

            const found = await page.locate(where);

            return {
                label: found.label,
                kind: found.kind ?? "",
                editable: found.editable === true,
                password: found.password === true,
            };
        },
        navigate: async (url: string) => {
            // As Pi's own navigate takes it: http(s), host:port, or a file path. Never a page made of the address itself
            // (`data:`), whose script would run: the handle runs none.
            const address =
                typeof url === "string" ? normalizeUrl(url, { trusted: true }) : undefined;

            if (address === undefined || !/^(?:https?|file):/i.test(address)) {
                throw new Error(
                    "host.browser: navigate needs an http(s) address, host:port, or a file path",
                );
            }

            const result = await page.navigate(address);

            if (result.error !== undefined) {
                throw new Error(`host.browser: ${result.error}`);
            }
        },
        click: async (at: BrowserTarget) => {
            const clicked = await page.click(target(at, "click"));

            return { label: clicked.label, navigated: clicked.navigated };
        },
        type: (at: BrowserTarget, text: string, options?: { submit?: boolean }) =>
            page.type(
                target(at, "type"),
                String(text),
                options?.submit === true ? { submit: true } : {},
            ),
        fill: (at: BrowserTarget, value: string) => page.fill(target(at, "fill"), String(value)),
        select: (at: BrowserTarget, value: string) =>
            page.select(target(at, "select"), String(value)),
        press: (key: string) => page.press(String(key)),
        scroll: (at?: BrowserTarget, dy?: number) =>
            page.scroll(at === undefined ? undefined : target(at, "scroll"), dy),
        waitFor: (options: { text?: string; selector?: string; timeoutMs?: number }) =>
            page.waitFor({
                ...(typeof options?.text === "string" ? { text: options.text } : {}),
                ...(typeof options?.selector === "string" ? { selector: options.selector } : {}),
                ...(typeof options?.timeoutMs === "number"
                    ? { timeoutMs: options.timeoutMs, ms: options.timeoutMs }
                    : {}),
            }),
    } satisfies BrowserPageHandle);
}

/** A session's page for an extension: none while the Browser module is off. */
export async function browserFor(
    browsers: Browsers,
    on: () => boolean,
    conversationId: number,
    open: boolean,
): Promise<BrowserPageHandle | undefined> {
    if (!on()) {
        return undefined;
    }

    const page = open ? await browsers.open(conversationId) : browsers.page(conversationId);

    return page === undefined ? undefined : browserHandle(page);
}
