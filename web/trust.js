// Project trust. A project's own skills (`.agents/skills`) load only in a project Pi trusts, as in Pi's CLI. The bar
// above the message box asks the owner when a session's project has such skills and nobody decided yet; the sheet
// (`/trust`, the menu) shows the decision and changes it. Answers are saved where Pi's CLI keeps its own.
import { useEffect } from "preact/hooks";
import { actions, attempt, closeSheet, notify, openSheet, store } from "./store.js";
import { html, item, Loader, Sheet, shortPath } from "./ui.js";

/** Only the owner decides which projects Pi trusts: the answer goes into Pi's own settings. */
export const trustAvailable = () => store.state.me?.role === "owner";

/** What the server said about the open conversation's project, when it was for its folder now. */
export function currentTrust() {
    const { trust, conversationId, view } = store.state;

    return trust?.conversationId === conversationId && trust.cwd === view.agent?.cwd
        ? trust.info
        : null;
}

/** Fetch whether Pi trusts the open conversation's project, unless that is known for its folder (or `force`). */
export function loadTrust({ force = false } = {}) {
    const { conversationId, view, trust } = store.state;
    const cwd = view.agent?.cwd;
    const known = trust?.conversationId === conversationId && trust.cwd === cwd;

    if (conversationId === null || !cwd || (known && !force)) {
        return;
    }

    store.set({ trust: { conversationId, cwd, info: known ? trust.info : null } });
    actions.trust().then(
        (info) => {
            const now = store.state.trust;

            if (now?.conversationId === conversationId && now.cwd === cwd) {
                store.set({ trust: { ...now, info } });
            }
        },
        () => {},
    );
}

/** The skills' names, a few of them: "deploy, review, and 3 more". */
function skillNames(info, most = 3) {
    const names = info.skills.map((skill) => skill.name);

    if (names.length <= most) {
        return names.join(", ");
    }

    return `${names.slice(0, most).join(", ")}, and ${names.length - most} more`;
}

/** Save the owner's answer, and show it: the bar goes, and the skills join the slash commands. */
async function decide(choice) {
    const { conversationId, view, server } = store.state;
    const info = await actions.setTrust(choice);

    store.set({ trust: { conversationId, cwd: view.agent?.cwd, info }, templates: null });

    if (!info.trusted) {
        notify("info", "Not trusted: the project's own skills stay off. /trust changes that.");

        return;
    }

    const where =
        choice === "trust-parent"
            ? `${shortPath(info.parent, server?.home)} and the folders in it`
            : "this project";
    const skills =
        info.skills.length > 0 ? ` Pi has its skills from now on: ${skillNames(info)}.` : "";

    notify("info", `Trusted ${where}.${skills}`);
}

/** Above the message box, for the owner: this project has its own skills, waiting for an answer. */
export function TrustBar() {
    const { conversationId } = store.state;
    const cwd = store.state.view.agent?.cwd;
    const mine = trustAvailable();

    useEffect(() => {
        if (mine) {
            loadTrust();
        }
    }, [conversationId, cwd, mine]);
    const info = currentTrust();

    if (!mine || !info?.ask) {
        return null;
    }

    return html`<div class="trust-bar">
        <span class="grow">
            <strong>Trust this project?</strong> Its own skills (${skillNames(info)}) load only in a project Pi trusts.
        </span>
        <button class="link small" onClick=${() => attempt(() => decide("distrust"))}>
            Don't trust
        </button>
        <button class="button small primary" onClick=${() => openSheet({ type: "trust" })}>
            Review
        </button>
    </div>`;
}

/** Where the decision comes from, in a sentence. */
function status(info, short) {
    if (info.saved === null) {
        if (info.defaultProjectTrust === "always") {
            return "Trusted: no decision is saved for it, and Pi's defaultProjectTrust setting trusts every project.";
        }

        if (info.defaultProjectTrust === "never") {
            return "Not trusted: no decision is saved for it, and Pi's defaultProjectTrust setting trusts no project.";
        }

        return "No decision yet. Until there is one, Pi Pocket leaves the project's own skills off.";
    }

    const what = info.saved.trusted ? "Trusted" : "Not trusted";

    return info.saved.path === info.folder
        ? `${what}.`
        : `${what}, as the folder it is in: ${short(info.saved.path)}.`;
}

/** The project's trust, and the three answers Pi's `/trust` offers. */
export function TrustSheet() {
    const { server } = store.state;
    const short = (path) => shortPath(path, server?.home);

    useEffect(() => loadTrust({ force: true }), []);
    const info = currentTrust();

    if (!info) {
        return html`<${Sheet} title="Project trust" onClose=${closeSheet}>
            <${Loader} label="Loading" />
        <//>`;
    }

    const choose = (choice) =>
        attempt(async () => {
            await decide(choice);
            closeSheet();
        });
    const saved = (path, trusted) =>
        info.saved?.path === path && info.saved.trusted === trusted ? "current" : "";

    return html`<${Sheet} title="Project trust" onClose=${closeSheet}>
        <p class="mono small">${short(info.folder)}</p>
        <p>${status(info, short)}</p>
        <p>
            ${
                info.skills.length > 0
                    ? `Its own skills, in .agents/skills: ${skillNames(info, 8)}. ${info.trusted ? "Pi has them." : "They load once you trust it."}`
                    : "It has no skills in .agents/skills, so this changes nothing in Pi Pocket here."
            }
        </p>
        <p class="muted small">
            Pi's CLI goes by the same decision, saved in ~/.pi/agent/trust.json. There, trusting a project also loads its .pi settings, extensions, and packages, which run code on this machine. Trust only folders whose contents you trust.
        </p>
        ${
            trustAvailable()
                ? html`<div class="group">
                    ${item("Trust this folder", () => choose("trust"), saved(info.folder, true))}
                    ${
                        info.parent &&
                        item(
                            "Trust the folder above it",
                            () => choose("trust-parent"),
                            [short(info.parent), saved(info.parent, true)]
                                .filter(Boolean)
                                .join(" · "),
                        )
                    }
                    ${item("Don't trust", () => choose("distrust"), saved(info.folder, false))}
                </div>`
                : html`<p class="muted small">Only the owner can change this.</p>`
        }
    <//>`;
}
