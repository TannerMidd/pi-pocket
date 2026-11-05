// People with access to this server, and invites for more.
import { useEffect, useRef, useState } from "preact/hooks";
import { Avatar } from "../avatar.js";
import {
    actions,
    api,
    attempt,
    canSteer,
    closeSheet,
    collab,
    notify,
    openSheet,
    scoped,
    store,
} from "../store.js";
import { copyText, html, Icon, Loader, Sheet, timeAgo } from "../ui.js";
import { t } from "../ui-locale.js";

/** What a role may do, said where an invite picks it; built at draw time, so a change of language shows. */
const roleText = (role) =>
    role === "guest"
        ? t(
              "web.sheets.people.guest.steer-pi-run-commands",
              "Can steer Pi, which can run commands on this machine",
          )
        : t(
              "web.sheets.people.viewer.read-along-react-chat",
              "Can read along, react, and chat, but not steer Pi",
          );

/** How long an invite may last: minutes, its button, and how the help text says it; built at draw time too. */
const lasts = () => [
    [
        15,
        t("web.sheets.people.lasts.min", "15 min"),
        t("web.sheets.people.lasts.minutes", "in 15 minutes"),
    ],
    [
        60,
        t("web.sheets.people.lasts.hour", "1 hour"),
        t("web.sheets.people.lasts.hour.hour", "in an hour"),
    ],
    [
        24 * 60,
        t("web.sheets.people.lasts.day", "1 day"),
        t("web.sheets.people.lasts.day.day", "in a day"),
    ],
    [
        7 * 24 * 60,
        t("web.sheets.people.lasts.week", "1 week"),
        t("web.sheets.people.lasts.week.week", "in a week"),
    ],
];

/** End an invite nobody will see: one the sheet stopped showing, or one that answered too late to show. */
const cancelInvite = (invite) => {
    // A server that says how long its invites last also ends them on request; an older one has no such route.
    if (invite?.minutes !== undefined) {
        // Sent even when the page goes (a reload, a web file edited), so it is never left live and unseen.
        fetch("/api/invite/cancel", {
            method: "POST",
            keepalive: true,
            headers: { "X-Pocket": "1", "content-type": "application/json" },
            body: JSON.stringify({ code: invite.code }),
        }).catch(() => {});
    }
};

export function InviteSheet({ session = null }) {
    const { view, me, sessions } = store.state;
    const here =
        session !== null
            ? (sessions.find((each) => each.id === session) ?? null)
            : view.conversation?.kind === "session"
              ? view.conversation
              : null;
    const [role, setRole] = useState("guest");
    const [only, setOnly] = useState(session !== null);
    // The owner's own other device: it signs in as the owner, not as someone new.
    const [asOwner, setAsOwner] = useState(false);
    const [minutes, setMinutes] = useState(15);
    const [made, setMade] = useState(null);
    // The newest invite could not be made: the sheet offers to try again rather than wait for ever.
    const [failed, setFailed] = useState(false);
    // What the sheet says now: an invite shows only while it was made for exactly this.
    const asked = JSON.stringify([asOwner, role, only, minutes]);
    // Only the newest invite shows: one asked for before a change, answering late, must not stand for what the sheet says.
    const latest = useRef(0);
    // The invite the sheet last showed: a change to what it grants, or how long it lasts, ends it.
    const shown = useRef(null);
    // Closed (gone, or still sliding away): nothing more is made, and what was being made ends when it answers.
    const mounted = useRef(true);
    const open = () => mounted.current && store.state.sheet?.type === "invite";
    const create = ({ replacing = false } = {}) =>
        attempt(async () => {
            if (!open()) {
                return;
            }

            const ticket = ++latest.current;

            if (replacing) {
                cancelInvite(shown.current);
                shown.current = null;
            }

            setMade(null);
            setFailed(false);
            let answer;

            try {
                answer = await api(
                    "invite",
                    asOwner
                        ? { role: "owner" }
                        : collab()
                          ? { role, ...(only && here ? { session: here.id } : {}), minutes }
                          : { minutes },
                );
            } catch (error) {
                if (ticket === latest.current) {
                    setFailed(true);
                }

                throw error;
            }

            if (ticket !== latest.current || !open()) {
                cancelInvite(answer);

                return;
            }

            // A server from before owner invites makes a guest's: never shown as the owner's.
            if (asOwner && answer.grant?.role !== "owner") {
                setFailed(true);

                throw new Error(
                    t(
                        "web.sheets.people.invite-sheet.create.restart-pi-pocket-sign",
                        "Restart Pi Pocket to sign in another device as the owner.",
                    ),
                );
            }

            shown.current = answer;
            setMade({ ...answer, asked });
        });

    useEffect(() => {
        create({ replacing: true });
    }, [role, only, asOwner, minutes]);
    useEffect(
        () => () => {
            mounted.current = false;
        },
        [],
    );
    // Shown only while it is what the sheet says, not for a frame after a change: above all, never an owner's invite
    // under a cleared box (which the server's answer says too).
    const invite =
        made && made.asked === asked && (made.grant?.role === "owner") === asOwner ? made : null;
    const where =
        only && here
            ? t("web.sheets.people.invite-sheet.where.content", "only “{title}”", {
                  title: here.title,
              })
            : t("web.sheets.people.invite-sheet.where.every-session", "every session");
    // As long as the invite shown lasts (a server that does not say: 15 minutes), or, while one is made, as chosen.
    const lasting = lasts().find(
        ([each]) => each === (invite ? (invite.minutes ?? 15) : minutes),
    )?.[2];

    return html`<${Sheet} title=${t(
        "web.sheets.people.invite-sheet.title.invite-someone",
        "Invite someone",
    )} onClose=${closeSheet}>
        ${
            me?.role === "owner" &&
            html`<label class="check">
                <input
                    type="checkbox"
                    checked=${asOwner}
                    onChange=${(event) => setAsOwner(event.currentTarget.checked)}
                />
                ${t("web.sheets.people.invite-sheet.input.sign-me-owner", "Sign in as me (owner)")}
            </label>`
        }
        ${
            collab() &&
            !asOwner &&
            html`<div class="field">
                <div class="label">${t(
                    "web.sheets.people.invite-sheet.div.they-can",
                    "They can",
                )}</div>
                <div class="segmented">
                    <button
                        class=${role === "guest" ? "on" : ""}
                        aria-pressed=${role === "guest"}
                        onClick=${() => setRole("guest")}
                    >
                        ${t("web.sheets.people.invite-sheet.button.steer", "Steer")}
                    </button>
                    <button
                        class=${role === "viewer" ? "on" : ""}
                        aria-pressed=${role === "viewer"}
                        onClick=${() => setRole("viewer")}
                    >
                        ${t("web.sheets.people.invite-sheet.button.view-only", "View only")}
                    </button>
                </div>
                <div class="muted small">
                    ${roleText(role)}.${
                        role === "guest" && only
                            ? t(
                                  "web.sheets.people.invite-sheet.div.seeing-one-session-app",
                                  " Seeing one session in the app does not limit what Pi can reach on the machine.",
                              )
                            : ""
                    }
                </div>
            </div>
            ${
                here &&
                html`<div class="field">
                    <div class="label">${t("web.sheets.people.invite-sheet.div.in", "In")}</div>
                    <div class="segmented">
                        <button
                            class=${!only ? "on" : ""}
                            aria-pressed=${!only}
                            onClick=${() => setOnly(false)}
                        >
                            ${t(
                                "web.sheets.people.invite-sheet.button.every-session",
                                "Every session",
                            )}
                        </button>
                        <button
                            class=${only ? "on" : ""}
                            aria-pressed=${only}
                            onClick=${() => setOnly(true)}
                        >
                            ${t(
                                "web.sheets.people.invite-sheet.button.only-this-session",
                                "Only this session",
                            )}
                        </button>
                    </div>
                </div>`
            }`
        }
        ${
            !asOwner &&
            html`<div class="field">
                <div class="label">${t(
                    "web.sheets.people.invite-sheet.div.expires-after",
                    "Expires after",
                )}</div>
                <div class="segmented">
                    ${lasts().map(
                        ([each, label]) => html`<button
                            class=${minutes === each ? "on" : ""}
                            aria-pressed=${minutes === each}
                            onClick=${() => setMinutes(each)}
                        >
                            ${label}
                        </button>`,
                    )}
                </div>
            </div>`
        }
        <p class="muted small">
            ${
                asOwner
                    ? t(
                          "web.sheets.people.invite-sheet.p.scan-other-device-send",
                          "Scan this on your other device, or send it the link. That device signs in as you, the owner. It works once and expires in 15 minutes.",
                      )
                    : t(
                          "web.sheets.people.invite-sheet.p.scan-other-device-send.link",
                          "Scan this on the other device, or send it the link. It works once and expires {lasting}. Whoever joins sees {where}.",
                          { lasting, where },
                      )
            }
        </p>
        ${
            invite?.access?.url &&
            html`<p class="muted small">
                ${t(
                    "web.sheets.people.invite-sheet.p.other-devices-connect-through",
                    "Other devices connect through {label}.",
                    { label: invite.access.label },
                )}
            </p>`
        }
        ${
            invite
                ? html`<div class="invite">
                    ${
                        invite.local &&
                        html`<div class="error-box">
                            ${t("web.sheets.people.invite-sheet.div.link-works-device-let", "This link only works on this device. To let other devices in, press")} <span class="mono">a</span> ${t("web.sheets.people.invite-sheet.span.pi-pocket-terminal-start", "in the Pi Pocket terminal (or start it with")} <span class="mono">--access</span>${t("web.sheets.people.invite-sheet.span.pick-local-network-cloudflare", ") and pick Local network, Cloudflare Tunnel, or Tailscale. Then make a new invite.")}
                        </div>`
                    }
                    <div class="invite-details">
                    <div class="qr" dangerouslySetInnerHTML=${{ __html: invite.svg }}></div>
                    <div class="invite-code">
                        <div class="invite-code-head">
                            <span>${t(
                                "web.sheets.people.invite-sheet.span.invite-code",
                                "Invite code",
                            )}</span>
                            <button
                                class="link small"
                                onClick=${() =>
                                    copyText(invite.code).then(
                                        () =>
                                            notify(
                                                "info",
                                                t(
                                                    "web.sheets.people.invite-sheet.text.code-copied",
                                                    "Code copied.",
                                                ),
                                            ),
                                        () =>
                                            notify(
                                                "error",
                                                t(
                                                    "web.sheets.people.invite-sheet.text.not-copy",
                                                    "Could not copy.",
                                                ),
                                            ),
                                    )}
                            >
                                ${t("web.sheets.people.invite-sheet.button.copy", "Copy")}
                            </button>
                        </div>
                        <div
                            class="invite-code-value"
                            aria-label=${t(
                                "web.sheets.people.invite-sheet.aria-label.invite-code",
                                "Invite code {detail}",
                                { detail: invite.code.split("").join(" ") },
                            )}
                        >
                            <span>${invite.code.slice(0, 5)}</span>
                            <span>${invite.code.slice(5)}</span>
                        </div>
                        <div class="muted small">
                            ${t(
                                "web.sheets.people.invite-sheet.div.enter-other-device-s",
                                "Or enter it on the other device's sign-in screen.",
                            )}
                        </div>
                    </div>
                    </div>
                    <div class="row">
                        <input
                            class="mono"
                            readonly
                            value=${invite.url}
                            onFocus=${(event) => event.currentTarget.select()}
                        />
                        <button
                            class="button"
                            onClick=${() =>
                                copyText(invite.url).then(
                                    () =>
                                        notify(
                                            "info",
                                            t(
                                                "web.sheets.people.invite-sheet.text.link-copied",
                                                "Link copied.",
                                            ),
                                        ),
                                    () =>
                                        notify(
                                            "error",
                                            t(
                                                "web.sheets.people.invite-sheet.text.not-copy",
                                                "Could not copy.",
                                            ),
                                        ),
                                )}
                        >
                            ${t("web.sheets.people.invite-sheet.button.copy", "Copy")}
                        </button>
                    </div>
                    ${
                        invite.alternatives?.length > 0 &&
                        html`<p class="muted small">
                            ${t(
                                "web.sheets.people.invite-sheet.p.also-reachable-label",
                                "Also reachable at:",
                            )} ${invite.alternatives.map(
                                (url) => html`<span class="mono">${url} </span>`,
                            )}
                        </p>`
                    }
                </div>`
                : failed
                  ? html`<p class="muted small">${t(
                        "web.sheets.people.invite-sheet.p.no-invite-yet-tap",
                        "No invite yet. Tap New invite to try again.",
                    )}</p>`
                  : html`<${Loader}
                        label=${t(
                            "web.sheets.people.invite-sheet.label.making-an-invite",
                            "Making an invite",
                        )}
                    />`
        }
        <button class="button wide" onClick=${create}>${t(
            "web.sheets.people.invite-sheet.button.new-invite",
            "New invite",
        )}</button>
        ${!collab() && html`<${PeopleList} />`}
    <//>`;
}

function lastSeen(person) {
    if (person.online) {
        return t("web.sheets.people.last-seen.text.content", "here now");
    }

    if (!person.lastSeen) {
        return t("web.sheets.people.last-seen.text.not-seen-yet", "not seen yet");
    }

    return timeAgo(person.lastSeen) === "now"
        ? t("web.sheets.people.last-seen.text.seen-now", "seen {when}", {
              when: timeAgo(person.lastSeen),
          })
        : t("web.sheets.people.last-seen.text.seen-ago", "seen {when} ago", {
              when: timeAgo(person.lastSeen),
          });
}

/** Everyone with access: who is online, when the others were last here, and (for the owner) what each may do. */
function PeopleList() {
    const { me, users, sessions } = store.state;
    const owner = me?.role === "owner";
    const sessionTitle = (id) =>
        sessions.find((each) => each.id === id)?.title ??
        t("web.sheets.people.people-list.text.session", "session {id}", { id });
    const ordered = [...users].sort(
        (a, b) =>
            Number(Boolean(b.online)) - Number(Boolean(a.online)) ||
            (b.lastSeen ?? 0) - (a.lastSeen ?? 0),
    );
    const change = (person, patch) =>
        attempt(async () => store.set({ users: await actions.setAccess(person.id, patch) }));

    return html`<div class="group">
        <div class="group-title">${t("web.sheets.people.people-list.div.people", "People")}</div>
        <div class="sheet-list">
        ${ordered.map(
            (person) => html`<div class="person-row" key=${person.id}>
                <span class="people-here">
                    <${Avatar} person=${person} size=${32} />
                    <span
                        class=${`online-mark ${person.online ? "" : "away"}`}
                        aria-hidden="true"
                    ></span>
                </span>
                <div class="person-main">
                    <div>
                        ${person.name}
                        ${
                            person.id === me?.id
                                ? html` <span class="muted small">${t(
                                      "web.sheets.people.people-list.span.you",
                                      "(you)",
                                  )}</span>`
                                : ""
                        }
                    </div>
                    <div class="muted small">
                        ${
                            person.role === "owner"
                                ? t("web.sheets.people.people-list.div.owner", "owner")
                                : person.role === "viewer"
                                  ? t("web.sheets.people.people-list.div.view", "view only")
                                  : t("web.sheets.people.people-list.div.steer", "can steer")
                        }
                        ${
                            person.sessions
                                ? t(
                                      "web.sheets.people.people-list.div.content",
                                      " · only {title}",
                                      {
                                          title: person.sessions.map(sessionTitle).join(", "),
                                      },
                                  )
                                : ""
                        } · ${lastSeen(person)}
                    </div>
                </div>
                ${
                    owner &&
                    person.role !== "owner" &&
                    html`<div class="person-actions">
                        ${
                            collab() &&
                            html`<button
                                class="button small"
                                title=${t(
                                    "web.sheets.people.people-list.title.change-they",
                                    "Change what they can do",
                                )}
                                onClick=${() => change(person, { role: person.role === "viewer" ? "guest" : "viewer" })}
                            >
                                ${
                                    person.role === "viewer"
                                        ? t(
                                              "web.sheets.people.people-list.button.let-steer",
                                              "Let steer",
                                          )
                                        : t(
                                              "web.sheets.people.people-list.button.view",
                                              "View only",
                                          )
                                }
                            </button>`
                        }
                        ${
                            collab() &&
                            person.sessions &&
                            html`<button
                                class="button small"
                                title=${t(
                                    "web.sheets.people.people-list.title.let-them-see-every",
                                    "Let them see every session",
                                )}
                                onClick=${() => change(person, { sessions: null })}
                            >
                                ${t(
                                    "web.sheets.people.people-list.button.all-sessions",
                                    "All sessions",
                                )}
                            </button>`
                        }
                        <button
                            class="button small ghost"
                            onClick=${() =>
                                confirm(
                                    t(
                                        "web.sheets.people.people-list.confirm.remove-their-devices-signed",
                                        "Remove {name}? Their devices are signed out.",
                                        { name: person.name },
                                    ),
                                ) &&
                                attempt(async () => {
                                    await api(`users/${person.id}/remove`, {});
                                    store.set({
                                        users: store.state.users.filter(
                                            (each) => each.id !== person.id,
                                        ),
                                    });
                                })}
                        >
                            ${t("web.sheets.people.people-list.button.remove", "Remove")}
                        </button>
                    </div>`
                }
            </div>`,
        )}
        </div>
    </div>`;
}

export function PeopleSheet() {
    const canInvite = canSteer() && !scoped();

    return html`<${Sheet} title=${t(
        "web.sheets.people.people-sheet.title.people",
        "People",
    )} onClose=${closeSheet}>
        ${
            canInvite &&
            html`<button class="button primary wide" onClick=${() => openSheet({ type: "invite" })}>
                <${Icon} name="plus" size=${16} /> ${t(
                    "web.sheets.people.people-sheet.text.invite-someone",
                    "Invite someone",
                )}
            </button>`
        }
        <${PeopleList} />
        <button
            class="button ghost wide sheet-footer"
            onClick=${() => openSheet({ type: "notifications" })}
        >
            ${t(
                "web.sheets.people.people-sheet.button.notifications-on-this-device",
                "Notifications on this device…",
            )}
        </button>
    <//>`;
}
