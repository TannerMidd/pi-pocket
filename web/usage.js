// Provider usage as the app reads it, without the DOM: the owner's `usage` events (the server's `usage.ts`) turned into
// what each place says. A window is `{ id, tag, label, left, detail, resetAt, state }` (`state`: `ok`, `low`, or
// `limited`, as the server judged it at the response); a window whose reset time has passed is `reset`: its numbers are
// from before, and the next response brings new ones. Times are the server's clock (`at`, `resetAt`), so `now` is too.
// No imports: Node tests it.

/** The icons' paths (24 × 24, stroked), which `Icon` draws. */
export const USAGE_ICONS = {
    warn: "M12 4l9 16H3zM12 10v4M12 17.5v.01",
    gauge: "M4 16a8 8 0 1 1 16 0M12 16l4-5",
    dash: "M12 21a9 9 0 100-18 9 9 0 000 18z",
    slash: "M12 21a9 9 0 100-18 9 9 0 000 18zM6.5 17.5l11-11",
};

/** The state of a window now: `reset` once its time has passed. */
export function windowState(window, now) {
    return window.resetAt !== undefined && now >= window.resetAt ? "reset" : window.state;
}

const left = (window) => window?.left ?? 101;
const RANK = { limited: 0, low: 1, ok: 2, reset: 3 };

/** The window that holds a person back: a limited one (the one that clears last), else the one with least left. */
export function tightestWindow(provider, now) {
    const live = provider.windows.filter((window) => windowState(window, now) !== "reset");
    const limited = live.filter((window) => window.state === "limited");

    if (limited.length > 0) {
        return limited.reduce((a, b) => ((b.resetAt ?? 0) > (a.resetAt ?? 0) ? b : a));
    }

    return (
        live.reduce((best, window) => (left(window) < left(best) ? window : best), undefined) ??
        null
    );
}

/**
 * One provider as the places show it: `state` is `limited` (a window at 0, or the limit gate holds the provider),
 * `low`, `ok`, `reset` (every window's time passed), `no-data` (no response since the server started), or
 * `not-reported` (it sends no usage). `window` is the tightest live window; `until` when a limited provider is back.
 */
export function providerView(provider, now) {
    if (provider.status === "no-data" || provider.status === "not-reported") {
        return { provider, state: provider.status, window: null, until: undefined };
    }

    const window = tightestWindow(provider, now);
    const held =
        provider.held !== undefined && provider.held.until > now ? provider.held : undefined;

    if (window?.state === "limited" || held !== undefined) {
        const until = Math.max(
            window?.state === "limited" ? (window.resetAt ?? 0) : 0,
            held?.until ?? 0,
        );

        return { provider, state: "limited", window, until: until > now ? until : undefined };
    }

    if (window === null) {
        return { provider, state: "reset", window: null, until: undefined };
    }

    return { provider, state: window.state, window, until: undefined };
}

/** Providers, the most pressing first: limited (back soonest first), low, then the least left; the rest by name. */
export function sortProviders(views) {
    const order = (view) => RANK[view.state] ?? 4;

    return views.slice().sort((a, b) => {
        const byName = a.provider.name.localeCompare(b.provider.name);

        if (order(a) !== order(b)) {
            return order(a) - order(b);
        }

        if (a.state === "limited") {
            return (a.until ?? Infinity) - (b.until ?? Infinity) || byName;
        }

        return left(a.window) - left(b.window) || byName;
    });
}

/** `1:12` for 1 hour 12 minutes: hours and minutes, rounded up to the minute. */
export function hoursMinutes(ms) {
    const minutes = Math.max(0, Math.ceil(ms / 60_000));

    return `${Math.floor(minutes / 60)}:${String(minutes % 60).padStart(2, "0")}`;
}

/** `2 h 5 min`, `3 d 18 h`, `40 s`: how long until a time. */
export function inWords(ms) {
    const seconds = Math.max(0, Math.round(ms / 1000));

    if (seconds < 60) {
        return `${seconds} s`;
    }

    const minutes = Math.round(seconds / 60);

    if (minutes < 60) {
        return `${minutes} min`;
    }

    const hours = Math.floor(minutes / 60);
    const rest = minutes % 60;

    if (hours < 24) {
        return rest > 0 ? `${hours} h ${rest} min` : `${hours} h`;
    }

    const days = Math.floor(hours / 24);
    const more = hours % 24;

    return more > 0 ? `${days} d ${more} h` : `${days} d`;
}

/** `just now`, `3 min ago`, `2 h ago`: how long since a time. */
export function agoWords(ms) {
    const seconds = Math.round(ms / 1000);

    if (seconds < 5) {
        return "just now";
    }

    if (seconds < 60) {
        return `${seconds} s ago`;
    }

    const minutes = Math.round(seconds / 60);

    return minutes < 60 ? `${minutes} min ago` : `${Math.round(minutes / 60)} h ago`;
}

/** What the model sheet's row and a screen reader say of a view: `{ text, aria }`; null when it has no numbers. */
export function summary(view, now) {
    const { provider, window } = view;

    if (view.state === "limited") {
        const back = view.until === undefined ? "" : ` Back in ${inWords(view.until - now)}.`;

        return {
            text:
                view.until === undefined ? "Limited" : `Limited ${hoursMinutes(view.until - now)}`,
            aria: `${provider.name} usage: limit reached.${back}`,
        };
    }

    if ((view.state === "low" || view.state === "ok") && window?.left !== undefined) {
        const reset =
            window.resetAt === undefined ? "" : `. It resets in ${inWords(window.resetAt - now)}`;

        return {
            text: `${window.tag === "" ? "" : `${window.tag} `}${window.left}% left`,
            aria: `${provider.name} usage: ${view.state === "low" ? "low, " : ""}${window.left}% left in the ${window.label.toLowerCase()}${reset}.`,
        };
    }

    return null;
}
