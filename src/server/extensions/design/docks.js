// The side panel of the workspace: versions, comments, text edits, and tweaks. On a wide panel it sits beside the canvas,
// on a narrow one under it.
import { createCheck } from "./check.js";
import { openOf, pinNumber } from "./comments.js";
import { nameOf } from "./edits.js";
import { commentsMessage, editsMessage, tweaksMessage } from "./messages.js";
import { changed, coerce, show } from "./tweaks.js";

export function createDocks(env) {
    const { pocket, store, data, parts } = env;
    const { html, useEffect, useRef, useState, Switch } = pocket;
    const { Ico, ago } = parts;

    const versionTitle = (version, latest) =>
        `${version.version === latest ? "Newest" : `Version ${version.version}`}${version.restoredFrom ? ` · from v${version.restoredFrom}` : ""}`;
    const versionNote = (version) =>
        `${ago(version.createdAt)} · ${(version.size / 1024).toFixed(1)} KB`;
    const confirmText = (latest, from) =>
        `Make version ${latest + 1} from version ${from}? Nothing is lost: every version stays.`;

    function DockHead({ title, count, children }) {
        return html`<header class="dsn-dock-head">
            <h3>${title}${count > 0 && html` <span class="dsn-count">${count}</span>`}</h3>
            <span class="grow"></span>
            ${children}
            <button
                type="button"
                class="icon-button"
                title="Close"
                aria-label="Close"
                onClick=${() => env.setDock(null)}
            >
                <${Ico} name="close" size=${16} />
            </button>
        </header>`;
    }

    const { CheckDock } = createCheck(env, DockHead);

    // ─── Versions ────────────────────────────────────────────────────────────

    function VersionsDock({ s, design, shown, canEdit }) {
        const [asking, setAsking] = useState(null);
        const [busy, setBusy] = useState(false);
        const latest = design.versions.at(-1)?.version ?? 1;
        const list = [...design.versions].reverse();

        const goBack = async (version) => {
            setBusy(true);

            const made = await data.restore(design.id, version);

            setBusy(false);
            setAsking(null);

            if (made !== null) {
                env.showVersion(null);
                pocket.notify("info", `Version ${made} is a copy of version ${version}.`);
            }
        };

        return html`<${DockHead} title="Versions" count=${design.versions.length}>
                ${
                    list.length > 1 &&
                    html`<button
                        type="button"
                        class="dsn-link"
                        onClick=${() => env.compare(shown === latest ? latest - 1 : shown, latest)}
                    >
                        <${Ico} name="compare" size=${14} /> Compare
                    </button>`
                }
            <//>
            <div class="dsn-dock-body">
                <ol class="dsn-versions">
                    ${list.map(
                        (version) =>
                            html`<li
                                class=${`dsn-version ${version.version === shown ? "on" : ""}`}
                                key=${version.version}
                            >
                                <button
                                    type="button"
                                    class="dsn-version-main"
                                    onClick=${() => env.showVersion(version.version === latest ? null : version.version)}
                                >
                                    <span class="dsn-version-no mono">v${version.version}</span>
                                    <span class="dsn-version-info">
                                        <span>${versionTitle(version, latest)}</span>
                                        <span class="muted small">${versionNote(version)}</span>
                                    </span>
                                    ${version.version === shown && html`<${Ico} name="check" size=${15} />`}
                                </button>
                                <div class="dsn-version-actions">
                                    ${
                                        version.version !== latest &&
                                        html`<button
                                            type="button"
                                            class="dsn-link"
                                            onClick=${() => env.compare(version.version, latest)}
                                        >
                                            Compare
                                        </button>`
                                    }
                                    ${
                                        version.version !== latest &&
                                        canEdit &&
                                        asking !== version.version &&
                                        html`<button
                                            type="button"
                                            class="dsn-link"
                                            onClick=${() => setAsking(version.version)}
                                        >
                                            Go back to this one
                                        </button>`
                                    }
                                </div>
                                ${
                                    asking === version.version &&
                                    html`<div
                                        class="dsn-confirm"
                                        ref=${(element) => element?.scrollIntoView({ block: "nearest" })}
                                    >
                                        <span>${confirmText(latest, version.version)}</span>
                                        <span class="dsn-confirm-actions">
                                            <button
                                                type="button"
                                                class="button small primary"
                                                disabled=${busy}
                                                onClick=${() => goBack(version.version)}
                                            >
                                                ${busy ? "Making it…" : "Go back"}
                                            </button>
                                            <button
                                                type="button"
                                                class="button small"
                                                disabled=${busy}
                                                onClick=${() => setAsking(null)}
                                            >
                                                Cancel
                                            </button>
                                        </span>
                                    </div>`
                                }
                            </li>`,
                    )}
                </ol>
            </div>`;
    }

    // ─── Comments ────────────────────────────────────────────────────────────

    function Composer({ design, draft, onDone }) {
        const [text, setText] = useState("");
        const [busy, setBusy] = useState(false);
        const box = useRef(null);

        useEffect(() => box.current?.focus({ preventScroll: true }), [draft]);

        const submit = async () => {
            if (text.trim() === "" || busy) {
                return;
            }

            setBusy(true);

            const ok = await data.addComment(design.id, draft.version, draft.target, text.trim());

            setBusy(false);

            if (ok) {
                setText("");
                onDone();
            }
        };

        return html`<form
            class="dsn-composer"
            onSubmit=${(event) => {
                event.preventDefault();
                void submit();
            }}
        >
            <div class="dsn-composer-target">
                <${Ico} name="target" size=${14} />
                <span>${nameOf(draft.target)}</span>
                <span class="muted small mono">v${draft.version}</span>
            </div>
            <textarea
                ref=${box}
                rows="3"
                placeholder="What should change here?"
                maxlength="2000"
                value=${text}
                onInput=${(event) => setText(event.currentTarget.value)}
                onKeyDown=${(event) => {
                    if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
                        event.preventDefault();
                        void submit();
                    }
                }}
            ></textarea>
            <div class="dsn-composer-actions">
                <button type="button" class="button small" onClick=${onDone}>Cancel</button>
                <button
                    type="submit"
                    class="button small primary"
                    disabled=${busy || text.trim() === ""}
                >
                    Add comment
                </button>
            </div>
        </form>`;
    }

    function CommentsDock({ s, design, shown, canEdit, me }) {
        const [showDone, setShowDone] = useState(false);
        const sent = s.sent[design.id] ?? null;
        const setSent = (ids) => store.set((now) => ({ sent: { ...now.sent, [design.id]: ids } }));
        const notes = s.notes[design.id];
        const comments = notes?.comments ?? [];
        const open = openOf(comments);
        const done = comments.filter((comment) => comment.resolved);
        const draft = s.draft?.artifact === design.id ? s.draft : null;

        const send = () => {
            env.sendToBox(
                commentsMessage({
                    title: design.title,
                    id: design.id,
                    version: shown,
                    comments: open,
                }),
            );
            setSent(open.map((comment) => comment.id));
        };

        const row = (comment) => {
            const number = pinNumber(comments, comment, shown);
            const mine = comment.by === me?.id || me?.role === "owner";

            return html`<li
                class=${`dsn-comment ${comment.resolved ? "done" : ""}`}
                key=${comment.id}
            >
                <span class=${`dsn-pin ${number === 0 ? "off" : ""}`} aria-hidden="true"
                    >${number === 0 ? "·" : number}</span
                >
                <div class="dsn-comment-body">
                    <div class="dsn-comment-head">
                        <strong>${comment.byName || "Someone"}</strong>
                        <span class="muted small">${ago(comment.at)}</span>
                        ${
                            comment.version !== shown &&
                            html`<button
                                type="button"
                                class="dsn-chip mono"
                                title=${`Show version ${comment.version}`}
                                onClick=${() => env.showVersion(comment.version === design.versions.at(-1)?.version ? null : comment.version)}
                            >
                                v${comment.version}
                            </button>`
                        }
                    </div>
                    <p>${comment.text}</p>
                    <div class="muted small dsn-comment-target">${nameOf(comment.target)}</div>
                </div>
                ${
                    canEdit &&
                    html`<div class="dsn-comment-actions">
                        <button
                            type="button"
                            class="icon-button"
                            title=${comment.resolved ? "Open it again" : "Mark done"}
                            aria-label=${comment.resolved ? "Open it again" : "Mark done"}
                            onClick=${() => data.patchComment(design.id, comment.id, { resolved: !comment.resolved })}
                        >
                            <${Ico} name=${comment.resolved ? "undo" : "check"} size=${15} />
                        </button>
                        ${
                            mine &&
                            html`<button
                                type="button"
                                class="icon-button"
                                title="Delete"
                                aria-label="Delete"
                                onClick=${() => data.removeComment(design.id, comment.id)}
                            >
                                <${Ico} name="trash" size=${15} />
                            </button>`
                        }
                    </div>`
                }
            </li>`;
        };

        return html`<${DockHead} title="Comments" count=${open.length}>
                ${
                    canEdit &&
                    open.length > 0 &&
                    html`<button
                        type="button"
                        class="dsn-link"
                        onClick=${() =>
                            data.resolveMany(
                                design.id,
                                open.map((comment) => comment.id),
                            )}
                    >
                        All done
                    </button>`
                }
            <//>
            <div class="dsn-dock-body">
                ${
                    !canEdit &&
                    html`<p class="muted small dsn-note">
                        You can read the comments here. Only people who can steer the session add
                        them.
                    </p>`
                }
                ${
                    draft &&
                    canEdit &&
                    html`<${Composer}
                        key=${draft.target.selector}
                        design=${design}
                        draft=${draft}
                        onDone=${() => store.set({ draft: null })}
                    />`
                }
                ${
                    open.length === 0 &&
                    !draft &&
                    html`<p class="muted small dsn-empty">
                        ${canEdit ? "No open comments. Turn on Comment, then tap an element." : "No open comments."}
                    </p>`
                }
                <ul class="dsn-comments">
                    ${open.map(row)}
                </ul>
                ${
                    done.length > 0 &&
                    html`<button
                        type="button"
                        class="dsn-link dsn-done-toggle"
                        onClick=${() => setShowDone(!showDone)}
                    >
                        ${showDone ? "Hide" : "Show"} done (${done.length})
                    </button>`
                }
                ${
                    showDone &&
                    html`<ul class="dsn-comments">
                        ${done.map(row)}
                    </ul>`
                }
            </div>
            ${
                canEdit &&
                open.length > 0 &&
                html`<footer class="dsn-dock-foot">
                    ${
                        sent &&
                        html`<span class="muted small">
                            ${"In your message box. After Pi makes the new version, "}
                            <button
                                type="button"
                                class="dsn-link"
                                onClick=${() => {
                                    data.resolveMany(design.id, sent);
                                    setSent(null);
                                }}
                            >
                                mark them done</button
                            >.
                        </span>`
                    }
                    <button type="button" class="button primary" onClick=${send}>
                        <${Ico} name="send" size=${15} /> Send ${open.length} to Pi
                    </button>
                </footer>`
            }`;
    }

    // ─── Text edits ──────────────────────────────────────────────────────────

    function EditsDock({ s, design, shown, canEdit }) {
        const at = `${design.id}@${shown}`;
        const edits = s.edits[at] ?? [];

        const apply = () => {
            env.sendToBox(
                editsMessage({ title: design.title, id: design.id, version: shown, edits }),
            );
            // The message has them now: the list starts empty for the next ones.
            store.set((now) => ({ edits: { ...now.edits, [at]: [] } }));
        };

        const discard = () => {
            store.set((now) => ({ edits: { ...now.edits, [at]: [] } }));
            env.reloadFrame();
        };

        return html`<${DockHead} title="Text edits" count=${edits.length}>
                ${
                    edits.length > 0 &&
                    html`<button type="button" class="dsn-link" onClick=${discard}>Discard</button>`
                }
            <//>
            <div class="dsn-dock-body">
                ${
                    edits.length === 0 &&
                    html`<p class="muted small dsn-empty">
                        ${canEdit ? "Tap text on the canvas, change it, and tap away. Each change lands here." : "Nobody has edited text here."}
                    </p>`
                }
                <ul class="dsn-edits">
                    ${edits.map(
                        (edit, index) =>
                            html`<li class="dsn-edit" key=${index}>
                                <div class="muted small">${nameOf(edit.target)}</div>
                                <div class="dsn-edit-before">${edit.before}</div>
                                <div class="dsn-edit-after">${edit.after}</div>
                                <button
                                    type="button"
                                    class="icon-button"
                                    title="Leave this one out of the message"
                                    aria-label="Leave this one out of the message"
                                    onClick=${() =>
                                        store.set((now) => ({
                                            edits: {
                                                ...now.edits,
                                                [at]: edits.filter((_, each) => each !== index),
                                            },
                                        }))}
                                >
                                    <${Ico} name="close" size=${14} />
                                </button>
                            </li>`,
                    )}
                </ul>
            </div>
            ${
                canEdit &&
                edits.length > 0 &&
                html`<footer class="dsn-dock-foot">
                    <button type="button" class="button primary" onClick=${apply}>
                        <${Ico} name="send" size=${15} /> Apply ${edits.length} with Pi
                    </button>
                </footer>`
            }`;
    }

    // ─── Tweaks ──────────────────────────────────────────────────────────────

    function Knob({ knob, value, disabled, onChange }) {
        const label = html`<label class="dsn-knob-label">
            <span>${knob.label}</span>
            <span class="mono small muted">${show(knob, value)}</span>
        </label>`;

        let control;

        if (knob.type === "range") {
            control = html`<input
                type="range"
                data-no-swipe
                min=${knob.min}
                max=${knob.max}
                step=${knob.step}
                value=${value}
                disabled=${disabled}
                aria-label=${knob.label}
                onInput=${(event) => onChange(Number(event.currentTarget.value))}
            />`;
        } else if (knob.type === "color") {
            control = html`<span class="dsn-color">
                <input
                    type="color"
                    value=${/^#[0-9a-f]{6}$/i.test(value) ? value : "#000000"}
                    disabled=${disabled}
                    aria-label=${knob.label}
                    onInput=${(event) => onChange(event.currentTarget.value)}
                />
                <input
                    type="text"
                    class="mono"
                    value=${value}
                    disabled=${disabled}
                    spellcheck="false"
                    aria-label=${`${knob.label}, as text`}
                    onChange=${(event) => onChange(event.currentTarget.value)}
                />
            </span>`;
        } else if (knob.type === "select") {
            control = html`<select
                value=${value}
                disabled=${disabled}
                aria-label=${knob.label}
                onChange=${(event) => onChange(event.currentTarget.value)}
            >
                ${knob.options.map((option) => html`<option value=${option.value}>${option.label}</option>`)}
            </select>`;
        } else if (knob.type === "toggle") {
            control = html`<${Switch}
                on=${value === true}
                label=${knob.label}
                disabled=${disabled}
                onChange=${() => onChange(!value)}
            />`;
        } else {
            control = html`<input
                type="text"
                value=${value}
                disabled=${disabled}
                aria-label=${knob.label}
                onChange=${(event) => onChange(event.currentTarget.value)}
            />`;
        }

        return html`<div class="dsn-knob" data-type=${knob.type}>${label}${control}</div>`;
    }

    function TweaksDock({ s, design, shown, canEdit }) {
        const knobs = s.knobs;
        const values = s.tweaks[design.id] ?? {};
        const moved = changed(knobs, values);

        const keep = () =>
            env.sendToBox(
                tweaksMessage({
                    title: design.title,
                    id: design.id,
                    version: shown,
                    changes: moved.map((knob) => ({ knob, value: values[knob.name] })),
                }),
            );

        return html`<${DockHead} title="Tweaks" count=${moved.length}>
                ${
                    moved.length > 0 &&
                    canEdit &&
                    html`<button
                        type="button"
                        class="dsn-link"
                        onClick=${() => env.resetTweaks(design.id)}
                    >
                        Reset
                    </button>`
                }
            <//>
            <div class="dsn-dock-body" data-no-swipe>
                ${
                    knobs.length === 0 &&
                    html`<div class="dsn-empty">
                        <p class="muted small">
                            This design has no tweaks. Tweaks are knobs for colors, spacing, type,
                            and more that change the page live, without a new version.
                        </p>
                        ${
                            canEdit &&
                            html`<button
                                type="button"
                                class="button small"
                                onClick=${() =>
                                    env.sendToBox(
                                        `Add tweaks to ${design.title} (artifact \`${design.id}\`): 3 to 8 knobs for the things I would want to adjust, such as the accent color, spacing, and type size, in the design's tweaks manifest.`,
                                    )}
                            >
                                Ask Pi for tweaks
                            </button>`
                        }
                    </div>`
                }
                ${
                    !canEdit &&
                    knobs.length > 0 &&
                    html`<p class="muted small dsn-note">
                        Tweaks are for people who can steer the session.
                    </p>`
                }
                ${
                    knobs.length > 0 &&
                    html`<div class="dsn-knobs">
                        ${knobs.map(
                            (knob) =>
                                html`<${Knob}
                                    key=${knob.name}
                                    knob=${knob}
                                    value=${Object.hasOwn(values, knob.name) ? values[knob.name] : knob.value}
                                    disabled=${!canEdit}
                                    onChange=${(value) => {
                                        const clean = coerce(knob, value);

                                        if (clean !== undefined) {
                                            env.setTweak(design.id, knob, clean);
                                        }
                                    }}
                                />`,
                        )}
                        <p class="muted small dsn-note">
                            Only you see your tweaks. They stay with you for this design. “Keep
                            these” asks Pi to write them in.
                        </p>
                    </div>`
                }
            </div>
            ${
                canEdit &&
                moved.length > 0 &&
                html`<footer class="dsn-dock-foot">
                    <button type="button" class="button primary" onClick=${keep}>
                        <${Ico} name="send" size=${15} /> Keep these ${moved.length}
                    </button>
                </footer>`
            }`;
    }

    const DOCKS = {
        versions: "Versions",
        comments: "Comments",
        edits: "Text edits",
        tweaks: "Tweaks",
        check: "Check",
    };

    /** Sheet height on a phone, in percent of the room under the bars: shut (a bar), middle, high. */
    const SHEET_SNAPS = [8, 54, 88];
    const SHEET_WORDS = ["shut", "middle", "high"];

    function SheetHandle({ s }) {
        const handle = useRef(null);
        const drag = useRef(null);
        const index = Math.min(SHEET_SNAPS.length - 1, Math.max(0, s.checkSheet));

        const settle = (to) => {
            const next = Math.min(SHEET_SNAPS.length - 1, Math.max(0, to));
            const dock = handle.current?.closest(".dsn-dock");

            if (next === 0) {
                dock?.style.removeProperty("--sheet");
            } else {
                dock?.style.setProperty("--sheet", `${SHEET_SNAPS[next]}%`);
            }

            store.set({ checkSheet: next });
        };

        return html`<div
            ref=${handle}
            class="dsy-sheet-handle"
            role="separator"
            aria-orientation="horizontal"
            aria-label="Height of the findings. Drag, or press the arrow keys."
            aria-valuemin="0"
            aria-valuemax=${SHEET_SNAPS.length - 1}
            aria-valuenow=${index}
            aria-valuetext=${SHEET_WORDS[index]}
            tabindex="0"
            onPointerDown=${(event) => {
                const dock = handle.current.closest(".dsn-dock");

                try {
                    handle.current.setPointerCapture(event.pointerId);
                } catch {
                    // A pointer that is gone (or made up): the drag still follows the moves that reach the handle.
                }

                drag.current = {
                    dock,
                    room: dock.parentElement.getBoundingClientRect(),
                    share: null,
                };
            }}
            onPointerMove=${(event) => {
                const now = drag.current;

                if (now) {
                    now.share = Math.min(
                        0.94,
                        Math.max(0.08, (now.room.bottom - event.clientY) / now.room.height),
                    );
                    now.dock.style.setProperty("--sheet", `${now.share * 100}%`);
                }
            }}
            onPointerUp=${() => {
                const now = drag.current;

                drag.current = null;

                if (now === null) {
                    return;
                }

                if (now.share === null) {
                    settle((index + 1) % SHEET_SNAPS.length);
                } else {
                    const near = SHEET_SNAPS.map((snap) => Math.abs(snap / 100 - now.share));

                    settle(near.indexOf(Math.min(...near)));
                }
            }}
            onKeyDown=${(event) => {
                if (event.key === "ArrowUp" || event.key === "ArrowDown") {
                    event.preventDefault();
                    settle(index + (event.key === "ArrowUp" ? 1 : -1));
                } else if (event.key === "Enter" || event.key === " ") {
                    event.preventDefault();
                    settle((index + 1) % SHEET_SNAPS.length);
                }
            }}
        >
            <span></span>
        </div>`;
    }

    /** The dock for `s.dock`, or nothing. */
    function Dock({ s, design, shown, canEdit, me }) {
        const props = { s, design, shown, canEdit, me };
        const sheet = s.dock === "check" && env.sizeClass(s) === "narrow";
        const shut = sheet && s.checkSheet === 0;
        const body =
            s.dock === "versions"
                ? html`<${VersionsDock} ...${props} />`
                : s.dock === "comments"
                  ? html`<${CommentsDock} ...${props} />`
                  : s.dock === "edits"
                    ? html`<${EditsDock} ...${props} />`
                    : s.dock === "tweaks"
                      ? html`<${TweaksDock} ...${props} />`
                      : s.dock === "check"
                        ? html`<${CheckDock} ...${props} shut=${shut} />`
                        : null;

        return (
            body &&
            html`<aside
                class="dsn-dock"
                data-dock=${s.dock}
                data-sheet=${sheet}
                data-shut=${shut}
                aria-label=${DOCKS[s.dock]}
                style=${sheet && !shut ? `--sheet:${SHEET_SNAPS[Math.min(2, Math.max(0, s.checkSheet))]}%` : undefined}
            >
                ${sheet && !shut && html`<${SheetHandle} s=${s} />`} ${body}
            </aside>`
        );
    }

    return { Dock };
}
