import { type Builder } from "./wp4-audit.ts";

export function galleryFirst(b: Builder) {
    const f = "gallery.js";
    const status = [
        "live-status.text.revoked",
        "live-status.text.not-load",
        "live-status.text.off-tab",
        "live-status.text.edited-since-install",
        "live-status.text.content",
        "live-status.text.installed",
        "live-status.text.off",
    ];
    const why = [
        "status-why.text.not-load",
        "status-why.text.browser-reloading-page-tries",
        "status-why.text.gallery-revoked-version",
    ];
    const facts = [
        "row-facts.text.hosts",
        "row-facts.text.network",
        "row-facts.text.key",
        "row-facts.text.keys",
        "row-facts.text.programs",
        "row-facts.text.sees-turns",
        "row-facts.text.changes-pi",
        "row-facts.text.tool",
        "row-facts.text.tools",
        "row-facts.text.app",
    ];
    const reach = [
        "reach-rows.from.code",
        "reach-rows.from.declared",
        "reach-rows.text.talks",
        "reach-rows.text.your-key-from-pi",
        "reach-rows.text.runs",
        "reach-rows.text.uses",
        "reach-rows.text.sees",
        "reach-rows.changes.adds-pi-s-instructions",
        "reach-rows.changes.wraps-tool",
    ];
    const groups = [
        "groups.extensions.extensions",
        "groups.tools",
        "groups.read-tools",
        "groups.hooks",
        "groups.prompt-sections",
        "groups.wraps",
        "groups.routes",
        "groups.slash-commands",
    ];
    const access = ["owner.owner", "steer.people-who-steer", "view.everyone-who-sees-every"];
    const tabs = ["tabs.discover", "tabs.installed.installed", "tabs.updates"];
    const kinds = [
        "kinds.content.kinds",
        "kinds.extensions.extensions",
        "kinds.themes.themes",
        "wants.app",
        "wants.changes-pi",
        "wants.tools-pi",
    ];

    b.add(
        f,
        "100:89",
        "structural-reviewed",
        "Out",
        "link children forwarded as VNodes",
        ["Out"],
        [],
        ["Out::${children}"],
    );
    b.add(
        f,
        "164:11",
        "structural-reviewed",
        "Tile",
        "icon or derived initial, preserve author title/name",
        ["Tile"],
        [],
        ["Tile::title ?? name", "Tile::letter"],
    );
    b.add(
        f,
        "377:60",
        "translated",
        "Status",
        "status consumer linked to liveStatus",
        ["Status", "liveStatus", "GalleryEntrySheet"],
        status,
        ["Status::status.text", 'GalleryEntrySheet::liveStatus(installed, module, "installed")'],
    );
    b.add(
        f,
        "432:17",
        "translated",
        "EntryRow",
        "install states",
        ["EntryRow"],
        ["entry-row.button.installing", "entry-row.button.install"],
    );
    b.add(
        f,
        "439:19",
        "translated",
        "EntryRow",
        "review/update states",
        ["EntryRow"],
        ["entry-row.button.review", "entry-row.button.update"],
    );
    b.add(
        f,
        "450:53 451:47",
        "content-excluded",
        "EntryRow",
        "index author title",
        ["EntryRow"],
        [],
        ["EntryRow::entry.title"],
    );
    b.add(
        f,
        "453:23",
        "content-excluded",
        "EntryRow",
        "version and index author/diagnostic",
        ["EntryRow"],
        [],
        [
            "EntryRow::installed.version",
            "EntryRow::installed.update.version",
            "EntryRow::entry.author?.name",
            "EntryRow::entry.unlisted",
        ],
    );
    b.add(
        f,
        "456:15",
        "translated",
        "EntryRow",
        "preserve author description; fact/reason producers translated",
        ["EntryRow", "statusWhy", "rowFacts", "newReach"],
        [...why, ...facts, "entry-row.span.declares-more", "entry-row.span.declares-nothing-new"],
        [
            "EntryRow::entry.description",
            "EntryRow::statusWhy(",
            "EntryRow::rowFacts(",
            "EntryRow::newReach(",
        ],
    );
    b.add(
        f,
        "456:70",
        "content-excluded",
        "EntryRow",
        "index author description",
        ["EntryRow"],
        [],
        ["EntryRow::entry.description"],
    );
    b.add(
        f,
        "459:67",
        "translated",
        "EntryRow",
        "reason producer, preserve errors",
        ["EntryRow", "statusWhy"],
        why,
        [
            "EntryRow::why.text",
            "EntryRow::statusWhy(",
            "statusWhy::module.error",
            "statusWhy::item.revoked",
        ],
    );
    b.add(
        f,
        "463:33 465:82",
        "translated",
        "EntryRow",
        "new declarations and existing empty branch",
        ["EntryRow", "newReach"],
        [
            "entry-row.span.declares-more",
            "entry-row.span.declares-nothing-new",
            "new-reach.text.sees",
        ],
        ['EntryRow::added.join("; ")', "EntryRow::newReach("],
    );
    b.add(
        f,
        "472:31 474:81",
        "translated",
        "EntryRow",
        "fact text comes from rowFacts",
        ["EntryRow", "rowFacts"],
        facts,
        ["EntryRow::facts.map", "EntryRow::rowFacts("],
    );
    b.add(
        f,
        "480:36",
        "translated",
        "EntryRow",
        "end status/install/review branches",
        ["EntryRow", "liveStatus"],
        [
            "entry-row.button.installing",
            "entry-row.button.install",
            "entry-row.button.review",
            "entry-row.button.update",
            "entry-row.text.installed",
            ...status,
        ],
        ["EntryRow::liveStatus("],
    );
    b.add(
        f,
        "536:15",
        "structural-reviewed",
        "ThemeDesk",
        "decorative VNodes only",
        ["ThemeDesk"],
        [],
        ["ThemeDesk::big"],
    );
    b.add(
        f,
        "549:21",
        "content-excluded",
        "ThemeCard",
        "author title/name",
        ["ThemeCard"],
        [],
        ["ThemeCard::entry.title ?? entry.name"],
    );
    b.add(
        f,
        "550:15 550:87",
        "translated",
        "ThemeCard",
        "state supplied by translated gallery callers",
        ["ThemeCard", "GallerySheet"],
        ["entry-row.text.installed", "web.sheets.extensions.extensions-content.text.yours"],
        ["ThemeCard::state", "GallerySheet::<${ThemeCard}"],
    );
    b.add(
        f,
        "552:40",
        "translated",
        "ThemeCard",
        "mode plus yours fallback, author name unchanged",
        ["ThemeCard", "modeWords"],
        [
            "mode-words.theme",
            "mode-words.dark-light",
            "mode-words.light",
            "mode-words.dark",
            "theme-card.text.yours",
        ],
        ["ThemeCard::entry.author", "ThemeCard::modeWords(palette)"],
    );
    b.add(
        f,
        "554:15",
        "structural-reviewed",
        "ThemeCard",
        "theme dots are decoration",
        ["ThemeCard"],
        [],
        ["ThemeCard::THEME_DOTS.map"],
    );
    b.add(
        f,
        "561:41",
        "already-wired",
        "Section",
        "all 3 GallerySheet caller headings were wired in the session-entry codemod",
        ["Section", "GallerySheet"],
        [
            "gallery-sheet.title.extensions",
            "gallery-sheet.title.themes",
            "gallery-sheet.title.updates",
        ],
        ["Section::${title}", "GallerySheet::<${Section}"],
    );
    b.add(
        f,
        "561:56",
        "identifier-excluded",
        "Section",
        "numeric count",
        ["Section"],
        [],
        ["Section::${count}"],
    );
    b.add(
        f,
        "562:11",
        "structural-reviewed",
        "Section",
        "children VNode forwarding",
        ["Section"],
        [],
        ["Section::${children}"],
    );
    b.add(
        f,
        "603:53",
        "identifier-excluded",
        "IndexAddress",
        "index URL",
        ["IndexAddress"],
        [],
        ["IndexAddress::address"],
    );
    b.add(
        f,
        "625:13",
        "translated",
        "IndexAddress",
        "index label",
        ["IndexAddress"],
        ["index-address.label.index-git-hub-repository-owner"],
    );
    b.add(
        f,
        "636:11",
        "structural-reviewed",
        "IndexAddress",
        "conditional API problem",
        ["IndexAddress"],
        [],
        ["IndexAddress::problem"],
    );
    b.add(
        f,
        "636:58",
        "content-excluded",
        "IndexAddress",
        "upstream API problem",
        ["IndexAddress"],
        [],
        ["IndexAddress::problem"],
    );
    b.add(
        f,
        "639:17 642:21",
        "translated",
        "IndexAddress",
        "default URL kept in placeholder",
        ["IndexAddress"],
        ["index-address.button.default"],
        ["IndexAddress::fallback"],
    );
    b.add(
        f,
        "768:11",
        "translated",
        "GallerySheet",
        "chip labels from filter producers",
        ["GallerySheet", "kindLabel", "wantLabel"],
        kinds,
        ["GallerySheet::kindLabel(value)", "GallerySheet::wantLabel(value)"],
    );
    b.add(
        f,
        "792:11 800:19",
        "translated",
        "GallerySheet",
        "tabs and update badge",
        ["GallerySheet", "tabLabel"],
        [...tabs, "gallery-sheet.aria-label.available"],
        ["GallerySheet::tabLabel(value)", "GallerySheet::updates"],
    );
    b.add(
        f,
        "804:89",
        "identifier-excluded",
        "GallerySheet",
        "numeric update count",
        ["GallerySheet"],
        [],
        ["GallerySheet::updates"],
    );
    b.add(
        f,
        "818:19",
        "translated",
        "GallerySheet",
        "own theme Yours and other Installed state",
        ["GallerySheet"],
        ["web.sheets.extensions.extensions-content.text.yours", "entry-row.text.installed"],
        ["GallerySheet::<${ThemeCard}"],
    );
    b.add(
        f,
        "848:37",
        "translated",
        "GallerySheet",
        "search placeholders all branches",
        ["GallerySheet"],
        [
            "gallery-sheet.placeholder.search-installed",
            "gallery-sheet.placeholder.search-updates",
            "gallery-sheet.placeholder.search-counted",
            "gallery-sheet.aria-label.search-extensions-and-themes",
        ],
    );
    b.add(
        f,
        "857:45",
        "translated",
        "GallerySheet",
        "search ARIA",
        ["GallerySheet"],
        ["gallery-sheet.aria-label.search-extensions-and-themes"],
    );
    b.add(
        f,
        "863:29 867:40",
        "translated",
        "GallerySheet",
        "refresh button and title",
        ["GallerySheet"],
        ["gallery-sheet.aria-label.refresh", "gallery-sheet.title.read-the-index-again"],
    );
    b.add(
        f,
        "876:25 879:31 885:31",
        "translated",
        "GallerySheet",
        "filter keys and lazy producers",
        ["GallerySheet", "kindLabel", "wantLabel"],
        ["gallery-sheet.aria-label.filters", ...kinds],
        ["GallerySheet::kindLabel(value)", "GallerySheet::wantLabel(value)"],
    );
    b.add(
        f,
        "893:19",
        "translated",
        "GallerySheet",
        "loader and section headings; preserve API errors",
        ["GallerySheet"],
        [
            "gallery-sheet.label.reading-the-index",
            "gallery-sheet.title.extensions",
            "gallery-sheet.title.themes",
            "gallery-sheet.title.updates",
        ],
        ["GallerySheet::problem", "GallerySheet::data.error"],
    );
    b.add(
        f,
        "893:66 894:70",
        "content-excluded",
        "GallerySheet",
        "upstream API failure",
        ["GallerySheet"],
        [],
        ["GallerySheet::problem", "GallerySheet::data.error"],
    );
    b.add(
        f,
        "900:49 914:49 941:94",
        "structural-reviewed",
        "GallerySheet",
        "extension rows and translated producers",
        ["GallerySheet", "EntryRow"],
        ["entry-row.button.install", "entry-row.span.declares-more"],
        ["GallerySheet::extensionMatches.map(row)"],
    );
    b.add(
        f,
        "907:51",
        "structural-reviewed",
        "GallerySheet",
        "theme cards and translated producer",
        ["GallerySheet", "ThemeCard"],
        ["theme-card.text.yours"],
        ["GallerySheet::themeMatches.map(card)"],
    );
    b.add(
        f,
        "923:29",
        "translated",
        "GallerySheet",
        "all empty-state branches",
        ["GallerySheet"],
        [
            "gallery-sheet.span.everything-up-date",
            "gallery-sheet.text.nothing-matches-try-other",
            "gallery-sheet.text.index-nothing-pi-pocket",
        ],
    );
    b.add(
        f,
        "925:45",
        "translated",
        "GallerySheet",
        "up-to-date state",
        ["GallerySheet"],
        ["gallery-sheet.span.everything-up-date"],
    );
    b.add(
        f,
        "953:31",
        "translated",
        "GallerySheet",
        "read/not-read time",
        ["GallerySheet"],
        ["gallery-sheet.p.read", "gallery-sheet.p.not-read-yet"],
        ["GallerySheet::timeAgo(data.fetchedAt)"],
    );
    b.add(
        f,
        "956:29 958:35",
        "translated",
        "GallerySheet",
        "singular/plural incompatible count; retain diagnostics",
        ["GallerySheet"],
        ["gallery-sheet.p.one-entry-needs-newer", "gallery-sheet.p.entries-need-newer"],
        ["GallerySheet::hidden.incompatible", "GallerySheet::hidden.invalid"],
    );
    b.add(
        f,
        "964:35 966:43",
        "content-excluded",
        "GallerySheet",
        "index parser name/problem payload",
        ["GallerySheet"],
        [],
        ["GallerySheet::each.name", "GallerySheet::each.problem"],
    );
    b.add(
        f,
        "982:21",
        "translated",
        "GallerySheet",
        "back and empty state; entry child renderer",
        ["GallerySheet", "tabLabel", "GalleryEntrySheet"],
        ["gallery-sheet.text.back", "gallery-sheet.div.choose-one-see", ...tabs],
        ["GallerySheet::tabLabel(tab)", "GallerySheet::<${GalleryEntrySheet}"],
    );
    b.add(
        f,
        "984:31 986:70",
        "translated",
        "GallerySheet",
        "back target tab",
        ["GallerySheet", "tabLabel"],
        ["gallery-sheet.text.back", ...tabs],
        ["GallerySheet::tabLabel(tab)"],
    );
    b.add(
        f,
        "1008:11 1010:23",
        "translated",
        "Declares",
        "lazy group labels and declared names",
        ["Declares", "GROUPS", "declared"],
        [...groups, "declared.owner", "declared.who-steer", "declares.dd.nothing"],
        ["Declares::label()", "Declares::declared(declares, key)"],
    );
    b.add(
        f,
        "1012:21",
        "translated",
        "Declares",
        "nothing or declarations",
        ["Declares", "declared"],
        ["declares.dd.nothing", "declared.owner", "declared.who-steer"],
        ["Declares::declared(declares, key)"],
    );
    b.add(
        f,
        "1013:51",
        "translated",
        "Declares",
        "command scope translation preserves names",
        ["Declares", "declared"],
        ["declared.owner", "declared.who-steer"],
        ["Declares::declared(declares, key)", "declared::name"],
    );
    b.add(
        f,
        "1021:17 1023:32",
        "translated",
        "Declares",
        "access or nothing",
        ["Declares", "accessWords"],
        ["declares.dd.nothing", "declares.dd.for-access", ...access],
        ["Declares::accessWords(declares.client)"],
    );
    b.add(
        f,
        "1028:19",
        "translated",
        "Declares",
        "access enum and unknown fallback",
        ["Declares", "accessWords"],
        access,
        ["Declares::accessWords(declares.access)", "accessWords::return access"],
    );
    b.add(
        f,
        "1078:53 1085:17",
        "structural-reviewed",
        "EntryFrame",
        "children forwarded",
        ["EntryFrame"],
        [],
        ["EntryFrame::${children}"],
    );
    b.add(
        f,
        "1080:23",
        "structural-reviewed",
        "EntryFrame",
        "title forwarded from translated loading or author title",
        ["EntryFrame", "GalleryEntrySheet", "ThemeEntry"],
        ["gallery-entry-sheet.title.extension"],
        ["EntryFrame::title=${title}", "GalleryEntrySheet::entry.title", "ThemeEntry::entry.title"],
    );
    b.add(
        f,
        "1093:28",
        "translated",
        "UpdateCallout",
        "version update notice",
        ["UpdateCallout"],
        ["update-callout.span.version-ready-see-changes"],
        ["UpdateCallout::installed.update.version"],
    );
    b.add(
        f,
        "1107:72",
        "identifier-excluded",
        "Changed",
        "installed changed paths",
        ["Changed"],
        [],
        ["Changed::installed.changed.join"],
    );
    b.add(
        f,
        "1113:82",
        "translated",
        "Remove",
        "caller supplies translated labels",
        ["Remove", "GalleryEntrySheet", "ThemeEntry"],
        ["gallery-entry-sheet.label.uninstall", "theme-entry.label.remove"],
        ["Remove::${label}"],
    );
    b.add(
        f,
        "1114:37",
        "translated",
        "Remove",
        "caller supplies translated descriptions",
        ["Remove", "GalleryEntrySheet", "ThemeEntry"],
        [
            "gallery-entry-sheet.text.turns-off-deletes",
            "gallery-entry-sheet.text.deletes-files",
            "theme-entry.text.moves-it-themes-removed",
        ],
        ["Remove::${text}"],
    );
    b.add(
        f,
        "1123:15",
        "structural-reviewed",
        "Files",
        "file rows retain identifiers",
        ["Files"],
        [],
        ["Files::files.map", "Files::file.name"],
    );
    b.add(
        f,
        "1125:42 1126:49",
        "identifier-excluded",
        "Files",
        "file path and formatted size",
        ["Files"],
        [],
        ["Files::file.name", "Files::formatBytes(file.size)"],
    );
    b.add(
        f,
        "1140:13",
        "already-wired",
        "EntryFacts",
        "existing Author label and author data",
        ["EntryFacts"],
        ["entry-facts.dt.author"],
        ["EntryFacts::entry.author.name"],
    );
    b.add(
        f,
        "1144:23 1147:93",
        "content-excluded",
        "EntryFacts",
        "author name and GitHub metadata",
        ["EntryFacts"],
        [],
        ["EntryFacts::entry.author.name", "EntryFacts::entry.author.github"],
    );
    b.add(
        f,
        "1155:19 1155:74",
        "translated",
        "EntryFacts",
        "available version, initial version preserved",
        ["EntryFacts"],
        ["entry-facts.span.available"],
        ["EntryFacts::installed.update.version", "EntryFacts::${version}"],
    );
    b.add(
        f,
        "1161:75",
        "identifier-excluded",
        "EntryFacts",
        "repository and commit",
        ["EntryFacts"],
        [],
        ["EntryFacts::short(commit)", "EntryFacts::${repo}"],
    );
    b.add(
        f,
        "1165:13 1168:23",
        "translated",
        "EntryFacts",
        "both API requirement callers and existing headings",
        ["EntryFacts", "GalleryEntrySheet", "ThemeEntry"],
        [
            "entry-facts.dt.needs",
            "entry-facts.dt.installed",
            "entry-facts.text.needs-extension-api",
            "entry-facts.text.needs-theme-api",
        ],
        [
            "EntryFacts::${needs}",
            "GalleryEntrySheet::entry.minPocket",
            "GalleryEntrySheet::entry.pocketApi",
            "ThemeEntry::entry.minPocket",
            "ThemeEntry::entry.themeApi",
        ],
    );
    b.add(
        f,
        "1176:23",
        "content-excluded",
        "EntryFacts",
        "time helper and upstream unlisted diagnostic",
        ["EntryFacts"],
        [],
        ["EntryFacts::timeAgo(installed.installedAt)", "EntryFacts::installed.unlisted"],
    );
    b.add(
        f,
        "1192:13 1194:17",
        "translated",
        "ReachSection",
        "edited files warning",
        ["ReachSection"],
        ["reach-section.p.files-edited-since-installed"],
    );
    b.add(
        f,
        "1199:15 1202:52 1203:52",
        "translated",
        "ReachSection",
        "translated scan and hook producers",
        ["ReachSection", "reachRows", "hookWords", "HOOK_WORDS", "sentence"],
        [
            ...reach,
            "sentence.text.and",
            "before-tool.tool-calls-before-they",
            "after-tool.tool-results",
            "before-request.goes-model",
            "after-response.model-s-replies",
            "on-yield.end-turn",
        ],
        ["ReachSection::reachRows(", "ReachSection::row.text", "ReachSection::row.from"],
    );
    b.add(
        f,
        "1208:48",
        "translated",
        "ReachSection",
        "fixed extension risk",
        ["ReachSection"],
        ["risk.runs-inside-server-rights"],
    );
    b.add(
        f,
        "1213:13 1215:17",
        "translated",
        "ReachSection",
        "missing scan and localized names",
        ["ReachSection", "missingWords", "sentence"],
        [
            "reach-section.p.scan-found-nothing-reads",
            "reach-section.missing.network",
            "reach-section.missing.keys",
            "reach-section.missing.programs",
            "reach-section.missing.files",
            "sentence.text.and",
        ],
        ["ReachSection::missing.map(missingWords)"],
    );
    b.add(
        f,
        "1222:19",
        "translated",
        "ReachSection",
        "fixed not-read fallback, raw failure",
        ["ReachSection"],
        ["reach-section.text.code-not-read-yet"],
        ["ReachSection::problem"],
    );
    b.add(
        f,
        "1251:13",
        "translated",
        "AddsSection",
        "tools, command scopes and app prose",
        ["AddsSection", "accessWords"],
        [
            "adds-section.span.reads",
            "adds-section.commands.owner",
            "adds-section.commands.who-steer",
            "adds-section.text.app",
            ...access,
        ],
    );
    b.add(
        f,
        "1253:19",
        "already-wired",
        "AddsSection",
        "existing reads-only label and tool identifier",
        ["AddsSection"],
        ["adds-section.span.reads"],
        ["AddsSection::readOnly.includes(tool)"],
    );
    b.add(
        f,
        "1263:19",
        "translated",
        "AddsSection",
        "command scopes, command identifier untouched",
        ["AddsSection"],
        ["adds-section.commands.owner", "adds-section.commands.who-steer"],
        ["AddsSection::commands.map"],
    );
    b.add(
        f,
        "1328:41",
        "translated",
        "TurnOnDialog",
        "turn-on titles preserve author title",
        ["TurnOnDialog"],
        ["turn-on-dialog.h3.turn-title", "turn-on-dialog.h3.install-turn-title"],
        ["TurnOnDialog::title"],
    );
    b.add(
        f,
        "1329:18",
        "translated",
        "TurnOnDialog",
        "fixed extension risk",
        ["TurnOnDialog"],
        ["risk.runs-inside-server-rights"],
    );
}
