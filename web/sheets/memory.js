// Memory: the lessons Pi keeps, for this session's project, for everywhere, and for this session alone.
import { useEffect, useState } from "preact/hooks";
import { api, attempt, closeSheet, navigate, notify, openSheet, store } from "../store.js";
import { html, Sheet, timeAgo } from "../ui.js";

/** Memory needs its extension, and a conversation to say which project: `id`, or the one open. */
export const memoryAvailable = (id) =>
    (id ?? store.state.conversationId) !== null &&
    store.state.server?.extensions?.includes("pocket-memory") === true;

const path = (id, rest = "", pendingOnly = false) =>
    `c/${id}/memory${rest}${pendingOnly ? "?pending=all" : ""}`;

/** The lessons last fetched, keyed by person, conversation, and view: the menu can show its hint while asking again. */
let last = null;
/**
 * The fetch under way for each conversation, `{ rev, promise }`: the sheet, the menu, and each memory call ask once
 * together, PiP's calls and the open session's too.
 */
const asking = new Map();

function fetchLessons(id, rev, key, pendingOnly) {
    const fetching = asking.get(key);

    if (fetching?.rev === rev) {
        return fetching.promise;
    }

    const asked = { rev, promise: api(path(id, "", pendingOnly)) };

    asking.set(key, asked);
    // A fetch that failed is not kept: the next one asks again.
    asked.promise.catch(() => {
        if (asking.get(key) === asked) {
            asking.delete(key);
        }
    });

    return asked.promise;
}

/**
 * The lessons that apply in conversation `id` (the one open when absent), fetched when it shows and again whenever
 * they change on the server.
 */
export function useMemory(conversationId, pendingOnly = false) {
    const id = conversationId ?? store.state.conversationId;
    const { me } = store.state;
    const key = `${me?.id}:${me?.role}:${id}:${pendingOnly ? "pending" : "applying"}`;
    // Followed here, not read from the render: a call's card in the conversation is not drawn again on every change.
    const revision = (state) => `${state.memoryRev ?? 0}:${state.streamId ?? ""}`;
    const [rev, setRev] = useState(() => revision(store.state));

    useEffect(() => store.subscribe((state) => setRev(revision(state))), []);
    const on = memoryAvailable(id) && (!pendingOnly || me?.role === "owner");
    const [data, setData] = useState(last?.key === key ? last : null);
    // Asked again a few times when a fetch fails (a dropped connection, a restart), rather than loading for ever.
    const [retry, setRetry] = useState(0);

    useEffect(() => {
        let live = true;
        let timer;

        if (!on) {
            return undefined;
        }

        fetchLessons(id, rev, key, pendingOnly).then(
            (fetched) => {
                if (live) {
                    // An older running server ignores the new query: never label its scoped view as an all-project queue.
                    last = {
                        key,
                        data:
                            pendingOnly && fetched.pendingAll !== true
                                ? { restartRequired: true }
                                : fetched,
                    };
                    setData(last);
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
    }, [key, rev, on, retry]);

    return !on ? null : data?.key === key ? data.data : last?.key === key ? last.data : null;
}

/** Fetch again after a write here, without waiting for the server's word. */
function refresh() {
    store.set((state) => ({ memoryRev: (state.memoryRev ?? 0) + 1 }));
}

/** The menu's hint: how many lessons apply here, everywhere, and in this session; for the owner, how many wait. */
export function memoryHint(data) {
    if (!data) {
        return "";
    }

    const live = data.lessons.filter((lesson) => !lesson.pending);
    const count = (scope) => live.filter((lesson) => lesson.scope === scope).length;
    const session = count("session");
    const waiting = data.owner
        ? data.lessons.filter((lesson) => lesson.pending || lesson.proposal).length
        : 0;
    const parts = [
        data.project ? `${count("project")} here` : null,
        `${count("everywhere")} everywhere`,
        session > 0 ? `${session} this session` : null,
        waiting > 0 ? `${waiting} to approve` : null,
    ];

    return parts.filter(Boolean).join(" · ");
}

/**
 * The owner's review queue across every project, not just the lessons that apply here: PiP's strip, in its
 * floating panel and above its box as a board. It shows only while something waits for approval (or the server must
 * restart to list them): with none, nothing. `before` runs ahead of the sheet opening (the panel closes first).
 */
export function PendingMemories({ id, before }) {
    const data = useMemory(id, true);
    const count = data?.pendingAll === true ? data.lessons.length : 0;

    if (!data?.restartRequired && count === 0) {
        return null;
    }

    const hint = data.restartRequired ? "Restart required" : `${count} pending`;

    return html`<div class="pip-memory">
        <button
            type="button"
            class="button small ghost"
            aria-label="Pending memories"
            aria-describedby="pip-memory-count"
            onClick=${() => {
                before?.();
                openSheet({ type: "memory", conversationId: id, pendingOnly: true });
            }}
        >
            <span>Pending memories</span>
            <span
                id="pip-memory-count"
                class=${`pip-memory-count ${count > 0 ? "waiting" : ""}`}
                aria-live="polite"
                aria-atomic="true"
            >
                ${hint}
            </span>
        </button>
    </div>`;
}

/** Save a lesson by hand: for this project, everywhere, or this session. */
export async function remember(text, scope = "project", conversationId) {
    const id = conversationId ?? store.state.conversationId;
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
    const who = lesson.byPi ? "Pi" : lesson.by === me?.id ? "you" : lesson.byName;

    const open = (event) => {
        event.preventDefault();
        closeSheet();
        navigate(lesson.from.id);
    };

    return html`<div class="muted small lesson-source">
        <span>${who}</span>
        ${lesson.byPi && lesson.by !== me?.id && html`<span> for ${lesson.byName}</span>`}
        ${
            lesson.from &&
            html` · <a href=${`/s/${lesson.from.id}`} onClick=${open}>${lesson.from.title}</a>`
        }
        <span> · ${timeAgo(lesson.updatedAt ?? lesson.createdAt)}</span>
        ${(lesson.pending || lesson.proposal) && html`<span> · for ${reach(lesson)}</span>`}
    </div>`;
}

/** Where a lesson applies, said where it waits: everywhere's reach every session and PiP. */
const reach = (lesson) =>
    lesson.scope === "everywhere"
        ? "everywhere: every session, and PiP"
        : lesson.scope === "session"
          ? (lesson.projectName ?? "this session only")
          : (lesson.projectName ?? "this project");

/**
 * The scopes the sheet offers here, `[scope, label, short label for a phone]`: a project's when the session has one
 * (PiP has none), and the session's own when the server keeps them (an older one has no `limits.session`).
 */
function scopesOf(data) {
    return [
        data.project ? ["project", "This project", "Project"] : null,
        ["everywhere", "Everywhere"],
        data.limits.session !== undefined
            ? data.project
                ? ["session", "This session", "Session"]
                : ["session", "PiP only"]
            : null,
    ].filter(Boolean);
}

/** One lesson: its text, where it came from, and what this person may do with it. */
function Lesson({ lesson, data, conversationId, pendingOnly = false }) {
    const id = conversationId ?? store.state.conversationId;
    const [draft, setDraft] = useState(null);
    const [forgetting, setForgetting] = useState(false);
    const act = (rest, body = {}, done = "") =>
        attempt(async () => {
            // Fetched again either way: after a refusal (it changed since), the sheet shows what waits now.
            try {
                await api(path(id, `/${encodeURIComponent(lesson.id)}${rest}`, pendingOnly), body);
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
                <button class="button small ghost" onClick=${() => setDraft(null)}>Cancel</button>
                <button
                    class="button small primary"
                    disabled=${draft.trim() === ""}
                    onClick=${() => act("", { text: draft })}
                >
                    Save
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
                    ${lesson.proposal.byPi ? "Pi" : lesson.proposal.mine ? "You" : lesson.proposal.byName} ${lesson.proposal.forget ? "proposes forgetting it." : "proposes:"}
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
                                    "Approved: Pi goes by it from its next message.",
                                )}
                        >
                            Approve
                        </button>`
                    }
                    ${
                        (approving || withdrawing) &&
                        html`<button class="button small ghost" onClick=${() => act("/discard")}>
                            ${approving ? "Discard" : "Withdraw"}
                        </button>`
                    }
                    ${
                        lesson.mine &&
                        html`<button
                            class="button small ghost"
                            onClick=${() => setDraft(lesson.text)}
                        >
                            Edit
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
function Group({ title, lessons, data, empty, conversationId, pendingOnly = false }) {
    return html`<div class="group">
        <div class="group-title">${title}</div>
        ${lessons.length === 0 && empty && html`<p class="muted small">${empty}</p>`}
        ${
            lessons.length > 0 &&
            html`<div class="sheet-list">
                ${lessons.map(
                    (lesson) => html`<${Lesson}
                        key=${lesson.id}
                        lesson=${lesson}
                        data=${data}
                        conversationId=${conversationId}
                        pendingOnly=${pendingOnly}
                    />`,
                )}
            </div>`
        }
    </div>`;
}

/**
 * The sheet's scope: which lessons it lists, and where one added by hand goes. Each shows how many it holds, and for the
 * owner how many of them wait for approval, so none hides behind the other.
 */
function ScopeSwitch({ scope, setScope, scopes, lessons, waiting }) {
    const option = ([which, label, short]) => {
        const count = lessons.filter(
            (lesson) => lesson.scope === which && !waiting.includes(lesson),
        ).length;
        const pending = waiting.filter((lesson) => lesson.scope === which).length;
        const said = `${label}: ${count} ${count === 1 ? "lesson" : "lessons"}${pending > 0 ? `, ${pending} to approve` : ""}`;

        return html`<button
            role="radio"
            aria-checked=${scope === which ? "true" : "false"}
            aria-label=${said}
            class=${scope === which ? "on" : ""}
            onClick=${() => setScope(which)}
        >
            <span class="memory-scope-long">${label}</span>
            <span class="memory-scope-short">${short ?? label}</span>
            <span class="memory-scope-count">${count}</span>
            ${pending > 0 && html`<span class="tab-count">${pending}</span>`}
        </button>`;
    };

    return html`<div class="segmented memory-scope" role="radiogroup" aria-label="Lessons for">
        ${scopes.map(option)}
    </div>`;
}

/**
 * The lessons Pi keeps: what waits for approval, this project's, everywhere's, and this session's; and one added
 * by hand. The scope switch picks which it lists, and where a new one goes.
 */
export function MemorySheet({ draft: initial = "", conversationId, pendingOnly = false }) {
    const id = conversationId ?? store.state.conversationId;
    const data = useMemory(id, pendingOnly);
    const [text, setText] = useState(initial);
    const [scope, setScope] = useState("project");
    const [busy, setBusy] = useState(false);

    const title = pendingOnly ? "Pending memories" : "Memory";

    if (pendingOnly && store.state.me?.role !== "owner") {
        return html`<${Sheet} title=${title} onClose=${closeSheet} wide=${true}>
            <p class="muted">Only the owner can review pending memories.</p>
        <//>`;
    }

    if (!data) {
        return html`<${Sheet} title=${title} onClose=${closeSheet} wide=${true}>
            <p class="muted">Loading…</p>
        <//>`;
    }

    if (pendingOnly && data.restartRequired) {
        return html`<${Sheet} title=${title} onClose=${closeSheet} wide=${true}>
            <p class="muted">
                Restart the server from Menu → Restart server to review pending memories across projects.
            </p>
        <//>`;
    }

    const project = data.project;
    const scopes = pendingOnly ? [] : scopesOf(data);
    const chosen = scopes.some(([which]) => which === scope) ? scope : "everywhere";
    const waiting = data.owner
        ? data.lessons.filter((lesson) => lesson.pending || lesson.proposal)
        : [];
    const shown = data.lessons.filter(
        (lesson) => lesson.scope === chosen && !waiting.includes(lesson),
    );
    const waitingHere = waiting.filter((lesson) => lesson.scope === chosen);
    const sessionLabel = project ? "This session" : "PiP only";
    // The session's room: every lesson in force, those with a change that waits too (they are listed to approve).
    const inForce = data.lessons.filter(
        (lesson) => lesson.scope === "session" && !lesson.pending,
    ).length;
    const sessionEmpty = project
        ? "Nothing yet. These last for the rest of this session."
        : "Nothing yet.";
    const own = !scopes.some(([which]) => which === "session")
        ? ""
        : project
          ? "This session's own go to it and its subagents alone, and to its forks."
          : "PiP's own go to PiP alone, no session.";
    const goesTo =
        chosen === "project"
            ? `For ${project.name}`
            : chosen === "session"
              ? `For ${project ? "this session" : "PiP"} only`
              : "For every session and PiP";

    const add = () => {
        if (busy || text.trim() === "") {
            return;
        }

        setBusy(true);
        attempt(async () => {
            const lesson = await remember(text, chosen, id);

            setText("");
            notify(
                "info",
                lesson.pending
                    ? "Saved. Pi uses it once the owner approves it."
                    : "Saved. Pi gets it from its next message.",
            );
        }).finally(() => setBusy(false));
    };

    if (pendingOnly) {
        return html`<${Sheet}
            title=${title}
            onClose=${closeSheet}
            wide=${true}
            className="pending-memories"
        >
            <p class="muted small">
                Memories waiting for your approval, across every project, everywhere, and each
                session's own.
                Approve only what you want Pi to keep; until then Pi goes on as before.
            </p>
            <${Group}
                title=${`To approve · ${waiting.length}`}
                lessons=${waiting}
                data=${data}
                conversationId=${id}
                pendingOnly=${true}
                empty="No memories waiting for approval."
            />
        <//>`;
    }

    return html`<${Sheet} title=${title} onClose=${closeSheet} wide=${true}>
        <p class="muted small">
            Short lessons Pi keeps across sessions: how to build and test, gotchas, conventions, preferences. ${project ? html`Those for <b>${project.name}</b> go to every session in it, worktrees too; the rest go everywhere.` : "PiP keeps lessons for everywhere."} ${own} Pi proposes one only when asked, or when sure it will help in many later sessions, and the owner approves; yours count at once.
        </p>
        ${
            scopes.length > 1 &&
            html`<${ScopeSwitch}
                scope=${chosen}
                setScope=${setScope}
                scopes=${scopes}
                lessons=${data.lessons}
                waiting=${waiting}
            />`
        }
        ${
            data.canWrite &&
            html`<div class="lesson-add">
                <textarea
                    rows="2"
                    placeholder="e.g. Run the tests with npm test; the browser tests need Chromium."
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
                    <span class="muted small lesson-add-for">
                        ${goesTo}
                    </span>
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
            waitingHere.length > 0 &&
            html`<${Group}
                title=${`To approve · ${waitingHere.length}`}
                lessons=${waitingHere}
                data=${data}
                conversationId=${id}
            />`
        }
        ${
            chosen === "project" &&
            html`<${Group}
                title=${`This project: ${project.name}`}
                lessons=${shown}
                data=${data}
                conversationId=${id}
                empty="Nothing yet."
            />`
        }
        ${
            chosen === "everywhere" &&
            html`<${Group}
                title="Everywhere"
                lessons=${shown}
                data=${data}
                conversationId=${id}
                empty="Nothing yet."
            />`
        }
        ${
            chosen === "session" &&
            html`<${Group}
                title=${`${sessionLabel} · ${inForce} of ${data.limits.session}`}
                lessons=${shown}
                data=${data}
                conversationId=${id}
                empty=${sessionEmpty}
            />`
        }
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
        ? "A new lesson"
        : lesson.proposal.forget
          ? "Forgetting this lesson"
          : "New text for this lesson";
    const text = lesson.pending || lesson.proposal.forget ? lesson.text : lesson.proposal.text;

    return html`<div class="lesson-call waiting">
        <div class="grow">
            <div>${what}, for ${reach(lesson)}, waits for ${data.owner ? "you" : "the owner"}:</div>
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
                            "Approved: Pi goes by it from its next message.",
                        )}
                >
                    Approve
                </button>
                <button
                    class="button small ghost"
                    onClick=${() => act("/discard", {}, "Discarded.")}
                >
                    Discard
                </button>`
        }
    </div>`;
}
