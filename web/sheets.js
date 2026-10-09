// The open sheet: which component shows it. The sheets themselves are in web/sheets/, and a few beside their features
// (chat.js, notify.js, share.js).
import { ChatSheet } from "./chat.js";
import { NotificationsSheet } from "./notify.js";
import { ShareSheet } from "./share.js";
import { AppearanceSheet } from "./sheets/appearance.js";
import { BranchPicker } from "./sheets/branch.js";
import { ExtensionsSheet } from "./sheets/extensions.js";
import { FileSheet } from "./sheets/file.js";
import { FindSheet } from "./sheets/find.js";
import { CwdSheet } from "./sheets/folder.js";
import { MenuSheet, PlacesSheet } from "./sheets/menu.js";
import { MessageSheet } from "./sheets/message.js";
import { ModelPicker } from "./sheets/model.js";
import { InviteSheet, PeopleSheet } from "./sheets/people.js";
import { AuthDialog, ProvidersSheet } from "./sheets/providers.js";
import { RunningSheet } from "./sheets/running.js";
import { SchedulesSheet } from "./sheets/schedules.js";
import { ShortcutsSheet } from "./sheets/shortcuts.js";
import { SpendSheet } from "./sheets/spend.js";
import { TextSheet } from "./sheets/text.js";
import { ArtifactsSheet, ArtifactViewer, ImageViewer } from "./sheets/viewers.js";
import { WorktreeSheet } from "./sheets/worktree.js";
import { TrustSheet } from "./trust.js";
import { addLayer, removeLayer } from "./back.js";
import { actions, api, store } from "./store.js";
import { Boundary, html, usePresence } from "./ui.js";

// ─── Back ─────────────────────────────────────────────────────────────────────────

/** What tells sheets apart: the same one changing (its query, say) stays one step back. */
const sheetKey = (sheet) => `${sheet.type}:${sheet.entryId ?? sheet.id ?? ""}`;

/**
 * The sheets opened one from another, oldest first (the menu, then the model picker it opened): each is a step back,
 * so back from one shows the sheet before it. `{ key, sheet, layer }`.
 */
const trail = [];
/** The conversation the trail's sheets were opened in: another one (a notice's link, with its sheet) starts afresh. */
let trailIn = store.state.conversationId;

store.subscribe(({ sheet, conversationId }) => {
    if (!sheet || conversationId !== trailIn) {
        trailIn = conversationId;

        for (const step of trail.splice(0)) {
            removeLayer(step.layer);
        }
    }

    if (!sheet) {
        return;
    }

    const key = sheetKey(sheet);
    const at = trail.findIndex((step) => step.key === key);

    // The same sheet, or one opened before it, shown again: the steps after it are gone.
    if (at !== -1) {
        for (const step of trail.splice(at + 1)) {
            removeLayer(step.layer);
        }

        trail[at].sheet = sheet;

        return;
    }

    const step = { key, sheet, layer: null };

    step.layer = addLayer(() => {
        const index = trail.indexOf(step);

        if (index !== -1) {
            trail.splice(index);
        }

        store.set({ sheet: trail.at(-1)?.sheet ?? null });
    });
    trail.push(step);
});

/**
 * The open sheet, if any. A sheet that closes stays a moment longer, marked as leaving, so it can animate out; one sheet
 * replacing another swaps at once.
 */
export function Sheets() {
    const [sheet, leaving] = usePresence(store.state.sheet, 200);
    const auth = store.state.auth ? html`<${AuthDialog} />` : null;

    if (!sheet) {
        return auth;
    }

    const key = `${sheet.type}:${sheet.entryId ?? sheet.id ?? ""}`;

    return html`<div class=${`sheet-host ${leaving ? "leaving" : ""}`} inert=${leaving}>
        <${Boundary} key=${key} reset=${sheet}>${sheetBody(sheet)}<//>
    </div>
    ${auth}`;
}

function sheetBody(sheet) {
    const { view, me } = store.state;
    let body = null;

    switch (sheet.type) {
        case "appearance":
            body = html`<${AppearanceSheet} />`;
            break;
        case "shortcuts":
            body = html`<${ShortcutsSheet} />`;
            break;
        case "model":
            body = html`<${ModelPicker} />`;
            break;
        case "branch":
            body = view.conversation ? html`<${BranchPicker} />` : null;
            break;
        case "cwd":
            body = html`<${CwdSheet} mode=${sheet.mode} />`;
            break;
        case "artifacts":
            body = html`<${ArtifactsSheet} />`;
            break;
        case "viewer":
            body = view.conversation
                ? html`<${ArtifactViewer} id=${sheet.id} version=${sheet.version} />`
                : null;
            break;
        case "providers":
            body = html`<${ProvidersSheet} />`;
            break;
        case "extensions":
            body = html`<${ExtensionsSheet} />`;
            break;
        case "image":
            body = html`<${ImageViewer} src=${sheet.src} alt=${sheet.alt} />`;
            break;
        case "invite":
            body = html`<${InviteSheet} session=${sheet.session ?? null} />`;
            break;
        case "people":
            body = html`<${PeopleSheet} />`;
            break;
        case "notifications":
            body = html`<${NotificationsSheet} />`;
            break;
        case "menu":
            body = html`<${MenuSheet} />`;
            break;
        case "places":
            body = view.conversation ? html`<${PlacesSheet} />` : null;
            break;
        case "chat":
            body = view.conversation ? html`<${ChatSheet} />` : null;
            break;
        case "rename":
            body = html`<${TextSheet}
                title="Rename"
                label="Session title"
                initial=${view.conversation?.title ?? ""}
                submit=${(value) => actions.updateSession(view.conversation.id, { title: value })}
            />`;
            break;
        case "worktree":
            body = html`<${WorktreeSheet} />`;
            break;
        case "trust":
            body = view.conversation ? html`<${TrustSheet} />` : null;
            break;
        case "file":
            body = view.conversation
                ? html`<${FileSheet} key=${sheet.id} path=${sheet.id} line=${sheet.line} />`
                : null;
            break;
        case "find":
            body = view.conversation
                ? html`<${FindSheet} key=${view.conversation.id} initial=${sheet.query ?? ""} />`
                : null;
            break;
        case "spend":
            body = html`<${SpendSheet} />`;
            break;
        case "running":
            body = html`<${RunningSheet} />`;
            break;
        case "schedules":
            body = view.conversation ? html`<${SchedulesSheet} />` : null;
            break;
        case "share":
            body = html`<${ShareSheet} share=${sheet.share} />`;
            break;
        case "message":
            body = view.conversation
                ? html`<${MessageSheet} key=${sheet.entryId} entryId=${sheet.entryId} />`
                : null;
            break;
        case "reset":
            body = html`<${TextSheet}
                title="New context"
                hint="Pi starts fresh: it no longer sees the messages so far, though everyone here still does."
                label="Handoff note (optional)"
                placeholder="e.g. We fixed the login bug; next is the signup form."
                multiline=${true}
                button="Start a new context"
                submit=${(value) => actions.reset(value)}
            />`;
            break;
        case "instructions":
            body = html`<${TextSheet}
                title="Instructions for Pi"
                hint="Pi gets these with every message in this session, after its own instructions. Everyone here can see them. Leave empty for none."
                label="Instructions"
                initial=${view.agent?.instructions ?? ""}
                placeholder="e.g. Use pnpm, not npm. Ask before adding dependencies."
                multiline=${true}
                submit=${(value) => actions.setInstructions(value)}
            />`;
            break;
        case "compact":
            body = html`<${TextSheet}
                title="Compact context"
                label="What should the summary keep? (optional)"
                placeholder="e.g. the failing test names"
                multiline=${true}
                button="Compact"
                submit=${(value) => actions.compact(value)}
            />`;
            break;
        case "name":
            body = html`<${TextSheet}
                title="Your name"
                label="Shown on your messages to others"
                initial=${me?.name ?? ""}
                submit=${async (value) => {
                    await api("me", { name: value });
                    const hello = await api("me");

                    store.set({ me: hello.user, users: hello.users });
                }}
            />`;
            break;
    }

    return body;
}
