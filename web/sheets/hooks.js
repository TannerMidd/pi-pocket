// Webhooks and watches: addresses other services post to, each turning every post into a message to Pi in a session or
// to PiP; and the repository watches PiP set up, which need no address.
import { useEffect, useRef, useState } from "preact/hooks";
import { pipAvailable } from "../pip.js";
import { api, attempt, closeSheet, navigate, notify, store } from "../store.js";
import { copyText, formatWhen, html, Sheet } from "../ui.js";
import { t } from "../ui-locale.js";

/** A hook's full address: the server's public one when it has one, else the one this browser uses. */
const addressOf = (base, hook) => `${(base ?? location.origin).replace(/\/$/, "")}${hook.path}`;

function copy(text, what) {
    copyText(text).then(
        () => notify("info", what),
        () => notify("error", t("web.sheets.hooks.copy.text.not-copy", "Could not copy.")),
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
            ? t("web.sheets.hooks.hook-row.used.no-posts-yet", "no posts yet")
            : hook.count === 1
              ? t("web.sheets.hooks.hook-row.used.one-post-last", "{count} post, last {last}", {
                    count: hook.count,
                    last: formatWhen(hook.lastAt),
                })
              : t("web.sheets.hooks.hook-row.used.posts-last", "{count} posts, last {last}", {
                    count: hook.count,
                    last: formatWhen(hook.lastAt),
                });

    const status = [
        hook.signed
            ? t("web.sheets.hooks.hook-row.span.git-hub-signed", "GitHub, signed")
            : t("web.sheets.hooks.hook-row.span.secret-address", "secret in the address"),
        ...(hook.anyone ? [t("web.sheets.hooks.hook-row.from-anyone", "from anyone")] : []),
        used,
    ].join(" · ");

    return html`<div class=${`hook ${fresh ? "fresh" : ""}`}>
        <div class="hook-head">
            <strong class="grow">${hook.name}</strong>
            <span class="muted small">
                ${t("web.sheets.hooks.hook-row.span.to", "to")} ${
                    hook.pip
                        ? t("web.sheets.hooks.hook-row.span.pi-p", "PiP")
                        : html`<a href=${`/s/${hook.target}`} onClick=${open}>${hook.targetTitle}</a>`
                }
            </span>
        </div>
        ${
            editing
                ? html`<div class="field">
                    <div class="label">${t("web.sheets.hooks.release028.prompt-heading", "What Pi should do with each post")}</div>
                    <textarea
                        aria-label=${t("web.sheets.hooks.release028.edit-prompt-label", "Edit the prompt of {name}", { name: hook.name })}
                        rows="4"
                        maxlength="2000"
                        ref=${field}
                        disabled=${saving}
                        value=${draft}
                        onInput=${(event) => setDraft(event.currentTarget.value)}
                        onKeyDown=${(event) => {
                            // Esc cancels the edit, as Cancel does; the sheet closes on the next Esc.
                            if (
                                event.key === "Escape" &&
                                !event.isComposing &&
                                event.keyCode !== 229
                            ) {
                                event.stopPropagation();
                                setDraft(null);
                            }
                        }}
                    ></textarea>
                    <div class="muted small">
                        ${t("web.sheets.hooks.release028.future-posts", "Applies to future posts. Leave empty for the default instructions.")}
                    </div>
                    <div class="hook-actions">
                        <button
                            class="button small ghost"
                            disabled=${saving}
                            onClick=${() => setDraft(null)}
                        >
                            ${t("web.sheets.hooks.release028.cancel", "Cancel")}
                        </button>
                        <button class="button small primary" disabled=${saving} onClick=${save}>
                            ${saving ? t("web.sheets.hooks.release028.saving", "Saving…") : t("web.sheets.hooks.release028.save", "Save")}
                        </button>
                    </div>
                </div>`
                : hook.instructions && html`<div class="hook-text">${hook.instructions}</div>`
        }
        ${
            fresh &&
            html`<div class="mono small hook-address">${addressOf(base, hook)}</div>
                ${
                    hook.signed &&
                    html`<div class="mono small hook-address">${t(
                        "web.sheets.hooks.hook-row.div.secret",
                        "Secret: {secret}",
                        { secret: hook.secret },
                    )}</div>`
                }`
        }
        <div class="hook-actions">
            <span class="muted small grow hook-status">${status}</span>
            <button
                class="button small"
                onClick=${() =>
                    copy(
                        addressOf(base, hook),
                        hook.signed
                            ? t(
                                  "web.sheets.hooks.hook-row.text.address-copied-git-hub-s",
                                  "Address copied: GitHub's Payload URL.",
                              )
                            : t(
                                  "web.sheets.hooks.hook-row.text.address-copied-keep-secret",
                                  "Address copied. Keep it secret: anyone with it can message Pi.",
                              ),
                    )}
            >
                ${t("web.sheets.hooks.hook-row.button.copy-address", "Copy address")}
            </button>
            ${
                hook.signed &&
                html`<button
                    class="button small"
                    onClick=${() =>
                        copy(
                            hook.secret,
                            t(
                                "web.sheets.hooks.hook-row.text.secret-copied-git-hub-s",
                                "Secret copied: GitHub's Secret.",
                            ),
                        )}
                >
                    ${t("web.sheets.hooks.hook-row.button.copy-secret", "Copy secret")}
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
                    ${t("web.sheets.hooks.release028.edit-prompt", "Edit prompt")}
                </button>`
            }
            <button class="button small ghost" disabled=${saving} onClick=${onRotate}>
                ${t("web.sheets.hooks.release028.new-secret", "New secret")}
            </button>
            <button class="button small ghost" disabled=${saving} onClick=${onRemove}>
                ${t("web.sheets.hooks.release028.remove", "Remove")}
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
        watch.label &&
            t("web.sheets.hooks.watch-row.narrowed.label", "label {label}", {
                label: watch.label,
            }),
        watch.assigned && t("web.sheets.hooks.watch-row.narrowed.assigned", "assigned to you"),
        watch.events.includes("ci") &&
            t("web.sheets.hooks.watch-row.narrowed.ci", "CI on {branch}", {
                branch: watch.branch,
            }),
    ].filter(Boolean);

    return html`<div class="hook">
        <div class="hook-head">
            <strong class="grow">${watch.repo}</strong>
            <span class="muted small">
                ${t("web.sheets.hooks.hook-row.span.to", "to")} ${
                    watch.pip
                        ? t("web.sheets.hooks.hook-row.span.pi-p", "PiP")
                        : html`<a href=${`/s/${watch.target}`} onClick=${open}>${watch.targetTitle}</a>`
                }
            </span>
        </div>
        <div class="muted small">${watch.events.join(", ")}${narrowed.length > 0 ? ` · ${narrowed.join(", ")}` : ""}</div>
        ${watch.instructions && html`<div class="hook-text">${watch.instructions}</div>`}
        <div class="hook-actions">
            <span class="muted small grow">
                ${
                    watch.count === 0
                        ? t("web.sheets.hooks.watch-row.span.nothing-sent-yet", "nothing sent yet")
                        : t(
                              "web.sheets.hooks.watch-row.span.sent-last-time",
                              "{count} sent, last {last}",
                              { count: watch.count, last: formatWhen(watch.lastNewsAt) },
                          )
                }${
                    watch.note
                        ? ` · ${
                              watch.errors > 0
                                  ? t(
                                        "web.sheets.hooks.watch-row.text.last-look-failed",
                                        "last look failed",
                                    )
                                  : t("web.sheets.hooks.watch-row.text.waiting", "waiting")
                          }: ${watch.note}`
                        : ""
                }
            </span>
            <button class="button small ghost" onClick=${onRemove}>${t(
                "web.sheets.hooks.watch-row.button.remove",
                "Remove",
            )}</button>
        </div>
        <label class="check">
            <input type="checkbox" checked=${watch.anyone === true} onChange=${onAnyone} />
            ${t(
                "web.sheets.hooks.watch-row.input.anyone-not-repository-s",
                "From anyone, not only the repository's people",
            )}
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
    const targets = [
        here && ["here", t("web.sheets.hooks.hooks-sheet.targets.session", "This session")],
        pipAvailable() && ["pip", t("web.sheets.hooks.hook-row.span.pi-p", "PiP")],
    ].filter(Boolean);

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
                    t(
                        "web.sheets.hooks.hooks-sheet.remove.confirm.remove-webhook-posts-address",
                        "Remove the webhook “{name}”? Posts to its address stop reaching Pi.",
                        { name: hook.name },
                    ),
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
                ? t(
                      "web.sheets.hooks.hooks-sheet.rotate.where.paste-new-one-git-hub",
                      "Paste the new one into GitHub's Secret for it.",
                  )
                : t(
                      "web.sheets.hooks.hooks-sheet.rotate.where.give-new-address-whatever",
                      "Give the new address to whatever posts to it.",
                  );

            if (
                !confirm(
                    t(
                        "web.sheets.hooks.hooks-sheet.rotate.confirm.new-secret-posts-old",
                        "A new secret for “{name}”: posts with the old one stop getting in. {where}",
                        { name: hook.name, where },
                    ),
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
            if (
                !confirm(
                    t(
                        "web.sheets.hooks.hooks-sheet.unwatch.confirm.stop-watching-nothing-more",
                        "Stop watching {repo}? Nothing more comes from it.",
                        { repo: watch.repo },
                    ),
                )
            ) {
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
                    t(
                        "web.sheets.hooks.hooks-sheet.set-watch-anyone.confirm.let-anyone-s-issues",
                        "Let anyone's issues and PRs on {repo} reach {detail}? Strangers' words then come with your instructions.",
                        {
                            repo: watch.repo,
                            detail: watch.pip
                                ? t(
                                      "web.sheets.hooks.hooks-sheet.set-watch-anyone.confirm.pi-p",
                                      "PiP",
                                  )
                                : t(
                                      "web.sheets.hooks.hooks-sheet.set-watch-anyone.confirm.pi",
                                      "Pi",
                                  ),
                        },
                    ),
                )
            ) {
                return;
            }

            await api(`repo-watches/${encodeURIComponent(watch.id)}/anyone`, { anyone: on });
        }).finally(load);
    };

    return html`<${Sheet} title=${t(
        "web.sheets.hooks.hooks-sheet.title.webhooks-and-watches",
        "Webhooks and watches",
    )} onClose=${closeSheet} wide=${true}>
        <p class="muted small">
            ${t("web.sheets.hooks.hooks-sheet.p.other-services-git-hub-deploy", "Other services (GitHub, a deploy, a monitor) post to a webhook's address, and each post becomes a message to Pi in a session, or to PiP: your instructions, then what came.")}
        </p>
        ${
            steer &&
            targets.length > 0 &&
            html`<div class="hook-form">
                <div class="field">
                    <div class="label">${t("web.sheets.hooks.hooks-sheet.div.name", "Name")}</div>
                    <input
                        aria-label=${t("web.sheets.hooks.hooks-sheet.aria-label.name", "Name")}
                        placeholder=${t(
                            "web.sheets.hooks.hooks-sheet.placeholder.deploys",
                            "Deploys",
                        )}
                        maxlength="60"
                        value=${name}
                        onInput=${(event) => setName(event.currentTarget.value)}
                    />
                </div>
                <div class="field">
                    <div class="label">${t(
                        "web.sheets.hooks.hooks-sheet.div.pi-post",
                        "What Pi should do with each post",
                    )}</div>
                    <textarea
                        aria-label=${t(
                            "web.sheets.hooks.hooks-sheet.aria-label.pi-post",
                            "What Pi should do with each post",
                        )}
                        rows="3"
                        maxlength="2000"
                        placeholder=${t("web.sheets.hooks.hooks-sheet.placeholder.deploy-fails-find-out", "When a deploy fails, find out why and fix it. Ignore the ones that pass.")}
                        value=${instructions}
                        onInput=${(event) => setInstructions(event.currentTarget.value)}
                    ></textarea>
                </div>
                <div class="field">
                    <div class="label">${t(
                        "web.sheets.hooks.hooks-sheet.div.posted-by",
                        "Posted by",
                    )}</div>
                    <div class="segmented">
                        <button
                            class=${github ? "on" : ""}
                            aria-pressed=${github}
                            onClick=${() => setGithub(true)}
                        >
                            ${t("web.sheets.hooks.hooks-sheet.button.git-hub", "GitHub")}
                        </button>
                        <button
                            class=${github ? "" : "on"}
                            aria-pressed=${!github}
                            onClick=${() => setGithub(false)}
                        >
                            ${t(
                                "web.sheets.hooks.hooks-sheet.button.another-service",
                                "Another service",
                            )}
                        </button>
                    </div>
                    <div class="muted small">
                        ${
                            github
                                ? t(
                                      "web.sheets.hooks.hooks-sheet.div.signed-git-hub-gets-address",
                                      "Signed: GitHub gets the address and, separately, a secret; the address alone lets nothing in.",
                                  )
                                : t(
                                      "web.sheets.hooks.hooks-sheet.div.secret-address-anyone-who",
                                      "The secret is in the address: anyone who has it can message Pi as you.",
                                  )
                        }
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
                        ${t(
                            "web.sheets.hooks.hooks-sheet.input.anyone-issues-prs-comments",
                            "From anyone: issues, PRs, and comments by people outside the repository too",
                        )}
                    </label>
                    <div class="muted small">
                        ${
                            anyone
                                ? t(
                                      "web.sheets.hooks.hooks-sheet.div.strangers-words-reach-pi",
                                      "Strangers' words reach Pi too, fenced as data.",
                                  )
                                : t(
                                      "web.sheets.hooks.hooks-sheet.div.off-posts-about-issues",
                                      "Off: posts about issues, PRs, and comments by people who cannot write to the repository are dropped (a 202 says so), and their words in other posts are left out. GitHub is asked who can write: gh must be able to push there.",
                                  )
                        }
                    </div>`
                }
                ${
                    targets.length > 1 &&
                    html`<div class="field">
                        <div class="label">${t(
                            "web.sheets.hooks.hooks-sheet.div.sends-to",
                            "Sends to",
                        )}</div>
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
                            ${
                                target === "pip"
                                    ? t(
                                          "web.sheets.hooks.hooks-sheet.div.pi-p-decides-start-session",
                                          "PiP decides what to do: start a session, message one, or tell you.",
                                      )
                                    : t(
                                          "web.sheets.hooks.hooks-sheet.div.pi-gets-post",
                                          "Pi in “{title}” gets each post.",
                                          { title: here?.title ?? "" },
                                      )
                            }
                        </div>
                    </div>`
                }
                <button
                    class="button primary wide"
                    disabled=${name.trim() === "" || making}
                    onClick=${make}
                >
                    ${t("web.sheets.hooks.hooks-sheet.button.make-webhook", "Make webhook")}
                </button>
            </div>`
        }
        ${
            list === null &&
            html`<p class="muted">${t("web.sheets.hooks.hooks-sheet.p.loading", "Loading…")}</p>`
        }
        ${
            list?.repoWatches?.length > 0 &&
            html`<div class="group">
                <div class="group-title">${t(
                    "web.sheets.hooks.hooks-sheet.div.repositories-watched",
                    "Repositories watched",
                )}</div>
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
        ${
            list &&
            html`<div class="group-title">${t(
                "web.sheets.hooks.hooks-sheet.div.webhooks",
                "Webhooks",
            )}</div>`
        }
        ${
            list?.hooks.length === 0 &&
            html`<p class="muted">${t(
                "web.sheets.hooks.hooks-sheet.p.no-webhooks-yet",
                "No webhooks yet.",
            )}</p>`
        }
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
                ${t("web.sheets.hooks.hooks-sheet.p.ask-pi-p-watch-repository", "Ask PiP to watch a repository, such as “watch acme/api: when CI fails on main, fix it”. It needs no address.")}
            </p>
            <p class="muted small">
                ${
                    list.base
                        ? ""
                        : `${t(
                              "web.sheets.hooks.hooks-sheet.p.services-post-origin",
                              "Services post to {origin}, so they must be able to reach it: a tunnel's address works for GitHub.",
                              { origin: location.origin },
                          )} `
                }${t(
                    "web.sheets.hooks.hooks-sheet.p.git-hub-settings-steps",
                    "For GitHub: the repository's Settings → Webhooks → Add webhook; paste the address as the Payload URL and the secret as the Secret, choose application/json, and pick the events.",
                )}
            </p>`
        }
    <//>`;
}
