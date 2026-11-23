// Every way to copy a session opens one sheet, laid out the same: a title, what is copied, rows of choices (a label on
// the left, a value on the right that opens a picker), one main button, and small actions under it. The button tapped
// decides the action: fork from a reply (`message.js`), send a message again (`message.js`), or fork the whole session
// from the session list (here). The rows choose where the copy runs (a computer and a folder there), with which model
// and thinking level, and in a git worktree of its own. Unchanged rows copy as the session is.
import { useEffect, useState } from "preact/hooks";
import { chooseFolder, copyDraft, modelOf, updateDraft, useCopyDraft } from "../copy-draft.js";
import { shortPath } from "../folder-paths.js";
import { waitOnComputer } from "../runner-wait.js";
import {
    actions,
    api,
    attempt,
    canSteer,
    closeSheet,
    navigate,
    notify,
    openSheet,
    scoped,
    store,
} from "../store.js";
import { html, Icon, Sheet, Switch } from "../ui.js";

// ─── Rows ─────────────────────────────────────────────────────────────────────────

/** A group of choice rows, one under another. */
export function ChoiceRows({ children, label }) {
    return html`<div class="choice-rows" role="group" aria-label=${label}>${children}</div>`;
}

/**
 * One choice: its label on the left, its value on the right with a muted line under it (`sub`), and a chevron when a
 * tap opens a picker (`onPick`). `open`: the picker it opens shows under it.
 */
export function ChoiceRow({ label, value, sub = null, onPick = null, open = undefined, title }) {
    const body = html`<span class="choice-label">${label}</span>
        <span class="choice-value">
            <span class="choice-main">${value}</span>
            ${sub && html`<span class="choice-sub">${sub}</span>`}
        </span>`;

    if (!onPick) {
        return html`<div class="choice-row" title=${title}>${body}</div>`;
    }

    return html`<button
        type="button"
        class="choice-row"
        title=${title}
        aria-expanded=${open === undefined ? undefined : open ? "true" : "false"}
        onClick=${onPick}
    >
        ${body}
        <${Icon} name=${open ? "down" : "chevron"} size=${14} class="choice-chev" />
    </button>`;
}

/** A choice that is on or off: its label, a muted note, and a switch. */
export function SwitchRow({ label, on, disabled = false, note = null, onChange }) {
    return html`<div class=${`choice-row ${disabled ? "off" : ""}`}>
        <span class="choice-label">${label}</span>
        <span class="choice-value">
            ${note && html`<span class="choice-sub">${note}</span>`}
        </span>
        <${Switch} on=${on} disabled=${disabled} label=${label} onChange=${onChange} />
    </div>`;
}

// ─── Where the copy runs ─────────────────────────────────────────────────────────

/** Why the folder shown is the one suggested (`commands.ts` `copySuggestion`), in a few words. */
const REASONS = {
    current: "this session's folder",
    repository: "same repository",
    name: "same folder name",
    home: "home: no match, pick one",
    picked: null,
};

/** A computer's name: This server, a linked one's, or the session's own when the list does not have it. */
function computerName(runner) {
    if (runner === null || runner === undefined) {
        return "This server";
    }

    const view = store.state.view;

    return (
        store.state.runners.find((each) => each.id === runner)?.name ??
        (view.conversation?.runner === runner ? view.conversation.runnerName : undefined) ??
        store.state.sessions.find((each) => each.runner === runner && each.runnerName)
            ?.runnerName ??
        "another computer"
    );
}

/** A computer's home folder, for short paths: this server's, or a linked computer's as it last reported. */
const homeOf = (runner) =>
    runner === null || runner === undefined
        ? store.state.server?.home
        : store.state.runners.find((each) => each.id === runner)?.home;

/** A model and thinking level in a few words: "Claude Opus 5.5 · high". */
function modelText(ref, level) {
    if (!ref) {
        return "No model";
    }

    const model = modelOf(ref);

    if (!model) {
        return `${ref.modelId}${level && level !== "off" ? ` · ${level}` : ""}`;
    }

    return `${model.name}${model.reasoning ? ` · ${level ?? "off"}` : ""}`;
}

/** Ask the server for a computer's suggested folder (or about `cwd`, one picked), and the session's own place. */
function askPlace(sessionId, runner, cwd = null) {
    const query = new URLSearchParams();

    if (runner !== undefined) {
        query.set("runner", runner ?? "");
    }

    if (cwd) {
        query.set("cwd", cwd);
    }

    return api(`c/${sessionId}/copy-place?${query}`);
}

/**
 * The choices of one copy: kept while a picker over the sheet is open, loaded from the server when the sheet first
 * opens. `extra`, more initial choices (an edited message's text).
 */
export function usePlace(sessionId, key, extra = () => ({})) {
    const draft = useCopyDraft(key, () => ({ ...extra(), worktree: false, computers: false }));

    useEffect(() => {
        if (draft.source || draft.asking) {
            return;
        }

        updateDraft({ asking: true });
        askPlace(sessionId, undefined).then(
            (place) =>
                updateDraft({
                    asking: false,
                    source: place.from,
                    runner: place.runner,
                    cwd: place.cwd,
                    reason: place.reason,
                    inRepository: place.inRepository,
                    model: place.from.model ?? null,
                    thinkingLevel: place.from.thinkingLevel ?? "off",
                }),
            (error) => {
                updateDraft({ asking: false, failed: error.message });
            },
        );
    }, [key]);

    // A folder picked on this server: whether it is a git repository, for the worktree row.
    useEffect(() => {
        const now = copyDraft();

        if (
            !now?.source ||
            now.runner !== null ||
            now.inRepository !== undefined ||
            now.picked === undefined
        ) {
            return;
        }

        askPlace(sessionId, null, now.picked).then(
            (place) => {
                if (copyDraft()?.picked === now.picked) {
                    updateDraft({
                        inRepository: place.inRepository,
                        ...(place.inRepository ? {} : { worktree: false }),
                    });
                }
            },
            () => {},
        );
    }, [draft.picked]);

    return draft;
}

/** Another computer chosen: its suggested folder, and no worktree. */
function chooseComputer(sessionId, runner) {
    updateDraft({ computers: false });

    if (runner === copyDraft()?.runner) {
        return;
    }

    updateDraft({ runner, cwd: null, reason: null, worktree: false, inRepository: undefined });
    askPlace(sessionId, runner).then(
        (place) => {
            if (copyDraft()?.runner === runner) {
                updateDraft({
                    cwd: place.cwd,
                    reason: place.reason,
                    picked: undefined,
                    inRepository: place.inRepository,
                });
            }
        },
        (error) => notify("error", error.message),
    );
}

/**
 * The rows that choose where a copy runs: computer, folder, model, worktree; and, for another computer, that it asks
 * first. `verb`, the action in the folder picker's title ("Fork", "Send again").
 */
export function PlaceRows({ sessionId, draft, verb }) {
    const { runners, me } = store.state;
    const owner = me?.role === "owner";
    const loaded = draft.source !== undefined;
    const runner = loaded ? draft.runner : undefined;
    const name = loaded ? computerName(runner) : "…";
    const there = runner !== null && runner !== undefined;
    const choices = [
        { id: null, name: "This server", online: true },
        // Each person gets only the linked computers they may use.
        ...runners,
        // The session's own computer, when the list does not have it.
        ...(there && !runners.some((each) => each.id === runner)
            ? [{ id: runner, name, online: true }]
            : []),
    ];

    useEffect(() => {
        // The linked computers, when this tab has not got the list yet.
        if (owner && runners.length === 0) {
            api("runners").then(
                (list) => store.set({ runners: list }),
                () => {},
            );
        }
    }, []);

    const online = runners.find((each) => each.id === runner)?.online;
    const pickFolder = () =>
        openSheet({
            type: "cwd",
            mode: "pick",
            runner: runner ?? null,
            start: draft.cwd ?? "~",
            title: `${verb}: pick a folder on ${name}`,
        });
    const pickModel = () => openSheet({ type: "model", choose: true });

    return html`<${ChoiceRows} label="Where the copy runs">
            <${ChoiceRow}
                label="Computer"
                value=${html`<span class="choice-computer">
                    ${there && html`<span class=${`runner-dot ${online === false ? "" : "on"}`}></span>`}
                    ${name}
                </span>`}
                sub=${there && online === false ? "offline" : null}
                open=${draft.computers}
                onPick=${loaded && choices.length > 1 ? () => updateDraft({ computers: !draft.computers }) : null}
            />
            ${
                draft.computers &&
                html`<div class="choice-options" role="radiogroup" aria-label="Computer">
                    ${choices.map(
                        (each) => html`<button
                            key=${each.id ?? "server"}
                            type="button"
                            role="radio"
                            class=${`choice-option ${each.id === runner ? "on" : ""}`}
                            aria-checked=${each.id === runner ? "true" : "false"}
                            disabled=${!each.online}
                            onClick=${() => chooseComputer(sessionId, each.id)}
                        >
                            <${Icon} name=${each.id === null ? "home" : "monitor"} size=${15} />
                            <span class="grow">${each.name}</span>
                            ${each.id !== null && !each.online && html`<span class="muted small">offline</span>`}
                            ${each.id !== null && html`<span class=${`runner-dot ${each.online ? "on" : ""}`}></span>`}
                            ${each.id === runner && html`<${Icon} name="check" size=${14} />`}
                        </button>`,
                    )}
                </div>`
            }
            <${ChoiceRow}
                label="Folder"
                value=${html`<bdi dir="ltr">${draft.cwd ? shortPath(draft.cwd, homeOf(runner)) : "…"}</bdi>`}
                sub=${draft.reason ? REASONS[draft.reason] : null}
                title=${draft.cwd ?? undefined}
                onPick=${loaded && draft.cwd ? pickFolder : null}
            />
            <${ChoiceRow}
                label="Model"
                value=${loaded ? modelText(draft.model, draft.thinkingLevel) : "…"}
                onPick=${loaded ? pickModel : null}
            />
            <${SwitchRow}
                label="Own git worktree"
                on=${draft.worktree}
                disabled=${!loaded || (!there && !draft.inRepository)}
                note=${loaded && draft.inRepository === false ? "not a git repository" : null}
                onChange=${() => updateDraft({ worktree: !draft.worktree })}
            />
        <//>
        ${
            there &&
            html`<p class="muted small copy-asks">
                ${name} asks before the copy starts. Its tools run there.
            </p>`
        }
        ${draft.failed && html`<p class="muted small copy-asks">${draft.failed}</p>`}`;
}

/**
 * What the copy's request says of its place: only what the person changed, so a copy with no row changed is the copy
 * it always was. Undefined: nothing changed.
 */
export function placeOf(draft) {
    const source = draft.source;

    if (!source) {
        return undefined;
    }

    const place = {};
    const moved = draft.runner !== source.runner;

    if (moved) {
        place.runner = draft.runner;
    }

    if (draft.cwd && (moved || draft.cwd !== source.cwd)) {
        place.cwd = draft.cwd;
    }

    // A model or level changed: both go, so the copy has the pair the sheet shows.
    if (
        draft.model &&
        (draft.model.provider !== source.model?.provider ||
            draft.model.modelId !== source.model?.modelId ||
            draft.thinkingLevel !== (source.thinkingLevel ?? "off"))
    ) {
        place.model = draft.model;
        place.thinkingLevel = draft.thinkingLevel;
    }

    if (draft.worktree) {
        place.worktree = true;
    }

    return Object.keys(place).length === 0 ? undefined : place;
}

/** A copy on its way: a second tap waits for it. */
let copying = false;

/** Make the copy with `run` and open it. A second tap while the first is on its way does nothing. */
export function startCopy(run, notice, draft) {
    if (copying) {
        return Promise.resolve();
    }

    copying = true;

    return attempt(async () => {
        const created = await (draft?.runner
            ? waitOnComputer(draft.runner, draft.cwd, "fork", run)
            : run(undefined));

        if (!created) {
            return;
        }

        navigate(created.id);
        notify("info", notice);
    }).finally(() => {
        copying = false;
    });
}

/** Ctrl/⌘+Enter presses the main button while the sheet `type` is on top. */
export function useMainKey(type, press) {
    useEffect(() => {
        const onKey = (event) => {
            if (
                event.key === "Enter" &&
                (event.ctrlKey || event.metaKey) &&
                !event.isComposing &&
                store.state.sheet?.type === type
            ) {
                event.preventDefault();
                press();
            }
        };

        addEventListener("keydown", onKey);

        return () => removeEventListener("keydown", onKey);
    }, [type, press]);
}

// ─── Fork a whole session ─────────────────────────────────────────────────────────

/** Session menu → Fork: a copy of the whole session, with the place rows. */
export function ForkSessionSheet({ id }) {
    const session = store.state.sessions.find((each) => each.id === id);
    const draft = usePlace(id, `session:${id}`);
    const [busy, setBusy] = useState(false);
    const starts = canSteer() && !scoped();

    const go = () => {
        if (busy || !starts) {
            return;
        }

        setBusy(true);
        startCopy(
            (signal) => actions.forkSession(id, placeOf(draft), signal),
            "Opened the fork. The original is unchanged.",
            draft,
        ).finally(() => setBusy(false));
    };

    useMainKey("fork", go);

    return html`<${Sheet} title="Fork this session" onClose=${closeSheet} className="copy-sheet">
        <div class="copy-what">${session?.title ?? "New session"}</div>
        <${PlaceRows} sessionId=${id} draft=${draft} verb="Fork" />
        <div class="copy-go">
            <button type="button" class="button primary wide" disabled=${busy} onClick=${go}>
                Fork
            </button>
            <p class="muted small">
                A new session with everything up to the last reply. The original stays as it is.
            </p>
        </div>
    <//>`;
}
