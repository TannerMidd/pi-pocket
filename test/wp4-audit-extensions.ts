// Planner audit 1/4; positions refer to the fixed CODEMOD-WEB report.
import { type Builder } from "./wp4-audit.ts";

export function extensions(b: Builder) {
    const f = "extensions.js";

    b.add(
        f,
        "51:21",
        "translated",
        "GuardModel",
        "missing-model wording; preserve failure detail",
        ["GuardModel"],
        ["guard-model.text.not-downloaded-yet-guard"],
        ["GuardModel::model.detail"],
    );
    b.add(
        f,
        "58:13",
        "translated",
        "GuardModel",
        "loader and retry/download branches",
        ["GuardModel"],
        [
            "guard-model.label.downloading",
            "guard-model.button.try-again",
            "guard-model.button.download",
        ],
    );
    b.add(
        f,
        "62:25",
        "translated",
        "GuardModel",
        "retry/download branches",
        ["GuardModel"],
        ["guard-model.button.try-again", "guard-model.button.download"],
    );
    b.add(
        f,
        "78:17",
        "translated",
        "ApprovalRule",
        "guest approval explanation",
        ["ApprovalRule"],
        ["approval-rule.div.guest-allow-call-their"],
    );
    b.add(
        f,
        "181:11",
        "translated",
        "ModuleSettings",
        "field map, range, hint, buttons and default title; preserve author metadata",
        ["ModuleSettings"],
        [
            "module-settings.range.content",
            "module-settings.range.content.fallback.any",
            "module-settings.hint.set-type-replace",
            "module-settings.button.clear",
            "module-settings.button.default",
            "module-settings.title.put-default-back",
        ],
        [
            "ModuleSettings::field.label",
            "ModuleSettings::field.description",
            "ModuleSettings::field.placeholder",
            "ModuleSettings::choice.label",
        ],
    );
    b.add(
        f,
        "199:21",
        "translated",
        "ModuleSettings",
        "branch, author labels, range, hint and clear/default",
        ["ModuleSettings"],
        [
            "module-settings.range.content",
            "module-settings.range.content.fallback.any",
            "module-settings.hint.set-type-replace",
            "module-settings.button.clear",
            "module-settings.button.default",
        ],
        ["ModuleSettings::field.label", "ModuleSettings::choice.label"],
    );
    b.add(
        f,
        "222:47",
        "translated",
        "ModuleSettings",
        "secret hint; preserve author placeholder",
        ["ModuleSettings"],
        ["module-settings.hint.set-type-replace"],
        ["ModuleSettings::field.placeholder"],
    );
    b.add(
        f,
        "224:41",
        "translated",
        "ModuleSettings",
        "range and missing-end values",
        ["ModuleSettings"],
        ["module-settings.range.content", "module-settings.range.content.fallback.any"],
        ["ModuleSettings::field.min ?? any", "ModuleSettings::field.max ?? any"],
    );
    b.add(
        f,
        "236:27",
        "translated",
        "ModuleSettings",
        "clear/default branches",
        ["ModuleSettings"],
        ["module-settings.button.clear", "module-settings.button.default"],
    );
    b.add(
        f,
        "248:19",
        "translated",
        "ModuleSettings",
        "saving/save branches",
        ["ModuleSettings"],
        ["module-settings.button.saving", "module-settings.button.save-settings"],
    );
    b.add(
        f,
        "276:19 276:76",
        "translated",
        "WebPart",
        "parts builder and browser error; names are values",
        ["WebPart"],
        [
            "web-part.parts.routes",
            "web-part.parts.commands",
            "web-part.parts.browser-module",
            "web-part.parts.pages-anyone-link-no",
            "web-part.parts.service-other-modules",
            "web-part.parts.loading",
            "web-part.parts.off-tab",
            "web-part.div.browser-edit-reloading-page",
        ],
        [
            'WebPart::web.routes.join(", ")',
            'WebPart::web.commands.join(", ")',
            'WebPart::parts.join(" · ")',
        ],
    );
    b.add(
        f,
        "280:13",
        "translated",
        "WebPart",
        "browser failure wrapper preserves error",
        ["WebPart"],
        ["web-part.div.browser-edit-reloading-page"],
        ["WebPart::here.error"],
    );
    b.add(
        f,
        "321:9 323:13",
        "translated",
        "GalleryPart",
        "revocation and action; preserve reason",
        ["GalleryPart"],
        ["gallery-part.div.gallery-revoked-version", "gallery-part.button.turn-it-off"],
        ["GalleryPart::installed.revoked"],
    );
    b.add(
        f,
        "335:44",
        "translated",
        "GalleryPart",
        "gallery version metadata",
        ["GalleryPart"],
        ["gallery-part.span.gallery"],
        ["GalleryPart::installed.version"],
    );
    b.add(
        f,
        "336:11",
        "already-wired",
        "GalleryPart",
        "existing update status",
        ["GalleryPart"],
        ["gallery-part.span.update-available"],
    );
    b.add(
        f,
        "368:17",
        "translated",
        "PipCompactAt",
        "context compaction explanation",
        ["PipCompactAt"],
        ["pip-compact-at.div.pi-p-s-older-messages"],
    );
    b.add(
        f,
        "373:15 380:23",
        "translated",
        "PipCompactAt",
        "lazy labels and render-time call",
        ["PIP_COMPACT", "PipCompactAt"],
        [
            "pip-compact.sessions",
            "pip-compact.above-k-tokens",
            "pip-compact.above-k-tokens.above",
            "pip-compact.above-k-tokens.k",
        ],
        ["PipCompactAt::label()"],
    );
    b.add(
        f,
        "583:19",
        "already-wired",
        "row",
        "author summary and existing badges",
        ["row"],
        [
            "extensions-content.row.span.did-not-load",
            "extensions-content.row.span.gallery-revoked-version",
            "extensions-content.row.span.an-update-is-ready",
        ],
        ["row::summaryOf(module)"],
    );
    b.add(
        f,
        "590:21",
        "translated",
        "row",
        "existing always-on plus localized switch state and author title",
        ["row"],
        [
            "extensions-content.row.span.always-on",
            "extensions-content.row.label.content",
            "extensions-content.row.label.off",
        ],
        ["row::module.title"],
    );
    b.add(
        f,
        "600:15",
        "translated",
        "row",
        "guard and turn-on dialogs, nested producers",
        ["row", "guardNote", "GuardModel", "ApprovalRule", "PipCompactAt"],
        [
            "extensions-content.row.aria-label.turn-off-lancet-guard",
            "extensions-content.row.span.bash-background-write-edit",
            "extensions-content.row.button.keep-it-on",
            "extensions-content.row.button.turn-off",
            "extensions-content.row.aria-label.turn",
            "extensions-content.row.span.runs-inside-server-rights",
            "extensions-content.row.button.not-now",
            "extensions-content.row.button.turn-on",
            "guard-note.text.off-pi-s-own",
            "guard-note.text.off-pi-pocket-bash",
            "guard-note.text.checks-bash-background-write",
            "guard-model.text.not-downloaded-yet-guard",
            "approval-rule.div.guest-allow-call-their",
            "pip-compact-at.div.pi-p-s-older-messages",
        ],
        ["row::guardNote(module, data.guard)", "guardNote::guard.detail", "row::module.title"],
    );
    b.add(
        f,
        "600:74 674:74",
        "translated",
        "row",
        "guardNote fixed notes and server detail",
        ["row", "guardNote"],
        [
            "guard-note.text.off-pi-s-own",
            "guard-note.text.off-pi-pocket-bash",
            "guard-note.text.checks-bash-background-write",
        ],
        ["row::note.text", "row::guardNote(module, data.guard)", "guardNote::guard.detail"],
    );
    b.add(
        f,
        "618:33",
        "translated",
        "row",
        "guard off ARIA",
        ["row"],
        ["extensions-content.row.aria-label.turn-off-lancet-guard"],
    );
    b.add(
        f,
        "635:29",
        "translated",
        "row",
        "guard keep-on action",
        ["row"],
        ["extensions-content.row.button.keep-it-on"],
    );
    b.add(
        f,
        "691:27",
        "translated",
        "row",
        "drop-in and tool labels; preserve identifiers",
        ["row"],
        ["extensions-content.row.drop", "extensions-content.row.div.tools"],
        ["row::module.file", 'row::tools.join(", ")'],
    );
    b.add(
        f,
        "695:25",
        "already-wired",
        "row",
        "existing reload action",
        ["row"],
        ["extensions-content.row.text.reload"],
    );
    b.add(
        f,
        "719:15",
        "translated",
        "ExtensionsContent",
        "hub loading/count and existing headings/footer",
        ["ExtensionsContent"],
        [
            "extensions-content.label.loading-extensions",
            "extensions-content.span.off",
            "extensions-content.h3.extensions",
            "extensions-content.h3.built-in",
            "extensions-content.p.nothing-installed-matches",
            "extensions-content.span.make-own",
            "extensions-content.span.module-in",
            "extensions-content.span.stays-off-until-turn",
        ],
    );
    b.add(
        f,
        "739:53",
        "translated",
        "ExtensionsContent",
        "on/off counts",
        ["ExtensionsContent"],
        ["extensions-content.span.off"],
        ["ExtensionsContent::builtIn.length - on"],
    );
    b.add(
        f,
        "756:25",
        "already-wired",
        "ExtensionsContent",
        "existing footer parts",
        ["ExtensionsContent"],
        [
            "extensions-content.span.make-own",
            "extensions-content.span.module-in",
            "extensions-content.span.stays-off-until-turn",
        ],
        ["ExtensionsContent::shortPath(data.dropIns, store.state.server?.home)"],
    );
    b.add(
        f,
        "771:13",
        "translated",
        "ExtensionsContent",
        "owner-dependent intro",
        ["ExtensionsContent"],
        [
            "extensions-content.p.tools-checks-app-features",
            "extensions-content.p.owner-change-them",
        ],
    );
    b.add(
        f,
        "774:11",
        "translated",
        "ExtensionsContent",
        "standalone groups and new footer",
        ["ExtensionsContent"],
        [
            "extensions-content.label.loading-extensions",
            "extensions-content.text.built",
            "extensions-content.text.yours",
            "extensions-content.span.it-stays-off-until-turn",
        ],
    );
    b.add(
        f,
        "785:52",
        "translated",
        "ExtensionsContent",
        "group title producer",
        ["ExtensionsContent"],
        ["extensions-content.text.built", "extensions-content.text.yours"],
    );
    b.add(
        f,
        "800:21",
        "translated",
        "ExtensionsContent",
        "find action and new suffix",
        ["ExtensionsContent"],
        [
            "extensions-content.text.find-extensions",
            "extensions-content.span.it-stays-off-until-turn",
        ],
    );
    b.add(
        f,
        "119:52 241:56",
        "content-excluded",
        "ModuleSettings",
        "upstream API failure",
        ["ModuleSettings"],
        [],
        ["ModuleSettings::error"],
    );
    b.add(
        f,
        "195:54",
        "content-excluded",
        "ModuleSettings",
        "author field label",
        ["ModuleSettings"],
        [],
        ["ModuleSettings::field.label"],
    );
    b.add(
        f,
        "196:23 196:76",
        "content-excluded",
        "ModuleSettings",
        "author field description",
        ["ModuleSettings"],
        [],
        ["ModuleSettings::field.description"],
    );
    b.add(
        f,
        "213:78",
        "content-excluded",
        "ModuleSettings",
        "author choice label",
        ["ModuleSettings"],
        [],
        ["ModuleSettings::choice.label"],
    );
    b.add(
        f,
        "578:58 579:51",
        "content-excluded",
        "row",
        "author module title",
        ["row"],
        [],
        ["row::module.title"],
    );
    b.add(
        f,
        "583:71",
        "content-excluded",
        "row",
        "summary strips author name prefix without translation",
        ["summaryOf", "row"],
        [],
        ["row::summaryOf(module)", "summaryOf::module.summary"],
    );
    b.add(
        f,
        "670:81",
        "content-excluded",
        "row",
        "upstream module error",
        ["row"],
        [],
        ["row::module.error"],
    );
    b.add(
        f,
        "719:56 774:52",
        "content-excluded",
        "ExtensionsContent",
        "upstream API problem",
        ["ExtensionsContent"],
        [],
        ["ExtensionsContent::problem"],
    );
    b.add(
        f,
        "580:23 580:91",
        "identifier-excluded",
        "row",
        "module file identifier",
        ["row"],
        [],
        ["row::module.file"],
    );
    b.add(
        f,
        "723:70",
        "identifier-excluded",
        "ExtensionsContent",
        "numeric total",
        ["ExtensionsContent"],
        [],
        ["ExtensionsContent::beforeCount + yours.length"],
    );
    b.add(
        f,
        "738:72",
        "identifier-excluded",
        "ExtensionsContent",
        "numeric count",
        ["ExtensionsContent"],
        [],
        ["ExtensionsContent::builtIn.length"],
    );
    b.add(
        f,
        "758:107 809:107",
        "identifier-excluded",
        "ExtensionsContent",
        "drop-in path",
        ["ExtensionsContent"],
        [],
        ["ExtensionsContent::shortPath(data.dropIns, store.state.server?.home)"],
    );
    b.add(
        f,
        "211:35",
        "structural-reviewed",
        "ModuleSettings",
        "choice map, author label",
        ["ModuleSettings"],
        [],
        ["ModuleSettings::field.choices.map", "ModuleSettings::choice.label"],
    );
    b.add(
        f,
        "674:23",
        "structural-reviewed",
        "row",
        "note and child component calls",
        ["row", "guardNote", "ApprovalRule", "PipCompactAt"],
        [
            "guard-note.text.checks-bash-background-write",
            "approval-rule.div.guest-allow-call-their",
            "pip-compact-at.div.pi-p-s-older-messages",
        ],
        [
            "row::note.text",
            "row::guardNote(module, data.guard)",
            "row::<${ApprovalRule}",
            "row::<${PipCompactAt}",
        ],
    );
    b.add(
        f,
        "679:25",
        "structural-reviewed",
        "row",
        "settings component and module identifier",
        ["row", "ModuleSettings"],
        [],
        ["row::<${ModuleSettings}", "row::module.file"],
    );
    b.add(
        f,
        "724:23 725:72",
        "structural-reviewed",
        "ExtensionsContent",
        "yours renderer and row child",
        ["ExtensionsContent", "row"],
        [],
        ["ExtensionsContent::yours.map(row)"],
    );
    b.add(
        f,
        "742:45",
        "structural-reviewed",
        "ExtensionsContent",
        "built-in row map",
        ["ExtensionsContent", "row"],
        [],
        ["ExtensionsContent::builtIn.map(row)"],
    );
    b.add(
        f,
        "786:49",
        "structural-reviewed",
        "ExtensionsContent",
        "standalone row map",
        ["ExtensionsContent", "row"],
        [],
        ["ExtensionsContent::modules.map(row)"],
    );
}
