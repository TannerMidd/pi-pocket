import { routeState } from "./back.js";

// History carries an opaque visit key, not search text, titles, or read state. Results are always recomputed from the current person's list.
const visits = new Map();

addEventListener("pocket:signedOut", () => visits.clear());

export const familyPath = (scope) => "/s/index/" + scope;

export function newFamilyVisit(scope, query = "", origin = null) {
    const visit = {
        scope,
        key: Math.random().toString(36).slice(2),
        query,
        page: 0,
        filter: "all",
        sort: scope === "attention" ? "priority" : "new",
        scroll: 0,
        focus: null,
        origin: location.pathname,
        opener: origin?.dataset.familyOpen,
        sideQuery: origin?.closest(".sessions")?.querySelector(".search input")?.value ?? "",
        sideTab: origin?.closest(".sessions")?.querySelector("[aria-selected=true]")?.dataset.tab,
        drawer: !!origin?.closest(".drawer"),
        sideScroll: origin?.closest(".sessions")?.querySelector(".session-items")?.scrollTop ?? 0,
    };

    visits.set(visit.key, visit);

    if (visits.size > 64) {
        visits.delete(visits.keys().next().value);
    }

    return visit;
}

export function routeFamily() {
    const scope = /^\/s\/index\/(all|work|attention|\d+)$/.exec(location.pathname)?.[1];

    if (!scope) {
        return null;
    }

    const visit = visits.get(routeState("familyKey"));

    return visit?.scope === scope ? visit : newFamilyVisit(scope);
}

export function restoreFamilyOpener(visit) {
    if (!visit.opener) {
        return;
    }

    requestAnimationFrame(() => {
        const host = visit.drawer ? ".drawer" : ".layout";
        const target = document.querySelector(
            host + ' [data-family-open="' + CSS.escape(visit.opener) + '"]',
        );
        const list = target?.closest(".session-items");

        if (list) {
            list.scrollTop = visit.sideScroll;
        }

        target?.focus({ preventScroll: true });
    });
}
