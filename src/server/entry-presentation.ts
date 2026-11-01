/**
 * How a module asks the transcript to show an input it sends: one line, which opens to the text. The registration
 * lives only while the module is on. The model still reads the message in full. Nothing here is stored.
 */

/** Presentations one module may register. */
export const PRESENTATION_LIMIT = 32;

/** A chip's label, one line. */
export const LABEL_LIMIT = 80;

/** An optional prefix that matches an author-less user message. */
export const PREFIX_LIMIT = 200;

/** Characters other than spaces a prefix needs, so that it cannot match most messages. */
export const PREFIX_MINIMUM = 3;

/** `entry.data.summary`, after whitespace is collapsed. */
export const SUMMARY_LIMIT = 200;

/** What `web.presentEntry` registered. `kind` is `x.<module>.<name>`. */
export type RegisteredPresentation = {
    kind: string;
    label: string;
    userPrefix?: string;
};

/** What a projected user entry carries while that registration is on. Nothing here is stored. */
export type EntryPresentationView = {
    entryKind: string;
    label: string;
    summary?: string;
    /** The full text's length, when the live view clipped it. */
    clipped?: number;
    /**
     * The row is a user message (`pi.user`) that a `userPrefix` matched, so it can be sent again. Left out, it is
     * stored as the module's own kind.
     */
    prefixed?: true;
};

/** The last part of `x.<module>.<name>`. */
const PRESENTATION_NAME = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

/**
 * `web.presentEntry`, checked. `module` is the module's name. `already` is how many it has registered. Throws the words
 * the module's load shows.
 */
export function checkPresentation(
    module: string,
    spec: unknown,
    already: number,
): RegisteredPresentation {
    if (typeof spec !== "object" || spec === null) {
        throw new Error("web.presentEntry: give it { kind, label }");
    }

    const { kind, label, userPrefix } = spec as {
        kind?: unknown;
        label?: unknown;
        userPrefix?: unknown;
    };
    const prefix = `x.${module}.`;

    if (typeof kind !== "string" || !kind.startsWith(prefix)) {
        const shown = typeof kind === "string" ? kind.slice(0, 80) : typeof kind;

        throw new Error(`web.presentEntry: kind is ${prefix}<name>, not ${shown}`);
    }

    if (!PRESENTATION_NAME.test(kind.slice(prefix.length))) {
        throw new Error(`web.presentEntry: ${kind} is ${prefix}<name>`);
    }

    if (typeof label !== "string" || label.trim() === "" || label !== label.trim()) {
        throw new Error("web.presentEntry: label is one short line");
    }

    if (label.length > LABEL_LIMIT || /[\p{Cc}\u2028\u2029]/u.test(label)) {
        throw new Error(`web.presentEntry: label is one line of ${LABEL_LIMIT} characters at most`);
    }

    if (already >= PRESENTATION_LIMIT) {
        throw new Error(
            `web.presentEntry: a module has ${PRESENTATION_LIMIT} presentations at most`,
        );
    }

    if (userPrefix === undefined) {
        return { kind, label };
    }

    if (
        typeof userPrefix !== "string" ||
        userPrefix.length > PREFIX_LIMIT ||
        userPrefix.replace(/\s/g, "").length < PREFIX_MINIMUM
    ) {
        throw new Error(
            `web.presentEntry: userPrefix is up to ${PREFIX_LIMIT} characters, ${PREFIX_MINIMUM} of them not spaces`,
        );
    }

    // The app's own inputs nobody typed (reports, linked sessions, schedules, background tasks) start with "[".
    if (/^\s*\[/.test(userPrefix)) {
        throw new Error(
            'web.presentEntry: a userPrefix cannot start with "[": the app\'s own inputs do',
        );
    }

    return { kind, label, userPrefix };
}

/** Whether one prefix could match a message the other matches: one starts the other. */
export function prefixesOverlap(left: string, right: string): boolean {
    return left.startsWith(right) || right.startsWith(left);
}

/** The registrations of every module that is on. Prefixes are longest first. */
export type EntryPresentations = {
    byKind: ReadonlyMap<string, RegisteredPresentation>;
    prefixes: readonly RegisteredPresentation[];
};

/** What `projectEntry` may consult. Omitted, a custom kind stays `{ kind: "other" }`. */
export type ProjectOptions = {
    presentations?: EntryPresentations;
    /** A person wrote this entry. A prefix never matches then. */
    authored?: boolean;
};

export const EMPTY_PRESENTATIONS: EntryPresentations = {
    byKind: new Map(),
    prefixes: [],
};

/** The registrations of the modules that are on, prefixes longest first so the longest match wins. */
export function compilePresentations(
    parts: Iterable<{ presentations: readonly RegisteredPresentation[] }>,
): EntryPresentations {
    const byKind = new Map<string, RegisteredPresentation>();
    const prefixes: RegisteredPresentation[] = [];

    for (const part of parts) {
        for (const spec of part.presentations) {
            byKind.set(spec.kind, spec);

            if (spec.userPrefix !== undefined) {
                prefixes.push(spec);
            }
        }
    }

    prefixes.sort((left, right) => right.userPrefix!.length - left.userPrefix!.length);

    return { byKind, prefixes };
}

/** The first registered prefix that `text` starts with, longest first. */
export function matchPrefix(
    text: string,
    presentations: EntryPresentations | undefined,
): RegisteredPresentation | undefined {
    if (presentations === undefined) {
        return undefined;
    }

    for (const spec of presentations.prefixes) {
        if (spec.userPrefix !== undefined && text.startsWith(spec.userPrefix)) {
            return spec;
        }
    }

    return undefined;
}

/**
 * `entry.data.summary` as one short line: whitespace collapsed, empty left out, cut with an ellipsis past
 * {@link SUMMARY_LIMIT}.
 */
export function presentationSummary(data: unknown): string | undefined {
    if (typeof data !== "object" || data === null || !("summary" in data)) {
        return undefined;
    }

    const raw = (data as { summary?: unknown }).summary;

    if (typeof raw !== "string") {
        return undefined;
    }

    const collapsed = raw.replace(/\s+/g, " ").trim();

    if (collapsed === "") {
        return undefined;
    }

    return collapsed.length > SUMMARY_LIMIT
        ? `${collapsed.slice(0, SUMMARY_LIMIT - 1)}…`
        : collapsed;
}

/** `label`, or `label · summary`. `separator` is `": "` where a line already uses a colon. */
export function presentationLine(
    label: string,
    summary: string | undefined,
    separator = " · ",
): string {
    return summary === undefined || summary === "" ? label : `${label}${separator}${summary}`;
}

/** One PiP line: `▸ Label: summary`, never the message. */
export function presentationPip(label: string, summary: string | undefined): string {
    return `▸ ${presentationLine(label, summary, ": ")}`;
}

/** Whether two registries would present the same rows. */
export function samePresentations(left: EntryPresentations, right: EntryPresentations): boolean {
    if (left.byKind.size !== right.byKind.size || left.prefixes.length !== right.prefixes.length) {
        return false;
    }

    for (const [kind, spec] of left.byKind) {
        const other = right.byKind.get(kind);

        if (
            other === undefined ||
            other.label !== spec.label ||
            other.userPrefix !== spec.userPrefix
        ) {
            return false;
        }
    }

    return left.prefixes.every((spec, index) => right.prefixes[index]?.kind === spec.kind);
}

/**
 * What the queue shows instead of a waiting input's body. A registered kind always does. A prefix matches only when
 * nobody wrote the message. Undefined keeps today's body.
 */
export function queuePresentation(
    kind: string | undefined,
    content: string,
    data: unknown,
    presentations: EntryPresentations,
    wrote: boolean,
): { label: string; summary?: string } | undefined {
    let spec: RegisteredPresentation | undefined;

    if (kind !== undefined && kind !== "pi.user") {
        spec = presentations.byKind.get(kind);
    } else if (!wrote) {
        spec = matchPrefix(content, presentations);
    }

    if (spec === undefined) {
        return undefined;
    }

    const summary = presentationSummary(data);

    return summary === undefined ? { label: spec.label } : { label: spec.label, summary };
}

/** What `projectEntry` consults for one stored entry. `authors` is `AuthorsDoc.entries`: a person wrote that id. */
export function presentationOptions(
    presentations: EntryPresentations,
    authors: Readonly<Record<string, string>> | undefined,
    entryId: number,
): ProjectOptions {
    return {
        presentations,
        authored: authors?.[String(entryId)] !== undefined,
    };
}
