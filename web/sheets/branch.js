// The branch picker: the git branch this session's folder has checked out, and the others to switch to or make, in a
// menu down from the branch in the top bar.
import { useEffect, useRef, useState } from "preact/hooks";
import { t } from "../i18n.js";
import { actions, attempt, canSteer, closeSheet, notify, scoped, store } from "../store.js";
import { anchorStyle, html, Icon, popAnchor, shortPath, timeAgo } from "../ui.js";

const coarsePointer = matchMedia("(pointer: coarse)").matches;

/** The picker is for people who can steer, in a session whose folder is in a git repository. */
export const branchAvailable = () => canSteer() && Boolean(store.state.view.branch);

/** Where the picker opens: under the branch in the top bar (`popAnchor`), or above the message box without it. */
const branchAnchor = () => popAnchor(".topbar button.title-branch") ?? popAnchor(".composer");

/** What a folder has checked out, in a few characters: its branch, or the commit it is at. */
export const headLabel = (head) => head?.branch ?? head?.detached ?? "";

/** A name typed for a new branch, as git takes one: spaces become dashes. */
const asBranchName = (text) => text.trim().replace(/\s+/g, "-");

/** Why this person cannot switch branches here now, or null when they can: the server's rules, said before a tap. */
function whyNot() {
    const { view, me } = store.state;

    if (!canSteer()) {
        return t("Viewers can see the branch, not switch it.");
    }

    if (scoped()) {
        return t("You were invited to one session: switching the branch changes the whole folder.");
    }

    if (view.turns?.on && view.turns.driver !== me?.id) {
        return t("Take turns is on: the driver switches branches.");
    }

    if (view.live?.busy) {
        return t("Pi is working: switch once it is done, or stop it.");
    }

    return null;
}

/** How far a branch is from the remote branch it follows, as ↑2 ↓1, or that the remote branch is gone. */
function Track({ upstream }) {
    if (!upstream) {
        return null;
    }

    if (upstream.gone) {
        return html`<span class="branch-track warn" title=${t("{{name}} is gone", { name: upstream.name })}>{t("gone")}</span>`;
    }

    return (
        (upstream.ahead > 0 || upstream.behind > 0) &&
        html`<span class="branch-track" title=${t("Against {{name}}", { name: upstream.name })}>
            ${upstream.ahead > 0 ? `↑${upstream.ahead}` : ""}${upstream.ahead > 0 && upstream.behind > 0 ? " " : ""}${upstream.behind > 0 ? `↓${upstream.behind}` : ""}
        </span>`
    );
}

/**
 * The branch picker: a menu down from the branch, with the folder's branches (the current one first and checked, then
 * the newest), the remote branches it has no local branch for, and, for a name typed that is not a branch yet, a new
 * branch made from what is checked out. Arrows and Enter pick, as in the model picker; `/branch fix` opens it already
 * searching.
 */
export function BranchPicker() {
    const { view, server } = store.state;
    const [query, setQuery] = useState(store.state.sheet?.query ?? "");
    const [branches, setBranches] = useState(null);
    const [error, setError] = useState(null);
    const [switching, setSwitching] = useState(false);
    const [picked, setPicked] = useState(0);
    const [anchor, setAnchor] = useState(branchAnchor);
    const box = useRef(null);
    const search = useRef(null);
    const list = useRef(null);
    // Arrows scroll the list to the row they reach; the mouse does not, or the list would run away under it.
    const keyed = useRef(false);
    const blocked = whyNot();
    const needle = query.trim().toLowerCase();
    const matches = (name) => needle === "" || name.toLowerCase().includes(needle);
    // The current branch first, then the rest newest first: Enter on an untouched list keeps the branch.
    const local = (branches?.local ?? [])
        .filter((branch) => matches(branch.name))
        .sort((a, b) => Number(b.current) - Number(a.current));
    const remote = (branches?.remote ?? []).filter((branch) => matches(branch.name));
    const name = asBranchName(query);
    // A name typed that is no branch yet, here or as a remote one (which its own row switches to), can be made.
    const make =
        branches &&
        name !== "" &&
        !branches.local.some((branch) => branch.name === name) &&
        !branches.remote.some((branch) => branch.name.slice(branch.name.indexOf("/") + 1) === name)
            ? name
            : null;
    const rows = [
        ...local.map((branch) => ({ kind: "local", key: `l:${branch.name}`, branch })),
        ...remote.map((branch) => ({ kind: "remote", key: `r:${branch.name}`, branch })),
        ...(make ? [{ kind: "make", key: "make", name: make }] : []),
    ];
    // The list can change while the picker is open.
    const active = Math.max(0, Math.min(picked, rows.length - 1));

    useEffect(() => {
        const place = () => setAnchor(branchAnchor());
        const onKey = (event) => event.key === "Escape" && closeSheet();

        addEventListener("resize", place);
        visualViewport?.addEventListener("resize", place);
        addEventListener("keydown", onKey);
        // Keys go to the picker, not the message box behind it. Phones keep their keyboard down until the search is tapped.
        (coarsePointer ? box.current : search.current)?.focus({ preventScroll: true });

        return () => {
            removeEventListener("resize", place);
            visualViewport?.removeEventListener("resize", place);
            removeEventListener("keydown", onKey);
        };
    }, []);
    // Read each time the picker opens (one opened again while it was closing, or by `/branch name` while open, is the same
    // picker) and when the branch changes while it is open.
    const opened = store.state.sheet;
    const head = JSON.stringify(view.branch);

    useEffect(() => {
        if (opened?.type !== "branch") {
            return;
        }

        let live = true;

        setError(null);
        actions.branches().then(
            (each) => live && setBranches(each),
            (failure) => live && setError(failure.message),
        );

        return () => {
            live = false;
        };
    }, [opened, head]);
    useEffect(() => {
        if (opened?.type === "branch" && opened.query !== undefined) {
            setQuery(opened.query);
            setPicked(0);
        }
    }, [opened]);
    useEffect(() => {
        if (!keyed.current) {
            return;
        }

        keyed.current = false;
        list.current?.querySelector(".pop-menu-row.on")?.scrollIntoView({ block: "nearest" });
    }, [active]);

    const pick = (row) => {
        if (row.kind === "local" && row.branch.current) {
            closeSheet();

            return;
        }

        if (row.kind === "local" && row.branch.worktree) {
            notify(
                "info",
                t("{{branch}} is checked out in {{path}}: git switches to it only there.", {
                    branch: row.branch.name,
                    path: shortPath(row.branch.worktree, server?.home),
                }),
            );

            return;
        }

        if (blocked) {
            notify("error", blocked);

            return;
        }

        const target =
            row.kind === "remote"
                ? { track: row.branch.name }
                : row.kind === "make"
                  ? { name: row.name, create: true }
                  : { name: row.branch.name };

        setSwitching(true);
        attempt(async () => {
            const { branch } = await actions.switchBranch(target);

            notify("info", t("On {{branch}} now.", { branch }));
            closeSheet();
        }).then(() => setSwitching(false));
    };

    const rowBody = (each) => {
        if (each.kind === "make") {
            return html`<${Icon} name="plus" size=${14} />
                <span class="pop-menu-row-text">
                    <span class="pop-menu-row-name">${t("Make the branch")} <span class="mono">${each.name}</span></span>
                    <span class="pop-menu-row-sub">${t("from {{head}}{{changes}}", { head: headLabel(view.branch) || t("here"), changes: branches.changed > 0 ? t(", with your uncommitted changes") : "" })}</span>
                </span>`;
        }

        const { branch } = each;
        const sub =
            each.kind === "local" && branch.worktree
                ? t("in another worktree: {{path}}", {
                      path: shortPath(branch.worktree, server?.home),
                  })
                : [branch.subject, branch.at ? timeAgo(branch.at) : t("no commits yet")]
                      .filter(Boolean)
                      .join(" · ");

        return html`<span class="pop-menu-row-text">
                <span class="pop-menu-row-name mono">${branch.name}</span>
                <span class="pop-menu-row-sub">${sub}</span>
            </span>
            ${each.kind === "local" && html`<${Track} upstream=${branch.upstream} />`}
            ${each.kind === "local" && branch.current && html`<${Icon} name="check" size=${14} />`}`;
    };

    // Arrows and Enter move through the rows from the search box or the picker itself, not from its other buttons.
    const onKeyDown = (event) => {
        if (
            event.isComposing ||
            rows.length === 0 ||
            (event.target !== search.current && event.target !== box.current)
        ) {
            return;
        }

        const step = event.key === "ArrowDown" ? 1 : event.key === "ArrowUp" ? -1 : 0;

        if (step !== 0) {
            event.preventDefault();
            keyed.current = true;
            setPicked((active + step + rows.length) % rows.length);
        } else if (event.key === "Enter" && rows[active] && !switching) {
            event.preventDefault();
            pick(rows[active]);
        }
    };

    const row = (each, index, body) => html`<button
        key=${each.key}
        class=${`pop-menu-row ${index === active ? "on" : ""} ${each.branch?.worktree ? "elsewhere" : ""}`}
        role="option"
        aria-selected=${each.kind === "local" && each.branch.current}
        disabled=${switching}
        onMouseMove=${() => index !== active && setPicked(index)}
        onClick=${() => pick(each)}
    >
        ${body}
    </button>`;

    return html`<div
        class="overlay pop-overlay"
        onClick=${(event) => event.target === event.currentTarget && closeSheet()}
    >
        <section
            class=${`pop-menu ${anchor ? (anchor.down ? "down" : "") : "free"}`}
            style=${anchorStyle(anchor)}
            ref=${box}
            role="dialog"
            aria-label=${t("Branch")}
            tabindex="-1"
            onKeyDown=${onKeyDown}
        >
            <header class="pop-menu-head">
                <span>${t("Branch")}</span>
                <span class="branch-head mono" title=${t(view.branch?.detached ? "No branch: a commit" : "Checked out")}>
                    <${Icon} name="fork" size=${12} /> ${headLabel(view.branch) || "none"}
                </span>
            </header>
            <label class="search pop-menu-search">
                <${Icon} name="search" size=${15} />
                <input
                    ref=${search}
                    placeholder=${t("Switch to or make a branch")}
                    value=${query}
                    autocapitalize="off"
                    autocomplete="off"
                    spellcheck="false"
                    onInput=${(event) => {
                        setQuery(event.currentTarget.value);
                        setPicked(0);
                    }}
                />
            </label>
            <div class="pop-menu-list" ref=${list} role="listbox" aria-label=${t("Branches")}>
                ${error && html`<p class="muted pop-menu-note">${error}</p>`}
                ${!branches && !error && html`<p class="muted pop-menu-note">${t("Asking git…")}</p>`}
                ${
                    branches &&
                    rows.length === 0 &&
                    html`<p class="muted pop-menu-note">${t("No branch matches “{{query}}”.", { query: query.trim() })}</p>`
                }
                ${rows.flatMap((each, index) => [
                    each.kind === "remote" &&
                        rows[index - 1]?.kind !== "remote" &&
                        html`<div class="pop-menu-label" key="remote">${t("Remote")}</div>`,
                    row(each, index, rowBody(each)),
                ])}
            </div>
            ${
                branches &&
                (blocked || branches.changed > 0 || branches.more > 0) &&
                html`<div class="pop-menu-foot small">
                    ${blocked && html`<p class="warn">${blocked}</p>`}
                    ${!blocked && branches.changed > 0 && html`<p class="muted">${t("{{count}} file(s) have uncommitted changes: they come along, unless the other branch changes them too.", { count: branches.changed })}</p>`}
                    ${
                        branches.more > 0 &&
                        html`<p class="muted">
                            ${t("{{count}} older branches are not listed.", { count: branches.more.toLocaleString() })}
                        </p>`
                    }
                </div>`
            }
        </section>
    </div>`;
}
