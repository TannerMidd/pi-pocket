// Project trust. A project's own skills (`.agents/skills`) load only in a project Pi trusts, as in Pi's CLI. The bar
// above the message box asks the owner when a session's project has such skills and nobody decided yet; the sheet
// (`/trust`, the menu) shows the decision and changes it. Answers are saved where Pi's CLI keeps its own.
import { useEffect } from "preact/hooks";
import { actions, attempt, closeSheet, notify, openSheet, store } from "./store.js";
import { html, Icon, Loader, Sheet, shortPath } from "./ui.js";

/** Only the owner decides which projects Pi trusts: the answer goes into Pi's own settings. */
export const trustAvailable = () => store.state.me?.role === "owner";

/** The folders whose question the owner put off in this tab ("Not now"): the sheet and `/trust` still answer it. */
const LATER_KEY = "pocket.trustLater";

function later() {
    try {
        return new Set(JSON.parse(sessionStorage.getItem(LATER_KEY) ?? "[]"));
    } catch {
        return new Set();
    }
}

function putOff(folder) {
    sessionStorage.setItem(LATER_KEY, JSON.stringify([...later(), folder]));
    store.set({});
}

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
function skillNames(skills, most = 3) {
    const names = skills.map((skill) => skill.name);

    if (names.length <= most) {
        return names.join(", ");
    }

    return `${names.slice(0, most).join(", ")}, and ${names.length - most} more`;
}

/** Save the owner's answer, and show it: the bar goes, and the skills join the slash commands. */
async function decide(choice) {
    const { conversationId, view, server } = store.state;
    const cwd = view.agent?.cwd;
    const info = await actions.setTrust(choice);

    // Saved for that session's folder; this tab shows another session now: its own trust stays as it is.
    if (store.state.conversationId !== conversationId || store.state.view.agent?.cwd !== cwd) {
        return;
    }

    store.set({ trust: { conversationId, cwd, info }, templates: null });

    if (!info.trusted) {
        notify("info", "Not trusted: the project's own skills stay off. /trust changes that.");

        return;
    }

    const where =
        choice === "trust-parent"
            ? `${shortPath(info.parent, server?.home)} and the folders in it`
            : "this project";
    const skills =
        info.skills.length > 0 ? ` Pi has its skills from now on: ${skillNames(info.skills)}.` : "";

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

    if (!mine || !info?.ask || later().has(info.folder)) {
        return null;
    }

    return html`<div class="trust-bar">
        <span class="grow">
            <strong>Trust this project?</strong> Its skills in .agents/skills (${skillNames(info.skills)}) load only in a project Pi trusts.
        </span>
        <span class="trust-actions">
            <button class="link small" onClick=${() => attempt(() => decide("distrust"))}>
                Don't trust
            </button>
            <button class="button small primary" onClick=${() => openSheet({ type: "trust" })}>
                Review
            </button>
            <button
                class="icon-button"
                aria-label="Not now"
                title="Not now: ask again in a new tab"
                onClick=${() => putOff(info.folder)}
            >
                <${Icon} name="close" size=${13} />
            </button>
        </span>
    </div>`;
}

/** An answer in the sheet: what it does, the folder it is about when that is not this one, and whether it is saved. */
function Choice({ label, detail, current, onClick }) {
    return html`<button class="list-item trust-choice" onClick=${onClick}>
        <span class="trust-choice-text">
            <span>${label}</span>
            ${detail && html`<span class="muted small mono">${detail}</span>`}
        </span>
        ${current && html`<span class="trust-current">✓ current</span>`}
    </button>`;
}

/**
 * Whether Pi was told not to trust the project: a saved "no", or its setting for undecided projects. A trust store that
 * cannot be read decides nothing (as on the server, `skills.ts`), so the project's .pi/skills load.
 */
const distrusted = (info) =>
    !info.trusted &&
    !info.unreadable &&
    (info.saved?.trusted === false ||
        (info.saved === null && info.defaultProjectTrust === "never"));

/** What the project's own skills do here, a sentence for each place they are in. */
function ownSkillsText(info) {
    const list = (skills) => skillNames(skills, 8);
    const texts = [];

    if (info.skills.length > 0) {
        texts.push(
            `In .agents/skills: ${list(info.skills)}. ${info.trusted ? "Pi has them." : "They load once you trust it."}`,
        );
    }

    if (info.ownSkills.length > 0) {
        texts.push(
            `In .pi/skills: ${list(info.ownSkills)}. ${distrusted(info) ? "They stay off while it is not trusted." : "They load unless you choose Don't trust."}`,
        );
    }

    return texts.length > 0
        ? texts
        : ["It has no skills of its own, so this changes nothing in Pi Pocket here."];
}

/** Where the decision comes from, in a sentence. */
function status(info, short) {
    if (info.unreadable) {
        return "Pi's trust store (~/.pi/agent/trust.json) cannot be read, so no project is trusted, and no answer can be saved until it is mended or deleted.";
    }

    if (info.saved === null) {
        if (info.defaultProjectTrust === "always") {
            return "Trusted: no decision is saved for it, and Pi's defaultProjectTrust setting trusts every project.";
        }

        if (info.defaultProjectTrust === "never") {
            return "Not trusted: no decision is saved for it, and Pi's defaultProjectTrust setting trusts no project.";
        }

        return info.skills.length > 0
            ? "No decision yet. Until there is one, Pi Pocket leaves its skills in .agents/skills off."
            : "No decision yet.";
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
    const saved = (path, trusted) => info.saved?.path === path && info.saved.trusted === trusted;

    return html`<${Sheet} title="Project trust" onClose=${closeSheet}>
        <p class="mono small">${short(info.folder)}</p>
        <p>${status(info, short)}</p>
        ${ownSkillsText(info).map((text) => html`<p>${text}</p>`)}
        <p class="muted small">
            Pi's CLI goes by the same decision, saved in ~/.pi/agent/trust.json. There, trusting a project also loads its .pi settings, extensions, and packages, which run code on this machine. Trust only folders whose contents you trust.
        </p>
        ${
            !trustAvailable()
                ? html`<p class="muted small">Only the owner can change this.</p>`
                : !info.unreadable &&
                  html`<div class="group">
                      <${Choice}
                          label="Trust this folder"
                          current=${saved(info.folder, true)}
                          onClick=${() => choose("trust")}
                      />
                      ${
                          info.parent &&
                          html`<${Choice}
                              label="Trust the folder above it"
                              detail=${short(info.parent)}
                              current=${saved(info.parent, true)}
                              onClick=${() => choose("trust-parent")}
                          />`
                      }
                      <${Choice}
                          label="Don't trust"
                          current=${saved(info.folder, false)}
                          onClick=${() => choose("distrust")}
                      />
                  </div>`
        }
    <//>`;
}
