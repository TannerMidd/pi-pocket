// Phone notifications: this device subscribes to the server's pushes, and each person picks what they hear about.
import { useEffect, useState } from "preact/hooks";
import { api, attempt, closeSheet, notify, sessionUnread } from "./store.js";
import { html, Loader, Sheet, Switch } from "./ui.js";
import { t } from "./ui-locale.js";

const supported =
    "serviceWorker" in navigator && "PushManager" in globalThis && "Notification" in globalThis;

let registering = null;

/** The service worker that shows notifications. Push needs a secure page: https, or localhost. */
export function registerWorker() {
    if (!supported || !isSecureContext) {
        return Promise.resolve(null);
    }

    registering ??= navigator.serviceWorker.register("/sw.js").catch(() => null);

    return registering;
}

/** The count on the icon, null until this page sets it: the service worker may have set one meanwhile. */
let badged = null;
/** What the count was worked out from: it changes only with these, while streaming updates the store many times a second. */
let countedFrom = null;

/** The home-screen icon counts the sessions that need you: a call waits for approval, or the chat has news. */
export function updateBadge(state) {
    if (!("setAppBadge" in navigator) || !state.me) {
        return;
    }

    if (
        countedFrom?.sessions === state.sessions &&
        countedFrom.chatRead === state.chatRead &&
        countedFrom.chatReads === state.chatReads &&
        countedFrom.me === state.me &&
        countedFrom.conversationId === state.conversationId
    ) {
        return;
    }

    countedFrom = {
        sessions: state.sessions,
        chatRead: state.chatRead,
        chatReads: state.chatReads,
        me: state.me,
        conversationId: state.conversationId,
    };
    const count = state.sessions.filter(
        (session) => session.waiting || sessionUnread(session, state),
    ).length;

    if (count === badged) {
        return;
    }

    badged = count;
    (count === 0 ? navigator.clearAppBadge() : navigator.setAppBadge(count)).catch(() => {});
}

function keyBytes(base64url) {
    const base64 = base64url
        .replace(/-/g, "+")
        .replace(/_/g, "/")
        .padEnd(Math.ceil(base64url.length / 4) * 4, "=");

    return Uint8Array.from(atob(base64), (char) => char.charCodeAt(0));
}

function sameKey(subscription, publicKey) {
    const key = subscription.options?.applicationServerKey;

    if (!key) {
        return true;
    }

    const a = new Uint8Array(key);
    const b = keyBytes(publicKey);

    return a.length === b.length && a.every((byte, index) => byte === b[index]);
}

/** Why this device cannot get notifications, or null when it can. */
function blocker() {
    if (!isSecureContext) {
        return t(
            "web.notify.blocker.text.secure-address",
            "Notifications need a secure (https) address. Open Pi Pocket through the Cloudflare Tunnel, or through tailscale serve, on this device.",
        );
    }

    if (!supported) {
        return t(
            "web.notify.blocker.text.browser-cannot-receive",
            "This browser cannot receive notifications. On iPhone and iPad, add Pi Pocket to the home screen first, then open it from there.",
        );
    }

    if (Notification.permission === "denied") {
        return t(
            "web.notify.blocker.text.blocked-site-settings",
            "Notifications are blocked for this site. Allow them in the browser's site settings, then come back.",
        );
    }

    return null;
}

/** Each kind a person can pick: its setting, then the key and English of its name, then those of its hint. */
const KINDS = [
    [
        "done",
        "web.notify.kinds.done.title",
        "Pi finished",
        "web.notify.kinds.done.hint",
        "when a run you took part in ends",
    ],
    [
        "approval",
        "web.notify.kinds.approval.title",
        "Approvals",
        "web.notify.kinds.approval.hint",
        "when Lancet Guard asks before a command; allow or deny it from the notification",
    ],
    [
        "limit",
        "web.notify.kinds.limit.title",
        "Waiting for a limit",
        "web.notify.kinds.limit.hint",
        "when a run waits more than ten minutes for a provider's limit to clear",
    ],
    [
        "mention",
        "web.notify.kinds.mention.title",
        "Mentions",
        "web.notify.kinds.mention.hint",
        "when someone writes @your name in a chat",
    ],
    [
        "chat",
        "web.notify.kinds.chat.title",
        "Chat messages",
        "web.notify.kinds.chat.hint",
        "in sessions you take part in",
    ],
];

export function NotificationsSheet() {
    const [info, setInfo] = useState(null);
    const [subscription, setSubscription] = useState(undefined);
    const [busy, setBusy] = useState(false);
    const problem = blocker();

    useEffect(() => {
        attempt(async () => setInfo(await api("push")));
        registerWorker()
            .then((registration) => registration?.pushManager.getSubscription() ?? null)
            .then(setSubscription, () => setSubscription(null));
    }, []);

    const enable = () =>
        attempt(async () => {
            setBusy(true);

            try {
                if ((await Notification.requestPermission()) !== "granted") {
                    throw new Error("Notifications were not allowed.");
                }

                const registration = await registerWorker();

                if (!registration) {
                    throw new Error("The service worker did not start.");
                }

                await navigator.serviceWorker.ready;
                let current = await registration.pushManager.getSubscription();

                // A subscription made for another server key cannot receive this server's pushes.
                if (current && !sameKey(current, info.publicKey)) {
                    await current.unsubscribe();
                    current = null;
                }

                current ??= await registration.pushManager.subscribe({
                    userVisibleOnly: true,
                    applicationServerKey: keyBytes(info.publicKey),
                });
                const result = await api("push/subscribe", { subscription: current.toJSON() });

                setSubscription(current);
                setInfo({ ...info, devices: result.devices });
                notify("info", "Notifications are on for this device.");
            } finally {
                setBusy(false);
            }
        });

    const disable = () =>
        attempt(async () => {
            setBusy(true);

            try {
                const endpoint = subscription?.endpoint;

                await subscription?.unsubscribe();
                const result = await api("push/unsubscribe", { endpoint });

                setSubscription(null);
                setInfo({ ...info, devices: result.devices });
            } finally {
                setBusy(false);
            }
        });

    const setPref = (key, value) =>
        attempt(async () => setInfo({ ...info, ...(await api("push/prefs", { [key]: value })) }));
    const test = () =>
        attempt(async () => {
            await api("push/test", {});
            notify("info", "Test sent. It shows as a system notification.");
        });

    const on = Boolean(subscription);

    return html`<${Sheet}
        title=${t("web.notify.notifications-sheet.title.notifications", "Notifications")}
        onClose=${closeSheet}
        className="notifications-sheet"
    >
        <p class="muted small">
            ${t("web.notify.notifications-sheet.p.get-notification-device-not", "Get a notification on this device when you are not looking at the session: Pi finished, Pi needs approval, or someone wrote to you.")}
        </p>
        ${problem && html`<div class="error-box small">${problem}</div>`}
        ${
            !info || subscription === undefined
                ? html`<${Loader}
                      label=${t(
                          "web.notify.notifications-sheet.loader.label.checking-this-device",
                          "Checking this device",
                      )}
                  />`
                : html`<div class="sheet-list">
                    <div class="extension">
                        <div class="extension-main">
                            <div class="extension-title">${t(
                                "web.notify.notifications-sheet.div.this-device",
                                "This device",
                            )}</div>
                            <div class="muted small">
                                ${
                                    on
                                        ? t(
                                              "web.notify.notifications-sheet.div.notifications-are-on",
                                              "Notifications are on.",
                                          )
                                        : t(
                                              "web.notify.notifications-sheet.div.notifications-are-off",
                                              "Notifications are off.",
                                          )
                                }
                                ${
                                    info.devices === 1
                                        ? t(
                                              "web.notify.notifications-sheet.div.one-device-gets-them",
                                              "1 device of yours gets them.",
                                          )
                                        : info.devices > 1
                                          ? t(
                                                "web.notify.notifications-sheet.div.devices-get-them",
                                                "{count} devices of yours get them.",
                                                { count: info.devices },
                                            )
                                          : ""
                                }
                            </div>
                        </div>
                        <div class="extension-actions">
                            <${Switch}
                                on=${on}
                                disabled=${busy || (!on && problem !== null)}
                                label=${t(
                                    "web.notify.notifications-sheet.switch.label.notifications-on-this-device",
                                    "Notifications on this device",
                                )}
                                onChange=${on ? disable : enable}
                            />
                        </div>
                    </div>
                </div>
                <div class="group-title">${t(
                    "web.notify.notifications-sheet.div.notify-me-about",
                    "Notify me about",
                )}</div>
                <div class="sheet-list">
                    ${KINDS.map(
                        ([key, titleKey, title, hintKey, hint]) => html`<div class="extension">
                            <div class="extension-main">
                                <div>${t(titleKey, title)}</div>
                                <div class="muted small">${t(hintKey, hint)}</div>
                            </div>
                            <div class="extension-actions">
                                <${Switch}
                                    on=${info.prefs[key]}
                                    label=${t(titleKey, title)}
                                    onChange=${() => setPref(key, !info.prefs[key])}
                                />
                            </div>
                        </div>`,
                    )}
                </div>
                ${
                    on &&
                    html`<button class="button wide" onClick=${test}>
                        ${t(
                            "web.notify.notifications-sheet.button.send-a-test-notification",
                            "Send a test notification",
                        )}
                    </button>`
                }`
        }
    <//>`;
}
