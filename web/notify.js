// Phone notifications: this device subscribes to the server's pushes, and each person picks what they hear about.
import { useEffect, useState } from "preact/hooks";
import { api, attempt, closeSheet, notify, sessionUnread } from "./store.js";
import { html, Loader, Sheet } from "./ui.js";

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
        countedFrom.conversationId === state.conversationId
    ) {
        return;
    }

    countedFrom = {
        sessions: state.sessions,
        chatRead: state.chatRead,
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
        return "Notifications need a secure (https) address. Open Pi Pocket through the Cloudflare Tunnel, or through tailscale serve, on this device.";
    }

    if (!supported) {
        return "This browser cannot receive notifications. On iPhone and iPad, add Pi Pocket to the home screen first, then open it from there.";
    }

    if (Notification.permission === "denied") {
        return "Notifications are blocked for this site. Allow them in the browser's site settings, then come back.";
    }

    return null;
}

const KINDS = [
    ["done", "Pi finished", "when a run you took part in ends"],
    [
        "approval",
        "Approvals",
        "when Lancet Guard asks before a command; allow or deny it from the notification",
    ],
    ["mention", "Mentions", "when someone writes @your name in a chat"],
    ["chat", "Chat messages", "in sessions you take part in"],
];

function Toggle({ on, label, onChange, disabled }) {
    return html`<button
        type="button"
        role="switch"
        aria-checked=${on ? "true" : "false"}
        aria-label=${label}
        class=${`switch ${on ? "on" : ""}`}
        disabled=${disabled}
        onClick=${onChange}
    >
        <span></span>
    </button>`;
}

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

    return html`<${Sheet} title="Notifications" onClose=${closeSheet}>
        <p class="muted small">
            Get a notification on this device when you are not looking at the session: Pi finished, Pi needs approval, or someone wrote to you.
        </p>
        ${problem && html`<div class="error-box small">${problem}</div>`}
        ${
            !info || subscription === undefined
                ? html`<${Loader} label="Checking this device" />`
                : html`<div class="extension">
                    <div class="extension-main">
                        <div class="extension-title">This device</div>
                        <div class="muted small">
                            ${on ? "Notifications are on." : "Notifications are off."} ${info.devices > 0 ? `${info.devices} device${info.devices === 1 ? "" : "s"} of yours ${info.devices === 1 ? "gets" : "get"} them.` : ""}
                        </div>
                    </div>
                    <div class="extension-actions">
                        <${Toggle}
                            on=${on}
                            disabled=${busy || (!on && problem !== null)}
                            label="Notifications on this device"
                            onChange=${on ? disable : enable}
                        />
                    </div>
                </div>
                <div class="group-title">Notify me about</div>
                ${KINDS.map(
                    ([key, title, hint]) => html`<div class="extension">
                        <div class="extension-main">
                            <div>${title}</div>
                            <div class="muted small">${hint}</div>
                        </div>
                        <div class="extension-actions">
                            <${Toggle}
                                on=${info.prefs[key]}
                                label=${title}
                                onChange=${() => setPref(key, !info.prefs[key])}
                            />
                        </div>
                    </div>`,
                )}
                ${
                    on &&
                    html`<button class="button wide" onClick=${test}>
                        Send a test notification
                    </button>`
                }`
        }
    <//>`;
}
