// Webhooks and watches: addresses other services post to, each turning every post into a message to Pi in a session or
// to PiP; and the repository watches PiP set up, which need no address.
import { useEffect, useRef, useState } from "preact/hooks";
import { pipAvailable } from "../pip.js";
import { api, attempt, closeSheet, navigate, notify, store } from "../store.js";
import { copyText, formatWhen, html, Sheet } from "../ui.js";

/** A hook's full address: the server's public one when it has one, else the one this browser uses. */
const addressOf = (base, hook) => `${(base ?? location.origin).replace(/\/$/, "")}${hook.path}`;

function copy(text, what) {
    copyText(text).then(
        () => notify("info", what),
        () => notify("error", "Could not copy."),
    );
}

/**
 * One hook: where it sends, what Pi is told to do, how it has been used; its address (and a signed one's secret), a new
 * secret, and removing it.
 */
function HookRow({ hook, base, fresh, editable, onSaved, onRemove, onRotate }) {
    const [draft, setDraft] = useState(null);
    const [saving, setSaving] = useState(false);
    const savingNow = useRef(false);
    const field = useRef(null);
    const change = useRef(null);
    const edited = useRef(false);
    const editing = draft !== null;

    useEffect(() => {
        if (editing) {
            field.current?.focus();
        } else if (edited.current) {
            change.current?.focus();
        }

        edited.current = editing;
    }, [editing]);

    const save = () => {
        if (savingNow.current) {
            return;
        }

        savingNow.current = true;
        setSaving(true);
        attempt(async () => {
            const updated = await api(`hooks/${encodeURIComponent(hook.id)}`, {
                instructions: draft,
            });

            onSaved(updated);
            setDraft(null);
        }).finally(() => {
            savingNow.current = false;
            setSaving(false);
        });
    };

    const open = (event) => {
        event.preventDefault();
        closeSheet();
        navigate(hook.target);
    };

    const used =
        hook.count === 0
            ? "no posts yet"
            : `${hook.count} post${hook.count === 1 ? "" : "s"}, last ${formatWhen(hook.lastAt)}`;
    const status = [
        hook.signed ? "GitHub, signed" : "secret in the address",
        ...(hook.anyone ? ["from anyone"] : []),
        used,
    ].join(" · ");

    return html`<div class=${`hook ${fresh ? "fresh" : ""}`}>
        <div class="hook-head">
            <strong class="grow">${hook.name}</strong>
            <span class="muted small">
                to ${hook.pip ? "PiP" : html`<a href=${`/s/${hook.target}`} onClick=${open}>${hook.targetTitle}</a>`}
            </span>
        </div>
        ${
            editing
                ? html`<div class="field">
                    <div class="label">What Pi should do with each post</div>
                    <textarea
                        aria-label=${`Edit the prompt of ${hook.name}`}
                        rows="4"
                        maxlength="2000"
                        ref=${field}
                        disabled=${saving}
                        value=${draft}
                        onInput=${(event) => setDraft(event.currentTarget.value)}
                    ></textarea>
                    <div class="muted small">
                        Applies to future posts. Leave empty for the default instructions.
                    </div>
                    <div class="hook-actions">
                        <button
                            class="button small ghost"
                            disabled=${saving}
                            onClick=${() => setDraft(null)}
                        >
                            Cancel
                        </button>
                        <button class="button small primary" disabled=${saving} onClick=${save}>
                            ${saving ? "Saving…" : "Save"}
                        </button>
                    </div>
                </div>`
                : hook.instructions && html`<div class="hook-text">${hook.instructions}</div>`
        }
        ${
            fresh &&
            html`<div class="mono small hook-address">${addressOf(base, hook)}</div>
                ${hook.signed && html`<div class="mono small hook-address">Secret: ${hook.secret}</div>`}`
        }
        <div class="hook-actions">
            <span class="muted small grow hook-status">${status}</span>
            <button
                class="button small"
                onClick=${() => copy(addressOf(base, hook), hook.signed ? "Address copied: GitHub's Payload URL." : "Address copied. Keep it secret: anyone with it can message Pi.")}
            >
                Copy address
            </button>
            ${
                hook.signed &&
                html`<button
                    class="button small"
                    onClick=${() => copy(hook.secret, "Secret copied: GitHub's Secret.")}
                >
                    Copy secret
                </button>`
            }
            ${
                editable &&
                draft === null &&
                html`<button
                    class="button small ghost"
                    ref=${change}
                    onClick=${() => setDraft(hook.instructions)}
                >
                    Edit prompt
                </button>`
            }
            <button class="button small ghost" disabled=${saving} onClick=${onRotate}>
                New secret
            </button>
            <button class="button small ghost" disabled=${saving} onClick=${onRemove}>
                Remove
            </button>
        </div>
    </div>`;
}

/**
 * A repository watch PiP set up: the repository, what it looks for, where it sends; whether strangers' issues and PRs
 * reach it (only a person turns that on, never PiP), and removing it.
 */
function WatchRow({ watch, onRemove, onAnyone }) {
    const open = (event) => {
        event.preventDefault();
        closeSheet();
        navigate(watch.target);
    };

    const narrowed = [
        watch.label && `label ${watch.label}`,
        watch.assigned && "assigned to you",
        watch.events.includes("ci") && `CI on ${watch.branch}`,
    ].filter(Boolean);

    return html`<div class="hook">
        <div class="hook-head">
            <strong class="grow">${watch.repo}</strong>
            <span class="muted small">
                to ${watch.pip ? "PiP" : html`<a href=${`/s/${watch.target}`} onClick=${open}>${watch.targetTitle}</a>`}
            </span>
        </div>
        <div class="muted small">${watch.events.join(", ")}${narrowed.length > 0 ? ` · ${narrowed.join(", ")}` : ""}</div>
        ${watch.instructions && html`<div class="hook-text">${watch.instructions}</div>`}
        <div class="hook-actions">
            <span class="muted small grow">
                ${watch.count === 0 ? "nothing sent yet" : `${watch.count} sent, last ${formatWhen(watch.lastNewsAt)}`}${watch.note ? ` · ${watch.errors > 0 ? "last look failed" : "waiting"}: ${watch.note}` : ""}
            </span>
            <button class="button small ghost" onClick=${onRemove}>Remove</button>
        </div>
        <label class="check">
            <input type="checkbox" checked=${watch.anyone === true} onChange=${onAnyone} />
            From anyone, not only the repository's people
        </label>
    </div>`;
}

/** The person's webhooks (every one, for the owner), and a form to make one for this session or for PiP. */
export function HooksSheet() {
    const { view, me } = store.state;
    const here =
        view.conversation?.kind === "session" && !view.conversation.pip ? view.conversation : null;
    const [list, setList] = useState(null);
    const [name, setName] = useState("");
    const [instructions, setInstructions] = useState("");
    const [target, setTarget] = useState(here ? "here" : "pip");
    const [github, setGithub] = useState(true);
    const [anyone, setAnyone] = useState(false);
    const [making, setMaking] = useState(false);
    const makingNow = useRef(false);
    const [fresh, setFresh] = useState(null);
    const steer = me?.role !== "viewer";
    const load = () => attempt(async () => setList(await api("hooks")));
    const targets = [here && ["here", "This session"], pipAvailable() && ["pip", "PiP"]].filter(
        Boolean,
    );

    useEffect(() => void load(), []);

    // One hook per tap: a second tap while the first is on its way would make another, with its own secret.
    const make = () => {
        if (makingNow.current) {
            return;
        }

        makingNow.current = true;
        setMaking(true);
        attempt(async () => {
            const hook = await api("hooks", {
                target: target === "pip" ? "pip" : here.id,
                name: name.trim(),
                instructions: instructions.trim(),
                signed: github,
                anyone: github && anyone,
            });

            setName("");
            setInstructions("");
            setAnyone(false);
            setFresh(hook.id);
            await load();
        }).finally(() => {
            makingNow.current = false;
            setMaking(false);
        });
    };

    const remove = (hook) =>
        attempt(async () => {
            if (
                !confirm(
                    `Remove the webhook “${hook.name}”? Posts to its address stop reaching Pi.`,
                )
            ) {
                return;
            }

            await api(`hooks/${encodeURIComponent(hook.id)}/remove`, {});
            await load();
        });
    const rotate = (hook) =>
        attempt(async () => {
            const where = hook.signed
                ? "Paste the new one into GitHub's Secret for it."
                : "Give the new address to whatever posts to it.";

            if (
                !confirm(
                    `A new secret for “${hook.name}”: posts with the old one stop getting in. ${where}`,
                )
            ) {
                return;
            }

            await api(`hooks/${encodeURIComponent(hook.id)}/rotate`, {});
            setFresh(hook.id);
            await load();
        });

    const unwatch = (watch) =>
        attempt(async () => {
            if (!confirm(`Stop watching ${watch.repo}? Nothing more comes from it.`)) {
                return;
            }

            await api(`repo-watches/${encodeURIComponent(watch.id)}/remove`, {});
            await load();
        });

    const setWatchAnyone = (watch, event) => {
        const on = event.currentTarget.checked;

        attempt(async () => {
            if (
                on &&
                !confirm(
                    `Let anyone's issues and PRs on ${watch.repo} reach ${watch.pip ? "PiP" : "Pi"}? Strangers' words then come with your instructions.`,
                )
            ) {
                return;
            }

            await api(`repo-watches/${encodeURIComponent(watch.id)}/anyone`, { anyone: on });
        }).finally(load);
    };

    return html`<${Sheet} title="Webhooks and watches" onClose=${closeSheet} wide=${true}>
        <p class="muted small">
            Other services (GitHub, a deploy, a monitor) post to a webhook's address, and each post becomes a message to Pi in a session, or to PiP: your instructions, then what came.
        </p>
        ${
            steer &&
            targets.length > 0 &&
            html`<div class="hook-form">
                <div class="field">
                    <div class="label">Name</div>
                    <input
                        aria-label="Name"
                        placeholder="Deploys"
                        maxlength="60"
                        value=${name}
                        onInput=${(event) => setName(event.currentTarget.value)}
                    />
                </div>
                <div class="field">
                    <div class="label">What Pi should do with each post</div>
                    <textarea
                        aria-label="What Pi should do with each post"
                        rows="3"
                        maxlength="2000"
                        placeholder="When a deploy fails, find out why and fix it. Ignore the ones that pass."
                        value=${instructions}
                        onInput=${(event) => setInstructions(event.currentTarget.value)}
                    ></textarea>
                </div>
                <div class="field">
                    <div class="label">Posted by</div>
                    <div class="segmented">
                        <button
                            class=${github ? "on" : ""}
                            aria-pressed=${github}
                            onClick=${() => setGithub(true)}
                        >
                            GitHub
                        </button>
                        <button
                            class=${github ? "" : "on"}
                            aria-pressed=${!github}
                            onClick=${() => setGithub(false)}
                        >
                            Another service
                        </button>
                    </div>
                    <div class="muted small">
                        ${github ? "Signed: GitHub gets the address and, separately, a secret; the address alone lets nothing in." : "The secret is in the address: anyone who has it can message Pi as you."}
                    </div>
                </div>
                ${
                    github &&
                    html`<label class="check">
                        <input
                            type="checkbox"
                            checked=${anyone}
                            onChange=${(event) => setAnyone(event.currentTarget.checked)}
                        />
                        From anyone: issues, PRs, and comments by people outside the repository too
                    </label>
                    <div class="muted small">
                        ${anyone ? "Strangers' words reach Pi too, fenced as data." : "Off: posts about issues, PRs, and comments by people who cannot write to the repository are dropped (a 202 says so), and their words in other posts are left out. GitHub is asked who can write: gh must be able to push there."}
                    </div>`
                }
                ${
                    targets.length > 1 &&
                    html`<div class="field">
                        <div class="label">Sends to</div>
                        <div class="segmented">
                            ${targets.map(
                                ([value, label]) => html`<button
                                    class=${target === value ? "on" : ""}
                                    aria-pressed=${target === value}
                                    onClick=${() => setTarget(value)}
                                >
                                    ${label}
                                </button>`,
                            )}
                        </div>
                        <div class="muted small">
                            ${target === "pip" ? "PiP decides what to do: start a session, message one, or tell you." : `Pi in “${here?.title}” gets each post.`}
                        </div>
                    </div>`
                }
                <button
                    class="button primary wide"
                    disabled=${name.trim() === "" || making}
                    onClick=${make}
                >
                    Make webhook
                </button>
            </div>`
        }
        ${list === null && html`<p class="muted">Loading…</p>`}
        ${
            list?.repoWatches?.length > 0 &&
            html`<div class="group">
                <div class="group-title">Repositories watched</div>
                ${list.repoWatches.map(
                    (watch) =>
                        html`<${WatchRow}
                            key=${watch.id}
                            watch=${watch}
                            onRemove=${() => unwatch(watch)}
                            onAnyone=${(event) => setWatchAnyone(watch, event)}
                        />`,
                )}
            </div>`
        }
        ${list && html`<div class="group-title">Webhooks</div>`}
        ${list?.hooks.length === 0 && html`<p class="muted">No webhooks yet.</p>`}
        ${list?.hooks.map(
            (hook) => html`<${HookRow}
                key=${hook.id}
                hook=${hook}
                base=${list.base}
                fresh=${hook.id === fresh}
                editable=${steer}
                onSaved=${(updated) =>
                    setList((current) => ({
                        ...current,
                        hooks: current.hooks.map((each) =>
                            each.id === updated.id ? { ...each, ...updated } : each,
                        ),
                    }))}
                onRemove=${() => remove(hook)}
                onRotate=${() => rotate(hook)}
            />`,
        )}
        ${
            list &&
            html`<p class="muted small">
                Ask PiP to watch a repository, such as “watch acme/api: when CI fails on main, fix it”. It needs no address.
            </p>
            <p class="muted small">
                ${list.base ? "" : `Services post to ${location.origin}, so they must be able to reach it: a tunnel's address works for GitHub. `}For GitHub: the repository's Settings → Webhooks → Add webhook; paste the address as the Payload URL and the secret as the Secret, choose application/json, and pick the events.
            </p>`
        }
    <//>`;
}
