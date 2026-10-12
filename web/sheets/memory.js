// Memory: the lessons Pi keeps across sessions, for this session's project and for everywhere.
import { useEffect, useState } from "preact/hooks";
import { t } from "../i18n.js";
import { api, attempt, closeSheet, navigate, notify, store } from "../store.js";
import { html, Sheet, timeAgo } from "../ui.js";

/** Memory needs its extension, and a conversation to say which project: `id`, or the one open. */
export const memoryAvailable = (id) =>
    (id ?? store.state.conversationId) !== null &&
    store.state.server?.extensions?.includes("pocket-memory") === true;

const path = (id, rest = "") => `c/${id}/memory${rest}`;

/** The lessons last fetched, `{ id, data }`: the menu shows its hint from them at once while it asks again. */
let last = null;
/**
 * The fetch under way for each conversation, `{ rev, promise }`: the sheet, the menu, and each memory call ask once
 * together, PiP's calls and the open session's too.
 */
const asking = new Map();

function fetchLessons(id, rev) {
    const fetching = asking.get(id);

    if (fetching?.rev === rev) {
        return fetching.promise;
    }

    const asked = { rev, promise: api(path(id)) };

    asking.set(id, asked);
    // A fetch that failed is not kept: the next one asks again.
    asked.promise.catch(() => {
        if (asking.get(id) === asked) {
            asking.delete(id);
        }
    });

    return asked.promise;
}

/**
 * The lessons that apply in conversation `id` (the one open when absent), fetched when it shows and again whenever
 * they change on the server.
 */
export function useMemory(conversationId) {
    const id = conversationId ?? store.state.conversationId;
    // Followed here, not read from the render: a call's card in the conversation is not drawn again on every change.
    const [rev, setRev] = useState(store.state.memoryRev ?? 0);

    useEffect(() => store.subscribe((state) => setRev(state.memoryRev ?? 0)), []);
    const on = memoryAvailable(id);
    const [data, setData] = useState(last?.id === id ? last.data : null);
    // Asked again a few times when a fetch fails (a dropped connection, a restart), rather than loading for ever.
    const [retry, setRetry] = useState(0);

    useEffect(() => {
        let live = true;
        let timer;

        if (!on) {
            return undefined;
        }

        fetchLessons(id, rev).then(
            (fetched) => {
                last = { id, data: fetched };

                if (live) {
                    setData(fetched);
                }
            },
            () => {
                if (live && retry < 3) {
                    timer = setTimeout(() => setRetry(retry + 1), 2000 * (retry + 1));
                }
            },
        );

        return () => {
            live = false;
            clearTimeout(timer);
        };
    }, [id, rev, on, retry]);

    return last?.id === id ? (data ?? last.data) : data;
}

/** Fetch again after a write here, without waiting for the server's word. */
function refresh() {
    store.set((state) => ({ memoryRev: (state.memoryRev ?? 0) + 1 }));
}

/** The menu's hint: how many lessons apply here and everywhere, and for the owner how many wait for approval. */
export function memoryHint(data) {
    if (!data) {
        return "";
    }

    const live = data.lessons.filter((lesson) => !lesson.pending);
    const here = live.filter((lesson) => lesson.scope === "project").length;
    const everywhere = live.length - here;
    const waiting = data.owner
        ? data.lessons.filter((lesson) => lesson.pending || lesson.proposal).length
        : 0;
    const parts = [
        data.project ? t("{{count}} here", { count: here }) : null,
        t("{{count}} everywhere", { count: everywhere }),
        waiting > 0 ? t("{{count}} to approve", { count: waiting }) : null,
    ];

    return parts.filter(Boolean).join(" · ");
}

/** Save a lesson by hand: for this project, or everywhere. */
export async function remember(text, scope = "project") {
    const id = store.state.conversationId;
    const lesson = await api(path(id), { text, scope });

    refresh();

    return lesson;
}

/** What the owner saw waiting, sent with Approve: the server approves only if it still waits. */
function approval(lesson) {
    if (lesson.pending) {
        return { text: lesson.text };
    }

    return lesson.proposal?.forget ? { forget: true } : { text: lesson.proposal?.text };
}

/** Who saved a lesson, and where it came from, in a line. */
function Source({ lesson }) {
    const { me } = store.state;
    const who = lesson.byPi ? "Pi" : lesson.by === me?.id ? t("you") : lesson.byName;

    const open = (event) => {
        event.preventDefault();
        closeSheet();
        navigate(lesson.from.id);
    };

    return html`<div class="muted small lesson-source">
        <span>${who}</span>
        ${lesson.byPi && lesson.by !== me?.id && html`<span> ${t("for {{name}}", { name: lesson.byName })}</span>`}
        ${
            lesson.from &&
            html` · <a href=${`/s/${lesson.from.id}`} onClick=${open}>${lesson.from.title}</a>`
        }
        <span> · ${timeAgo(lesson.updatedAt ?? lesson.createdAt)}</span>
        ${(lesson.pending || lesson.proposal) && html`<span> · ${t("for {{scope}}", { scope: reach(lesson) })}</span>`}
    </div>`;
}

/** Where a lesson applies, said where it waits: everywhere's reach every session and PiP. */
const reach = (lesson) =>
    t(lesson.scope === "everywhere" ? "everywhere: every session, and PiP" : "this project");

/** One lesson: its text, where it came from, and what this person may do with it. */
function Lesson({ lesson, data }) {
    const id = store.state.conversationId;
    const [draft, setDraft] = useState(null);
    const [forgetting, setForgetting] = useState(false);
    const act = (rest, body = {}, done = "") =>
        attempt(async () => {
            // Fetched again either way: after a refusal (it changed since), the sheet shows what waits now.
            try {
                await api(path(id, `/${encodeURIComponent(lesson.id)}${rest}`), body);
            } finally {
                refresh();
            }

            setDraft(null);
            setForgetting(false);

            if (done) {
                notify("info", done);
            }
        });
    const approving = data.owner && (lesson.pending || lesson.proposal);
    const withdrawing = !data.owner && lesson.proposal?.mine;

    if (draft !== null) {
        return html`<div class="lesson">
            <textarea
                rows="3"
                autofocus
                maxlength=${data.limits.text}
                value=${draft}
                onInput=${(event) => setDraft(event.currentTarget.value)}
            ></textarea>
            <div class="row lesson-actions">
                <button class="button small ghost" onClick=${() => setDraft(null)}>${t("Cancel")}</button>
                <button
                    class="button small primary"
                    disabled=${draft.trim() === ""}
                    onClick=${() => act("", { text: draft })}
                >
                    ${t("Save")}
                </button>
            </div>
        </div>`;
    }

    return html`<div class=${`lesson ${lesson.pending ? "pending" : ""}`}>
        <div class="lesson-text">${lesson.text}</div>
        ${
            lesson.proposal &&
            html`<div class="lesson-proposal">
                <span class="muted small">
                    ${t(lesson.proposal.forget ? "{{name}} proposes forgetting it." : "{{name}} proposes:", { name: lesson.proposal.byPi ? "Pi" : lesson.proposal.mine ? t("You") : lesson.proposal.byName })}
                </span>
                ${lesson.proposal.text && html`<div class="lesson-text">${lesson.proposal.text}</div>`}
            </div>`
        }
        ${
            (lesson.pending || lesson.proposal) &&
            !data.owner &&
            html`<div class="muted small">Waits for the owner's approval; until then Pi goes on as before.</div>`
        }
        <div class="lesson-foot">
            <${Source} lesson=${lesson} />
            ${
                (lesson.mine || approving || withdrawing) &&
                html`<div class="row lesson-actions">
                    ${
                        approving &&
                        html`<button
                            class="button small primary"
                            onClick=${() =>
                                act(
                                    "/approve",
                                    approval(lesson),
                                    t("Approved: Pi goes by it from its next message."),
                                )}
                        >
                            Approve
                        </button>`
                    }
                    ${
                        (approving || withdrawing) &&
                        html`<button class="button small ghost" onClick=${() => act("/discard")}>
                            ${t(approving ? "Discard" : "Withdraw")}
                        </button>`
                    }
                    ${
                        lesson.mine &&
                        html`<button
                            class="button small ghost"
                            onClick=${() => setDraft(lesson.text)}
                        >
                            ${t("Edit")}
                        </button>`
                    }
                    ${
                        lesson.mine &&
                        !(approving && lesson.pending) &&
                        html`<button
                            class=${`button small ghost ${forgetting ? "danger" : ""}`}
                            onClick=${() => (forgetting ? act("/remove") : setForgetting(true))}
                            onBlur=${() => setForgetting(false)}
                        >
                            ${forgetting ? "Forget it" : "Forget"}
                        </button>`
                    }
                </div>`
            }
        </div>
    </div>`;
}

/** A group of lessons with its title, or nothing when it has none. */
function Group({ title, lessons, data, empty }) {
    return html`<div class="group">
        <div class="group-title">${title}</div>
        ${lessons.length === 0 && empty && html`<p class="muted small">${empty}</p>`}
        ${lessons.map((lesson) => html`<${Lesson} key=${lesson.id} lesson=${lesson} data=${data} />`)}
    </div>`;
}

/** The lessons Pi keeps: what waits for approval, this project's, and everywhere's; and one added by hand. */
export function MemorySheet({ draft: initial = "" }) {
    const data = useMemory();
    const [text, setText] = useState(initial);
    const [scope, setScope] = useState("project");
    const [busy, setBusy] = useState(false);

    if (!data) {
        return html`<${Sheet} title="Memory" onClose=${closeSheet}>
            <p class="muted">${t("Loading…")}</p>
        <//>`;
    }

    const project = data.project;
    const chosen = project ? scope : "everywhere";
    const waiting = data.owner
        ? data.lessons.filter((lesson) => lesson.pending || lesson.proposal)
        : [];
    const shown = data.lessons.filter((lesson) => !waiting.includes(lesson));

    const add = () => {
        if (busy || text.trim() === "") {
            return;
        }

        setBusy(true);
        attempt(async () => {
            const lesson = await remember(text, chosen);

            setText("");
            notify(
                "info",
                lesson.pending
                    ? t("Saved. Pi uses it once the owner approves it.")
                    : t("Saved. Pi gets it from its next message."),
            );
        }).finally(() => setBusy(false));
    };

    return html`<${Sheet} title="Memory" onClose=${closeSheet}>
        <p class="muted small">
            ${t("Short lessons Pi keeps across sessions: how to build and test, gotchas, conventions, preferences.")} ${project ? t("Those for {{project}} go to every session in it, worktrees too; the rest go everywhere.", { project: project.name }) : t("PiP keeps lessons for everywhere.")} ${t("Pi proposes them as it learns, and the owner approves; yours count at once.")}
        </p>
        ${
            data.canWrite &&
            html`<div class="lesson-add">
                <textarea
                    rows="2"
                    placeholder=${t("e.g. Run the tests with npm test; the browser tests need Chromium.")}
                    maxlength=${data.limits.text}
                    value=${text}
                    onInput=${(event) => setText(event.currentTarget.value)}
                    onKeyDown=${(event) => {
                        if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
                            event.preventDefault();
                            add();
                        }
                    }}
                ></textarea>
                <div class="row">
                    ${
                        project &&
                        html`<div class="segmented grow" role="radiogroup" aria-label=${t("For")}>
                            <button
                                role="radio"
                                aria-checked=${chosen === "project" ? "true" : "false"}
                                class=${chosen === "project" ? "on" : ""}
                                onClick=${() => setScope("project")}
                            >
                                This project
                            </button>
                            <button
                                role="radio"
                                aria-checked=${chosen === "everywhere" ? "true" : "false"}
                                class=${chosen === "everywhere" ? "on" : ""}
                                onClick=${() => setScope("everywhere")}
                            >
                                Everywhere
                            </button>
                        </div>`
                    }
                    <button
                        class="button primary"
                        disabled=${busy || text.trim() === ""}
                        onClick=${add}
                    >
                        Remember
                    </button>
                </div>
            </div>`
        }
        ${
            waiting.length > 0 &&
            html`<${Group} title=${t("To approve · {{count}}", { count: waiting.length })} lessons=${waiting} data=${data} />`
        }
        ${
            project &&
            html`<${Group}
                title=${`${t("This project")}: ${project.name}`}
                lessons=${shown.filter((lesson) => lesson.scope === "project")}
                data=${data}
                empty=${t("Nothing yet.")}
            />`
        }
        <${Group}
            title=${t("Everywhere")}
            lessons=${shown.filter((lesson) => lesson.scope === "everywhere")}
            data=${data}
            empty=${t("Nothing yet.")}
        />
    <//>`;
}

/**
 * Under Pi's memory call: what became of the lesson it saved, changed, or forgot, in conversation `conversationId` (the
 * one open when absent). While it waits, the owner reads it and approves or discards it right here, without opening
 * the sheet.
 */
export function LessonCall({ lessonId, conversationId }) {
    const id = conversationId ?? store.state.conversationId;
    const data = useMemory(id);

    if (!data) {
        return null;
    }

    const lesson = data.lessons.find((each) => each.id === lessonId);
    // Fetched again either way: after a refusal (it changed since), the card shows what waits now.
    const act = (rest, body, done) =>
        attempt(async () => {
            try {
                await api(path(id, `/${encodeURIComponent(lessonId)}${rest}`), body);
            } finally {
                refresh();
            }

            notify("info", done);
        });

    // One waiting for the owner is hidden from others: say nothing rather than that it is gone.
    if (!lesson) {
        return data.owner
            ? html`<div class="lesson-call muted small">No longer in memory.</div>`
            : null;
    }

    if (!lesson.pending && !lesson.proposal) {
        return html`<div class="lesson-call muted small">In memory: Pi goes by it.</div>`;
    }

    const what = lesson.pending
        ? t("A new lesson")
        : lesson.proposal.forget
          ? t("Forgetting this lesson")
          : t("New text for this lesson");
    const text = lesson.pending || lesson.proposal.forget ? lesson.text : lesson.proposal.text;

    return html`<div class="lesson-call waiting">
        <div class="grow">
            <div>${t("{{what}}, for {{scope}}, waits for {{who}}:", { what, scope: reach(lesson), who: t(data.owner ? "you" : "the owner") })}</div>
            <div class="lesson-text">${text}</div>
        </div>
        ${
            data.owner &&
            html`<button
                    class="button small primary"
                    onClick=${() =>
                        act(
                            "/approve",
                            approval(lesson),
                            t("Approved: Pi goes by it from its next message."),
                        )}
                >
                    Approve
                </button>
                <button
                    class="button small ghost"
                    onClick=${() => act("/discard", {}, t("Discarded."))}
                >
                    Discard
                </button>`
        }
    </div>`;
}
