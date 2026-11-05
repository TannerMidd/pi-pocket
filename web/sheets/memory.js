// Memory: the lessons Pi keeps across sessions, for this session's project and for everywhere.
import { useEffect, useState } from "preact/hooks";
import { api, attempt, closeSheet, navigate, notify, store } from "../store.js";
import { html, Sheet, timeAgo } from "../ui.js";
import { t } from "../ui-locale.js";

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
        data.project
            ? t("web.sheets.memory.memory-hint.parts.content", "{here} here", { here })
            : null,
        t("web.sheets.memory.memory-hint.parts.everywhere", "{everywhere} everywhere", {
            everywhere,
        }),
        waiting > 0
            ? t("web.sheets.memory.memory-hint.parts.approve", "{waiting} to approve", {
                  waiting,
              })
            : null,
    ];

    return parts.filter(Boolean).join(" · ");
}

/** Save a lesson by hand: for this project, or everywhere. */
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
    const who = lesson.byPi
        ? "Pi"
        : lesson.by === me?.id
          ? t("web.sheets.memory.source.who.content", "you")
          : lesson.byName;

    const open = (event) => {
        event.preventDefault();
        closeSheet();
        navigate(lesson.from.id);
    };

    return html`<div class="muted small lesson-source">
        <span>${who}</span>
        ${lesson.byPi && lesson.by !== me?.id && html`<span> ${t("web.sheets.memory.source.span.for-name", "for {name}", { name: lesson.byName })}</span>`}
        ${
            lesson.from &&
            html` · <a href=${`/s/${lesson.from.id}`} onClick=${open}>${lesson.from.title}</a>`
        }
        <span> · ${timeAgo(lesson.updatedAt ?? lesson.createdAt)}</span>
        ${(lesson.pending || lesson.proposal) && html`<span> ${t("web.sheets.memory.source.span.content", "· for {detail}", { detail: reach(lesson) })}</span>`}
    </div>`;
}

/** Where a lesson applies, said where it waits: everywhere's reach every session and PiP. */
const reach = (lesson) =>
    lesson.scope === "everywhere"
        ? t(
              "web.sheets.memory.reach.everywhere-every-session-pi-p",
              "everywhere: every session, and PiP",
          )
        : (lesson.projectName ?? t("web.sheets.memory.reach.project", "this project"));

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
                <button class="button small ghost" onClick=${() => setDraft(null)}>${t(
                    "web.sheets.memory.lesson.button.cancel",
                    "Cancel",
                )}</button>
                <button
                    class="button small primary"
                    disabled=${draft.trim() === ""}
                    onClick=${() => act("", { text: draft })}
                >
                    ${t("web.sheets.memory.lesson.button.save", "Save")}
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
                    ${lesson.proposal.byPi ? "Pi" : lesson.proposal.mine ? t("web.sheets.memory.lesson.span.content", "You") : lesson.proposal.byName} ${lesson.proposal.forget ? t("web.sheets.memory.lesson.span.proposes-forgetting", "proposes forgetting it.") : t("web.sheets.memory.lesson.span.proposes", "proposes:")}
                </span>
                ${lesson.proposal.text && html`<div class="lesson-text">${lesson.proposal.text}</div>`}
            </div>`
        }
        ${
            (lesson.pending || lesson.proposal) &&
            !data.owner &&
            html`<div class="muted small">${t("web.sheets.memory.lesson.div.waits-owner-s-approval", "Waits for the owner's approval; until then Pi goes on as before.")}</div>`
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
                                    t(
                                        "web.sheets.memory.lesson.text.approved-pi-goes-next",
                                        "Approved: Pi goes by it from its next message.",
                                    ),
                                )}
                        >
                            ${t("web.sheets.memory.lesson.button.approve", "Approve")}
                        </button>`
                    }
                    ${
                        (approving || withdrawing) &&
                        html`<button class="button small ghost" onClick=${() => act("/discard")}>
                            ${
                                approving
                                    ? t("web.sheets.memory.lesson.button.discard", "Discard")
                                    : t("web.sheets.memory.lesson.button.withdraw", "Withdraw")
                            }
                        </button>`
                    }
                    ${
                        lesson.mine &&
                        html`<button
                            class="button small ghost"
                            onClick=${() => setDraft(lesson.text)}
                        >
                            ${t("web.sheets.memory.lesson.button.edit", "Edit")}
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
                            ${
                                forgetting
                                    ? t("web.sheets.memory.lesson.button.forget", "Forget it")
                                    : t("web.sheets.memory.lesson.button.forget.forget", "Forget")
                            }
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

/** The lessons Pi keeps: what waits for approval, this project's, and everywhere's; and one added by hand. */
export function MemorySheet({ draft: initial = "", conversationId, pendingOnly = false }) {
    const id = conversationId ?? store.state.conversationId;
    const data = useMemory(id, pendingOnly);
    const [text, setText] = useState(initial);
    const [scope, setScope] = useState("project");
    const [busy, setBusy] = useState(false);

    const title = pendingOnly
        ? t("web.sheets.memory.memory-sheet.title.pending-memories", "Pending memories")
        : t("web.sheets.memory.memory-sheet.title.memory", "Memory");

    if (pendingOnly && store.state.me?.role !== "owner") {
        return html`<${Sheet} title=${title} onClose=${closeSheet}>
            <p class="muted">${t(
                "web.sheets.memory.memory-sheet.p.owner-review-pending-memories",
                "Only the owner can review pending memories.",
            )}</p>
        <//>`;
    }

    if (!data) {
        return html`<${Sheet} title=${title} onClose=${closeSheet}>
            <p class="muted">${t("web.sheets.memory.memory-sheet.p.loading", "Loading…")}</p>
        <//>`;
    }

    if (pendingOnly && data.restartRequired) {
        return html`<${Sheet} title=${title} onClose=${closeSheet}>
            <p class="muted">
                ${t("web.sheets.memory.memory-sheet.p.restart-server-menu-review", "Restart the server from Menu → Restart server to review pending memories across projects.")}
            </p>
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
            const lesson = await remember(text, chosen, id);

            setText("");
            notify(
                "info",
                lesson.pending
                    ? t(
                          "web.sheets.memory.memory-sheet.add.saved-pi-uses-once",
                          "Saved. Pi uses it once the owner approves it.",
                      )
                    : t(
                          "web.sheets.memory.memory-sheet.add.saved-pi-gets-next",
                          "Saved. Pi gets it from its next message.",
                      ),
            );
        }).finally(() => setBusy(false));
    };

    if (pendingOnly) {
        return html`<${Sheet} title=${title} onClose=${closeSheet}>
            <p class="muted small">
                ${t(
                    "web.sheets.memory.memory-sheet.p.memories-waiting-approval-across",
                    "Memories waiting for your approval, across every project and everywhere. Approve only what you want Pi to keep; until then Pi goes on as before.",
                )}
            </p>
            <${Group}
                title=${t("web.sheets.memory.memory-sheet.title.approve", "To approve · {count}", {
                    count: waiting.length,
                })}
                lessons=${waiting}
                data=${data}
                conversationId=${id}
                pendingOnly=${true}
                empty=${t(
                    "web.sheets.memory.memory-sheet.p.no-memories-waiting",
                    "No memories waiting for approval.",
                )}
            />
        <//>`;
    }

    return html`<${Sheet} title=${title} onClose=${closeSheet}>
        <p class="muted small">
            ${t(
                "web.sheets.memory.memory-sheet.p.short-lessons-pi-keeps",
                "Short lessons Pi keeps across sessions: how to build and test, gotchas, conventions, preferences. {name} Pi proposes one only when asked, or when sure it will help in many later sessions, and the owner approves; yours count at once.",
                {
                    name: project
                        ? t(
                              "web.sheets.memory.memory-sheet.p.those-for-project",
                              "Those for {name} go to every session in it, worktrees too; the rest go everywhere.",
                              { name: project.name },
                          )
                        : t(
                              "web.sheets.memory.memory-sheet.p.pi-p-keeps-lessons-everywhere",
                              "PiP keeps lessons for everywhere.",
                          ),
                },
            )}
        </p>
        ${
            data.canWrite &&
            html`<div class="lesson-add">
                <textarea
                    rows="2"
                    placeholder=${t(
                        "web.sheets.memory.memory-sheet.placeholder.e-g-run-tests",
                        "e.g. Run the tests with npm test; the browser tests need Chromium.",
                    )}
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
                        html`<div class="segmented grow" role="radiogroup" aria-label=${t(
                            "web.sheets.memory.memory-sheet.aria-label.for",
                            "For",
                        )}>
                            <button
                                role="radio"
                                aria-checked=${chosen === "project" ? "true" : "false"}
                                class=${chosen === "project" ? "on" : ""}
                                onClick=${() => setScope("project")}
                            >
                                ${t(
                                    "web.sheets.memory.memory-sheet.button.this-project",
                                    "This project",
                                )}
                            </button>
                            <button
                                role="radio"
                                aria-checked=${chosen === "everywhere" ? "true" : "false"}
                                class=${chosen === "everywhere" ? "on" : ""}
                                onClick=${() => setScope("everywhere")}
                            >
                                ${t(
                                    "web.sheets.memory.memory-sheet.button.everywhere",
                                    "Everywhere",
                                )}
                            </button>
                        </div>`
                    }
                    <button
                        class="button primary"
                        disabled=${busy || text.trim() === ""}
                        onClick=${add}
                    >
                        ${t("web.sheets.memory.memory-sheet.button.remember", "Remember")}
                    </button>
                </div>
            </div>`
        }
        ${
            waiting.length > 0 &&
            html`<${Group}
                title=${t("web.sheets.memory.memory-sheet.title.approve", "To approve · {count}", {
                    count: waiting.length,
                })}
                lessons=${waiting}
                data=${data}
                conversationId=${id}
            />`
        }
        ${
            project &&
            html`<${Group}
                title=${t("web.sheets.memory.memory-sheet.title.project", "This project: {name}", {
                    name: project.name,
                })}
                lessons=${shown.filter((lesson) => lesson.scope === "project")}
                data=${data}
                conversationId=${id}
                empty=${t("web.sheets.memory.memory-sheet.p.nothing-yet", "Nothing yet.")}
            />`
        }
        <${Group}
            title=${t("web.sheets.memory.memory-sheet.title.everywhere", "Everywhere")}
            lessons=${shown.filter((lesson) => lesson.scope === "everywhere")}
            data=${data}
            conversationId=${id}
            empty=${t("web.sheets.memory.memory-sheet.p.nothing-yet", "Nothing yet.")}
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
            ? html`<div class="lesson-call muted small">${t(
                  "web.sheets.memory.lesson-call.div.no-longer-in-memory",
                  "No longer in memory.",
              )}</div>`
            : null;
    }

    if (!lesson.pending && !lesson.proposal) {
        return html`<div class="lesson-call muted small">${t(
            "web.sheets.memory.lesson-call.div.memory-pi-goes",
            "In memory: Pi goes by it.",
        )}</div>`;
    }

    const what = lesson.pending
        ? t("web.sheets.memory.lesson-call.what.new-lesson", "A new lesson")
        : lesson.proposal.forget
          ? t("web.sheets.memory.lesson-call.what.forgetting-lesson", "Forgetting this lesson")
          : t("web.sheets.memory.lesson-call.what.new-text-lesson", "New text for this lesson");
    const text = lesson.pending || lesson.proposal.forget ? lesson.text : lesson.proposal.text;

    return html`<div class="lesson-call waiting">
        <div class="grow">
            <div>
                ${t(
                    "web.sheets.memory.lesson-call.div.waits",
                    "{what}, for {detail}, waits for {detail2}:",
                    {
                        what,
                        detail: reach(lesson),
                        detail2: data.owner
                            ? t("web.sheets.memory.lesson-call.div.content", "you")
                            : t("web.sheets.memory.lesson-call.div.owner", "the owner"),
                    },
                )}
            </div>
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
                            t(
                                "web.sheets.memory.lesson-call.text.approved-pi-goes-next",
                                "Approved: Pi goes by it from its next message.",
                            ),
                        )}
                >
                    ${t("web.sheets.memory.lesson-call.button.approve", "Approve")}
                </button>
                <button
                    class="button small ghost"
                    onClick=${() =>
                        act(
                            "/discard",
                            {},
                            t("web.sheets.memory.lesson-call.text.discarded", "Discarded."),
                        )}
                >
                    ${t("web.sheets.memory.lesson-call.button.discard", "Discard")}
                </button>`
        }
    </div>`;
}
