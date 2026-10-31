// The open sheet: which component shows it. The sheets themselves are in web/sheets/, and a few beside their features
// (chat.js, notify.js, share.js).
import { ChatSheet } from "./chat.js";
import { ExtensionSheet, onExtensionsGone } from "./extension-ui.js";
import { NotificationsSheet } from "./notify.js";
import { ShareSheet } from "./share.js";
import { AppearanceSheet } from "./sheets/appearance.js";
import { BranchPicker } from "./sheets/branch.js";
import { ExtensionsContent, ExtensionsSheet } from "./sheets/extensions.js";
import { FileSheet } from "./sheets/file.js";
import { FindSheet } from "./sheets/find.js";
import {
    galleryAvailable,
    GalleryShareSheet,
    GallerySheet,
    GallerySourceSheet,
    GalleryUpdateSheet,
} from "./sheets/gallery.js";
import { CwdSheet } from "./sheets/folder.js";
import { MemorySheet } from "./sheets/memory.js";
import { MenuSheet, PlacesSheet } from "./sheets/menu.js";
import { MessageSheet } from "./sheets/message.js";
import { ModelPicker } from "./sheets/model.js";
import { InviteSheet, PeopleSheet } from "./sheets/people.js";
import { AuthDialog, ProvidersSheet } from "./sheets/providers.js";
import { RunningSheet } from "./sheets/running.js";
import { HooksSheet } from "./sheets/hooks.js";
import { SchedulesSheet } from "./sheets/schedules.js";
import { SessionSheet } from "./sheets/session.js";
import { ShortcutsSheet } from "./sheets/shortcuts.js";
import { SpendSheet } from "./sheets/spend.js";
import { TextSheet } from "./sheets/text.js";
import {
    ArtifactsSheet,
    ArtifactShareSheet,
    ArtifactViewer,
    ImageViewer,
} from "./sheets/viewers.js";
import { PiSessionSheet, PiSessionsSheet, piSessionsAvailable } from "./sheets/pi-sessions.js";
import { WorktreeSheet } from "./sheets/worktree.js";
import { TrustSheet } from "./trust.js";
import { addLayer, goBack, removeLayer } from "./back.js";
import { actions, api, signOut, store } from "./store.js";
import { Boundary, html, Icon, SheetBack, SheetInfo, usePresence } from "./ui.js";

// ─── Back ─────────────────────────────────────────────────────────────────────────

// Identity must not change when Installed turns the gallery module on or off.
const isExtensionHub = (sheet) => ["extensions", "gallery", "gallery-entry"].includes(sheet.type);

/** A hub selection is one step back, even when desktop browsing changes the selected entry. */
const sheetKey = (sheet) =>
    isExtensionHub(sheet)
        ? `extension-hub:${sheet.type === "gallery-entry" ? "entry" : "list"}`
        : `${sheet.type}:${sheet.entryId ?? sheet.id ?? ""}`;

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

// A module turned off: its sheets under the one open come out of the trail, with their steps back, so back never shows
// one of a module that is gone. Its sheet that is open closes (`extension-ui.js`), and the whole trail with it.
onExtensionsGone((gone) => {
    const went = trail.filter((each) => each.sheet.type === "ext" && gone(each.sheet.module));

    for (const step of went) {
        trail.splice(trail.indexOf(step), 1);
        removeLayer(step.layer);
    }
});

// ─── Focus ────────────────────────────────────────────────────────────────────────

/** What had focus when a sheet opened over the app: it has it again when the last sheet closes. */
let opener = null;
/** What last had focus outside the sheets and the launcher: a sheet the launcher opens goes back there. */
let lastFocus = null;

addEventListener("focusin", (event) => {
    if (!event.target.closest?.(".sheet-host, .launcher-overlay")) {
        lastFocus = event.target;
    }
});

store.subscribe(({ sheet, launcher }) => {
    if (sheet && !opener) {
        const active = document.activeElement;

        opener = active?.closest(".launcher-overlay") ? lastFocus : active;
    } else if (!sheet && opener) {
        const back = opener;
        const active = document.activeElement;

        opener = null;

        // Unless something else took focus meanwhile (a session the sheet opened), or a phone's keyboard would pop up.
        if (
            (active === null || active === document.body || active.closest(".sheet-host")) &&
            !launcher &&
            back.isConnected &&
            !back.closest(".sheet-host") &&
            !(
                matchMedia("(pointer: coarse)").matches &&
                back.matches("input, textarea, [contenteditable]")
            )
        ) {
            back.focus({ preventScroll: true });
        }
    }
});

/**
 * The open sheet, if any. A sheet that closes stays a moment longer, marked as leaving, so it can animate out; one sheet
 * replacing another swaps at once.
 */
export function Sheets() {
    const [sheet, leaving] = usePresence(store.state.sheet, 200);
    const auth = store.state.auth && sheet?.type !== "providers" ? html`<${AuthDialog} />` : null;

    if (!sheet) {
        return auth;
    }

    const key = isExtensionHub(sheet)
        ? "extension-hub"
        : `${sheet.type}:${sheet.entryId ?? sheet.id ?? sheet.pipId ?? ""}`;

    return html`<div class=${`sheet-host ${leaving ? "leaving" : ""}`} inert=${leaving}>
        <${SheetBack.Provider} value=${trail.length > 1 ? goBack : null}>
            <${SheetInfo.Provider} value=${{ type: sheet.type, closing: Boolean(leaving) }}>
                <${Boundary} key=${key} reset=${sheet}>${sheetBody(sheet)}<//>
            <//>
        <//>
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
            body = html`<${CwdSheet} mode=${sheet.mode} fromList=${sheet.fromList === true} />`;
            break;
        case "artifacts":
            body = html`<${ArtifactsSheet} />`;
            break;
        case "viewer":
            body = view.conversation
                ? html`<${ArtifactViewer} id=${sheet.id} version=${sheet.version} />`
                : null;
            break;
        case "artifact-share":
            body = view.conversation
                ? html`<${ArtifactShareSheet} id=${sheet.id} version=${sheet.version} />`
                : null;
            break;
        case "providers":
            body = html`<${ProvidersSheet} />`;
            break;
        case "extensions":
        case "gallery":
        case "gallery-entry":
            body = galleryAvailable()
                ? html`<${GallerySheet}
                      selected=${sheet.type === "gallery-entry" ? sheet.id : null}
                      tab=${sheet.tab ?? "discover"}
                      origin=${sheet.origin ?? (sheet.type === "gallery" ? "gallery" : "extensions")}
                      show=${sheet.show ?? null}
                      Management=${ExtensionsContent}
                  />`
                : sheet.type === "extensions"
                  ? html`<${ExtensionsSheet} />`
                  : null;
            break;
        case "gallery-source":
            body = galleryAvailable()
                ? html`<${GallerySourceSheet} key=${sheet.id} name=${sheet.id} />`
                : null;
            break;
        case "gallery-update":
            body = galleryAvailable()
                ? html`<${GalleryUpdateSheet} key=${sheet.id} name=${sheet.id} />`
                : null;
            break;
        case "gallery-share":
            body = galleryAvailable()
                ? html`<${GalleryShareSheet}
                      key=${sheet.id}
                      file=${sheet.id}
                      theme=${sheet.theme === true}
                  />`
                : null;
            break;
        // A sheet an extension's browser module added (`extension-ui.js`).
        case "ext":
            body = html`<${ExtensionSheet} sheet=${sheet} />`;
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
            body = html`<${MenuSheet} places=${!sheet.fromPlaces} />`;
            break;
        case "session":
            body = store.state.sessions.some((each) => each.id === sheet.id)
                ? html`<${SessionSheet} id=${sheet.id} at=${sheet.at ?? null} />`
                : null;
            break;
        case "places":
            body = view.conversation ? html`<${PlacesSheet} />` : null;
            break;
        case "chat":
            body = view.conversation ? html`<${ChatSheet} />` : null;
            break;

        case "rename": {
            const renamed = sheet.id
                ? store.state.sessions.find((each) => each.id === sheet.id)
                : view.conversation;

            body =
                renamed &&
                html`<${TextSheet}
                title="Rename"
                label="Session title"
                initial=${renamed.title ?? ""}
                submit=${(value) => actions.updateSession(renamed.id, { title: value })}
            />`;
            break;
        }

        case "worktree":
            body = html`<${WorktreeSheet} />`;
            break;
        case "trust":
            body = view.conversation ? html`<${TrustSheet} />` : null;
            break;
        case "pi-sessions":
            body = piSessionsAvailable() ? html`<${PiSessionsSheet} />` : null;
            break;
        case "pi-session":
            body = piSessionsAvailable()
                ? html`<${PiSessionSheet} key=${sheet.id} path=${sheet.id} />`
                : null;
            break;
        case "file":
            body = view.conversation
                ? html`<${FileSheet}
                      key=${sheet.id}
                      path=${sheet.id}
                      line=${sheet.line}
                      refresh=${sheet.n}
                  />`
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
        case "hooks":
            body = html`<${HooksSheet} />`;
            break;
        case "memory":
            body =
                sheet.conversationId !== undefined || view.conversation
                    ? html`<${MemorySheet}
                          draft=${sheet.draft ?? ""}
                          conversationId=${sheet.conversationId}
                          pendingOnly=${sheet.pendingOnly === true}
                      />`
                    : null;
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
                footer=${html`<button class="button ghost wide sheet-footer signout" onClick=${signOut}>
                    <${Icon} name="logout" size=${16} /> Sign out
                </button>`}
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
