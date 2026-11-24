import { type Builder } from "./wp4-audit.ts";

export function galleryLast(b: Builder) {
    const f = "gallery.js";
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
    const roles = [
        "swatches.text.background",
        "swatches.text.foreground",
        "swatches.text.accent",
        "swatches.text.red",
        "swatches.text.yellow",
        "swatches.text.green",
        "swatches.text.cyan",
        "swatches.text.blue",
        "swatches.text.magenta",
    ];
    const changes = [
        "gallery-update-sheet.span.change-added",
        "gallery-update-sheet.span.change-removed",
        "gallery-update-sheet.span.change-changed",
        "gallery-update-sheet.span.change-same",
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

    b.add(
        f,
        "1331:17",
        "translated",
        "TurnOnDialog",
        "warning branches and reach rows",
        ["TurnOnDialog", "reachRows"],
        [
            "turn-on-dialog.p.files-edited-since-installed",
            "turn-on-dialog.p.scan-reads-text-code",
            "turn-on-dialog.p.scan-code-found-no",
            "turn-on-dialog.p.code-not-read-yet",
            ...reach,
        ],
        ["TurnOnDialog::rows.map"],
    );
    b.add(
        f,
        "1333:21",
        "translated",
        "TurnOnDialog",
        "edited warning",
        ["TurnOnDialog"],
        ["turn-on-dialog.p.files-edited-since-installed"],
    );
    b.add(
        f,
        "1340:29 1343:66",
        "translated",
        "TurnOnDialog",
        "row text from reachRows",
        ["TurnOnDialog", "reachRows"],
        reach,
        ["TurnOnDialog::rows.map", "TurnOnDialog::row.text", "TurnOnDialog::reachRows("],
    );
    b.add(
        f,
        "1352:29",
        "translated",
        "TurnOnDialog",
        "empty scan warning",
        ["TurnOnDialog"],
        ["turn-on-dialog.p.scan-code-found-no"],
    );
    b.add(
        f,
        "1360:21",
        "already-wired",
        "TurnOnDialog",
        "existing install-off action",
        ["TurnOnDialog"],
        ["turn-on-dialog.button.install-turned-off"],
    );
    b.add(
        f,
        "1366:23",
        "translated",
        "TurnOnDialog",
        "turn/install branches",
        ["TurnOnDialog"],
        ["turn-on-dialog.button.turn", "turn-on-dialog.button.install-turn"],
    );
    b.add(
        f,
        "1383:39 1385:36",
        "content-excluded",
        "EntryHead",
        "author title passed to Tile and shown",
        ["EntryHead"],
        [],
        ["EntryHead::title"],
    );
    b.add(
        f,
        "1386:42",
        "translated",
        "EntryHead",
        "metadata generated labels and raw version",
        ["EntryHead"],
        [
            "entry-head.meta.not-index",
            "entry-head.meta.one-file",
            "entry-head.meta.files",
            "entry-head.meta.theme",
        ],
        ["EntryHead::meta.join", "EntryHead::version"],
    );
    b.add(
        f,
        "1427:15",
        "translated",
        "GalleryEntrySheet",
        "loader and missing-entry notice, raw error",
        ["GalleryEntrySheet"],
        [
            "gallery-entry-sheet.label.reading-the-index",
            "gallery-entry-sheet.p.index-not-list-installed",
        ],
        ["GalleryEntrySheet::problem"],
    );
    b.add(
        f,
        "1427:62 1504:58",
        "content-excluded",
        "GalleryEntrySheet",
        "API failure",
        ["GalleryEntrySheet"],
        [],
        ["GalleryEntrySheet::problem"],
    );
    b.add(
        f,
        "1431:45",
        "translated",
        "GalleryEntrySheet",
        "missing entry with name",
        ["GalleryEntrySheet"],
        ["gallery-entry-sheet.p.index-not-list-installed"],
        ["GalleryEntrySheet::name"],
    );
    b.add(
        f,
        "1484:17",
        "translated",
        "GalleryEntrySheet",
        "uninstall confirmation both states and title",
        ["GalleryEntrySheet"],
        [
            "gallery-entry-sheet.uninstall.confirm.remove-files-deleted-extensions",
            "gallery-entry-sheet.uninstall.confirm.turned-off-first",
            "gallery-entry-sheet.uninstall.confirm.content",
        ],
        ["GalleryEntrySheet::installed.enabled", "GalleryEntrySheet::title"],
    );
    b.add(
        f,
        "1503:40 1520:44 1615:25",
        "content-excluded",
        "GalleryEntrySheet",
        "author title forwarded unchanged",
        ["GalleryEntrySheet"],
        [],
        ["GalleryEntrySheet::entry.title", "GalleryEntrySheet::title=${title}"],
    );
    b.add(
        f,
        "1504:11 1509:68",
        "translated",
        "GalleryEntrySheet",
        "revocation reason and turn-off button, raw error",
        ["GalleryEntrySheet"],
        [
            "gallery-entry-sheet.strong.gallery-revoked-version",
            "gallery-entry-sheet.strong.reason",
            "gallery-entry-sheet.button.turn-it-off",
        ],
        ["GalleryEntrySheet::revoked", "GalleryEntrySheet::problem"],
    );
    b.add(
        f,
        "1521:11",
        "structural-reviewed",
        "GalleryEntrySheet",
        "author description conditional",
        ["GalleryEntrySheet"],
        [],
        ["GalleryEntrySheet::entry.description"],
    );
    b.add(
        f,
        "1521:71",
        "content-excluded",
        "GalleryEntrySheet",
        "author description",
        ["GalleryEntrySheet"],
        [],
        ["GalleryEntrySheet::entry.description"],
    );
    b.add(
        f,
        "1524:13 1528:23",
        "translated",
        "GalleryEntrySheet",
        "standing branches and liveStatus",
        ["GalleryEntrySheet", "liveStatus"],
        [
            "gallery-entry-sheet.span.runs-every-session",
            "gallery-entry-sheet.span.installed-turned-off-nothing",
            ...status,
        ],
        [
            'GalleryEntrySheet::liveStatus(installed, module, "installed")',
            "GalleryEntrySheet::installed.revoked",
        ],
    );
    b.add(
        f,
        "1532:67",
        "translated",
        "GalleryEntrySheet",
        "why text from statusWhy",
        ["GalleryEntrySheet", "statusWhy"],
        why,
        ["GalleryEntrySheet::statusWhy(", "GalleryEntrySheet::why.text"],
    );
    b.add(
        f,
        "1535:17",
        "translated",
        "GalleryEntrySheet",
        "install/off/on/reload and source actions",
        ["GalleryEntrySheet"],
        [
            "gallery-entry-sheet.button.install-turn",
            "turn-on-dialog.button.install-turned-off",
            "gallery-entry-sheet.button.turn-off",
            "gallery-entry-sheet.button.turn-on",
            "gallery-entry-sheet.text.reload",
            "gallery-entry-sheet.button.view-source",
            "gallery-entry-sheet.text.ask-pi-to-review",
        ],
    );
    b.add(
        f,
        "1548:31",
        "translated",
        "GalleryEntrySheet",
        "this action was raw in session-entry GalleryEntrySheet; the same key was wired only in TurnOnDialog",
        ["GalleryEntrySheet"],
        ["turn-on-dialog.button.install-turned-off"],
    );
    b.add(
        f,
        "1550:29",
        "already-wired",
        "GalleryEntrySheet",
        "existing source action and its consumer",
        ["GalleryEntrySheet"],
        ["gallery-entry-sheet.button.view-source"],
        ["GalleryEntrySheet::\u0024{source}"],
    );
    b.add(
        f,
        "1568:31",
        "already-wired",
        "GalleryEntrySheet",
        "existing source and review actions",
        ["GalleryEntrySheet"],
        ["gallery-entry-sheet.button.view-source", "gallery-entry-sheet.text.ask-pi-to-review"],
        ["GalleryEntrySheet::\u0024{source}", "GalleryEntrySheet::\u0024{askPi}"],
    );
    b.add(
        f,
        "1570:29",
        "already-wired",
        "GalleryEntrySheet",
        "existing turn-on action and source/review children",
        ["GalleryEntrySheet"],
        [
            "gallery-entry-sheet.button.view-source",
            "gallery-entry-sheet.text.ask-pi-to-review",
            "gallery-entry-sheet.button.turn-on",
        ],
        [
            "GalleryEntrySheet::\u0024{source}",
            "GalleryEntrySheet::\u0024{askPi}",
            "GalleryEntrySheet::installed.revoked",
        ],
    );
    b.add(
        f,
        "1587:13 1588:40",
        "structural-reviewed",
        "GalleryEntrySheet",
        "author tag list",
        ["GalleryEntrySheet"],
        [],
        ["GalleryEntrySheet::entry.tags.map"],
    );
    b.add(
        f,
        "1588:86",
        "identifier-excluded",
        "GalleryEntrySheet",
        "author tag identifier",
        ["GalleryEntrySheet"],
        [],
        ["GalleryEntrySheet::entry.tags.map"],
    );
    b.add(
        f,
        "1604:13",
        "translated",
        "GalleryEntrySheet",
        "remove description and dialog props",
        ["GalleryEntrySheet", "TurnOnDialog"],
        [
            "gallery-entry-sheet.label.uninstall",
            "gallery-entry-sheet.text.turns-off-deletes",
            "gallery-entry-sheet.text.deletes-files",
            "turn-on-dialog.h3.turn-title",
            "turn-on-dialog.h3.install-turn-title",
        ],
        ["GalleryEntrySheet::<${Remove}", "GalleryEntrySheet::<${TurnOnDialog}"],
    );
    b.add(
        f,
        "1662:11",
        "translated",
        "Swatches",
        "palette tooltip role producer and unchanged colors",
        ["Swatches", "roleLabel"],
        roles,
        ["Swatches::roleLabel(key)", "Swatches::colors[key]"],
    );
    b.add(
        f,
        "1669:15",
        "translated",
        "Swatches",
        "foreground text and role producer",
        ["Swatches", "roleLabel", "textLabel"],
        ["swatches.text.background", "swatches.text.text", "swatches.text.accent"],
        ["Swatches::textLabel(key)", "textLabel::roleLabel(key)", "Swatches::colors[key]"],
    );
    b.add(
        f,
        "1695:17",
        "translated",
        "ThemeEntry",
        "theme removal warning with title",
        ["ThemeEntry"],
        ["theme-entry.uninstall.confirm.remove-theme-folder-moves"],
        ["ThemeEntry::title"],
    );
    b.add(
        f,
        "1708:40 1718:21",
        "content-excluded",
        "ThemeEntry",
        "author title",
        ["ThemeEntry"],
        [],
        ["ThemeEntry::entry.title"],
    );
    b.add(
        f,
        "1709:11 1713:68",
        "translated",
        "ThemeEntry",
        "revocation reason preserves server payload",
        ["ThemeEntry"],
        ["theme-entry.strong.gallery-revoked-version", "theme-entry.strong.reason"],
        ["ThemeEntry::offeredRevoked", "ThemeEntry::problem"],
    );
    b.add(
        f,
        "1709:58",
        "content-excluded",
        "ThemeEntry",
        "upstream API error",
        ["ThemeEntry"],
        [],
        ["ThemeEntry::problem"],
    );
    b.add(
        f,
        "1727:31",
        "translated",
        "ThemeEntry",
        "palette captions all branches",
        ["ThemeEntry"],
        [
            "theme-entry.figcaption.dark",
            "theme-entry.figcaption.light",
            "theme-entry.figcaption.colors-show-once-gallery",
        ],
    );
    b.add(
        f,
        "1730:17",
        "already-wired",
        "ThemeEntry",
        "existing light caption and decoration",
        ["ThemeEntry", "ThemeDesk"],
        ["theme-entry.figcaption.light"],
        ["ThemeEntry::<${ThemeDesk}"],
    );
    b.add(
        f,
        "1737:11",
        "structural-reviewed",
        "ThemeEntry",
        "author description conditional",
        ["ThemeEntry"],
        [],
        ["ThemeEntry::entry.description"],
    );
    b.add(
        f,
        "1737:71",
        "content-excluded",
        "ThemeEntry",
        "author description",
        ["ThemeEntry"],
        [],
        ["ThemeEntry::entry.description"],
    );
    b.add(
        f,
        "1741:17",
        "translated",
        "ThemeEntry",
        "install/use/appearance actions",
        ["ThemeEntry"],
        [
            "theme-entry.button.install",
            "theme-entry.button.browser",
            "theme-entry.button.browser.browser",
            "theme-entry.button.open-appearance",
        ],
    );
    b.add(
        f,
        "1754:33",
        "translated",
        "ThemeEntry",
        "use in this browser both branches",
        ["ThemeEntry"],
        ["theme-entry.button.browser", "theme-entry.button.browser.browser"],
    );
    b.add(
        f,
        "1769:15",
        "translated",
        "ThemeEntry",
        "installed/install explanation",
        ["ThemeEntry"],
        [
            "theme-entry.p.person-picks-theme-their",
            "theme-entry.p.installing-adds-appearance-nothing",
        ],
    );
    b.add(
        f,
        "1772:13 1773:50",
        "translated",
        "ThemeEntry",
        "appearance failure with raw problem",
        ["ThemeEntry"],
        ["theme-entry.div.appearance-not-offer"],
        ["ThemeEntry::installed.problem"],
    );
    b.add(
        f,
        "1779:19 1782:56",
        "translated",
        "ThemeEntry",
        "themeChanges producer with generated count and names",
        ["ThemeEntry", "themeChanges", "modeWords", "sentence"],
        [
            "theme-entry.span.files",
            "theme-changes.text.colors",
            "theme-changes.text.own-colors",
            "theme-changes.text.layout-own-moves-restyles",
            "theme-changes.text.own",
            "theme-changes.text.font",
            "theme-changes.text.fonts",
            "theme-changes.text.one-image",
            "theme-changes.text.images",
            "mode-words.theme",
            "mode-words.dark-light",
            "mode-words.light",
            "mode-words.dark",
            "sentence.text.and",
        ],
        ["ThemeEntry::themeChanges(", "themeChanges::sentence(fonts)"],
    );
    b.add(
        f,
        "1788:52",
        "translated",
        "ThemeEntry",
        "theme trust risk",
        ["ThemeEntry"],
        ["theme-risk.theme-css-fonts-images"],
    );
    b.add(
        f,
        "1794:13",
        "translated",
        "ThemeEntry",
        "palette title and Swatches labels",
        ["ThemeEntry", "Swatches", "roleLabel", "textLabel"],
        ["theme-entry.h4.palette", ...roles, "swatches.text.text"],
        ["ThemeEntry::<${Swatches}", "Swatches::roleLabel(key)", "Swatches::textLabel(key)"],
    );
    b.add(
        f,
        "1798:19",
        "structural-reviewed",
        "ThemeEntry",
        "light palette invokes same Swatches producers",
        ["ThemeEntry", "Swatches", "roleLabel", "textLabel"],
        [...roles, "swatches.text.text"],
        ["ThemeEntry::palette.colorsLight", "ThemeEntry::<${Swatches}", "Swatches::textLabel(key)"],
    );
    b.add(
        f,
        "1803:40",
        "structural-reviewed",
        "ThemeEntry",
        "author tag map",
        ["ThemeEntry"],
        [],
        ["ThemeEntry::entry.tags.map"],
    );
    b.add(
        f,
        "1803:86",
        "identifier-excluded",
        "ThemeEntry",
        "author tag identifier",
        ["ThemeEntry"],
        [],
        ["ThemeEntry::entry.tags.map"],
    );
    b.add(
        f,
        "1815:13",
        "translated",
        "ThemeEntry",
        "theme remove action",
        ["ThemeEntry"],
        ["theme-entry.label.remove", "theme-entry.text.moves-it-themes-removed"],
    );
    b.add(
        f,
        "1834:17",
        "translated",
        "GallerySourceSheet",
        "source title both branches",
        ["GallerySourceSheet"],
        ["gallery-source-sheet.title.source", "gallery-source-sheet.title.source.source"],
        ["GallerySourceSheet::data.title"],
    );
    b.add(
        f,
        "1839:11",
        "translated",
        "GallerySourceSheet",
        "loader and source notes with raw error",
        ["GallerySourceSheet"],
        [
            "gallery-source-sheet.label.getting-its-files",
            "gallery-source-sheet.p.files-they-extensions-folder",
            "gallery-source-sheet.p.downloaded-commit-index-pins",
        ],
        ["GallerySourceSheet::problem"],
    );
    b.add(
        f,
        "1839:58",
        "content-excluded",
        "GallerySourceSheet",
        "API failure",
        ["GallerySourceSheet"],
        [],
        ["GallerySourceSheet::problem"],
    );
    b.add(
        f,
        "1844:19",
        "translated",
        "GallerySourceSheet",
        "source notes both branches",
        ["GallerySourceSheet"],
        [
            "gallery-source-sheet.p.files-they-extensions-folder",
            "gallery-source-sheet.p.downloaded-commit-index-pins",
        ],
    );
    b.add(
        f,
        "1850:62",
        "identifier-excluded",
        "GallerySourceSheet",
        "file path",
        ["GallerySourceSheet"],
        [],
        ["GallerySourceSheet::file.name"],
    );
    b.add(
        f,
        "1851:49",
        "identifier-excluded",
        "GallerySourceSheet",
        "formatted size",
        ["GallerySourceSheet"],
        [],
        ["GallerySourceSheet::formatBytes(file.size)"],
    );
    b.add(
        f,
        "1853:25",
        "translated",
        "GallerySourceSheet",
        "missing/pinned/changed labels and titles",
        ["GallerySourceSheet"],
        [
            "gallery-source-sheet.span.missing",
            "gallery-source-sheet.span.pinned",
            "gallery-source-sheet.span.changed",
            "gallery-source-sheet.title.matches-hash-index-pins",
            "gallery-source-sheet.title.not-file-index-pins",
        ],
    );
    b.add(
        f,
        "1861:19",
        "structural-reviewed",
        "GallerySourceSheet",
        "raw code into highlighting component",
        ["GallerySourceSheet"],
        [],
        [
            "GallerySourceSheet::file.text",
            "GallerySourceSheet::file.name",
            "GallerySourceSheet::<${Highlighted}",
        ],
    );
    b.add(
        f,
        "1931:17",
        "translated",
        "GalleryUpdateSheet",
        "apply warning preserves author title",
        ["GalleryUpdateSheet"],
        ["gallery-update-sheet.apply.confirm.apply-update-new-code"],
        ["GalleryUpdateSheet::data.title"],
    );
    b.add(
        f,
        "1983:17",
        "translated",
        "GalleryUpdateSheet",
        "loading label and raw error",
        ["GalleryUpdateSheet"],
        ["gallery-update-sheet.label.getting-the-new-version"],
        ["GalleryUpdateSheet::problem"],
    );
    b.add(
        f,
        "1984:59",
        "content-excluded",
        "GalleryUpdateSheet",
        "upstream API error",
        ["GalleryUpdateSheet"],
        [],
        ["GalleryUpdateSheet::problem"],
    );
    b.add(
        f,
        "2002:36 2007:23 2007:75",
        "identifier-excluded",
        "GalleryUpdateSheet",
        "versions and commit ids",
        ["GalleryUpdateSheet"],
        [],
        [
            "GalleryUpdateSheet::data.from.version",
            "GalleryUpdateSheet::data.to.version",
            "GalleryUpdateSheet::short(data.from.commit)",
            "GalleryUpdateSheet::short(data.to.commit)",
        ],
    );
    b.add(
        f,
        "2012:13",
        "translated",
        "GalleryUpdateSheet",
        "repository and replacement warnings with declaration changes",
        ["GalleryUpdateSheet", "declarationChanges"],
        [
            "gallery-update-sheet.div.comes-another-repository",
            "gallery-update-sheet.text.make-sure-trust-new",
            "gallery-update-sheet.div.yours-edited-since-installed",
            "gallery-update-sheet.text.diff-against-your-files",
            "gallery-update-sheet.p.checked-every-theme-before",
            "declaration-changes.label.browser-module",
            "declaration-changes.label.widest-access",
        ],
        ["GalleryUpdateSheet::declarationChanges("],
    );
    b.add(
        f,
        "2014:76 2014:122",
        "identifier-excluded",
        "GalleryUpdateSheet",
        "repository identifiers",
        ["GalleryUpdateSheet"],
        [],
        ["GalleryUpdateSheet::data.from.repo", "GalleryUpdateSheet::data.to.repo"],
    );
    b.add(
        f,
        "2020:101",
        "identifier-excluded",
        "GalleryUpdateSheet",
        "edited paths",
        ["GalleryUpdateSheet"],
        [],
        ["GalleryUpdateSheet::data.edited.join"],
    );
    b.add(
        f,
        "2031:27 2034:39 2036:51",
        "translated",
        "GalleryUpdateSheet",
        "same fallback and declaration labels",
        ["GalleryUpdateSheet", "declarationChanges", "GROUPS"],
        [
            "gallery-update-sheet.p.the-same-as-before",
            "declaration-changes.label.browser-module",
            "declaration-changes.label.widest-access",
            ...groups,
        ],
        ["GalleryUpdateSheet::declarationChanges(", "GalleryUpdateSheet::change.label()"],
    );
    b.add(
        f,
        "2038:51",
        "structural-reviewed",
        "GalleryUpdateSheet",
        "added/removed rows and translated scope producers",
        ["GalleryUpdateSheet", "declarationChanges", "declared"],
        ["declared.owner", "declared.who-steer"],
        [
            "GalleryUpdateSheet::change.added",
            "GalleryUpdateSheet::change.removed",
            "GalleryUpdateSheet::change.from",
        ],
    );
    b.add(
        f,
        "2038:116 2039:120",
        "translated",
        "GalleryUpdateSheet",
        "identifiers preserve command-scope producer",
        ["GalleryUpdateSheet", "declarationChanges", "declared"],
        ["declared.owner", "declared.who-steer"],
        ["GalleryUpdateSheet::change.added.join", "GalleryUpdateSheet::change.removed.join"],
    );
    b.add(
        f,
        "2040:92",
        "translated",
        "GalleryUpdateSheet",
        "translated access change words",
        ["GalleryUpdateSheet", "declarationChanges", "accessWords"],
        [
            "declaration-changes.words.content",
            "declaration-changes.words.none",
            "owner.owner",
            "steer.people-who-steer",
            "view.everyone-who-sees-every",
        ],
        [
            "GalleryUpdateSheet::change.from",
            "GalleryUpdateSheet::change.to",
            "declarationChanges::accessWords(",
        ],
    );
    b.add(
        f,
        "2051:19 2054:80",
        "translated",
        "GalleryUpdateSheet",
        "display enum translated while CSS stays protocol value",
        ["GalleryUpdateSheet", "changeLabel"],
        changes,
        [
            "GalleryUpdateSheet::changeLabel(file.change)",
            "GalleryUpdateSheet::gallery-change ${file.change}",
        ],
    );
    b.add(
        f,
        "2053:46",
        "identifier-excluded",
        "GalleryUpdateSheet",
        "file path",
        ["GalleryUpdateSheet"],
        [],
        ["GalleryUpdateSheet::file.name"],
    );
    b.add(
        f,
        "2059:11",
        "already-wired",
        "GalleryUpdateSheet",
        "existing enabled warning, raw diff retained",
        ["GalleryUpdateSheet"],
        ["gallery-update-sheet.p.new-code-runs-soon"],
        ["GalleryUpdateSheet::<${DiffBlock}", "GalleryUpdateSheet::data.diff"],
    );
    b.add(
        f,
        "2116:42",
        "translated",
        "Field",
        "share callers produce translated field labels",
        ["Field", "GalleryShareSheet"],
        [
            "gallery-share-sheet.label.repository",
            "gallery-share-sheet.label.commit",
            "gallery-share-sheet.label.folder-optional",
            "gallery-share-sheet.label.tags",
            "gallery-share-sheet.label.your-name",
            "gallery-share-sheet.label.your-git-hub-name-optional",
        ],
        ["Field::${label}", "GalleryShareSheet::<${Field}"],
    );
    b.add(
        f,
        "2121:27",
        "translated",
        "Field",
        "share callers produce placeholders",
        ["Field", "GalleryShareSheet"],
        [
            "gallery-share-sheet.placeholder.theme",
            "gallery-share-sheet.placeholder.extension",
            "gallery-share-sheet.placeholder.dark-minimal",
            "gallery-share-sheet.placeholder.usage-limits",
            "gallery-share-sheet.placeholder.letters-digits",
            "gallery-share-sheet.placeholder.octocat",
        ],
        ["Field::placeholder=${placeholder}", "GalleryShareSheet::<${Field}"],
    );
    b.add(
        f,
        "2129:13",
        "translated",
        "Field",
        "validation and hints producers",
        ["Field", "fieldProblems", "GalleryShareSheet"],
        [
            "field-problems.tags.up-tags-lowercase-letters",
            "field-problems.path.write-folder-repository-such",
            "gallery-share-sheet.hint.full-id-commit-files",
            "gallery-share-sheet.hint.only-files-not-top",
            "gallery-share-sheet.hint.few-words-people-search",
        ],
        ["Field::problem", "Field::hint", "GalleryShareSheet::fieldProblems(typed)"],
    );
    b.add(
        f,
        "2130:50",
        "translated",
        "Field",
        "problem is fieldProblems output",
        ["Field", "fieldProblems", "GalleryShareSheet"],
        [
            "field-problems.repo.give-git-hub-repository-files",
            "field-problems.repo.write-owner-name-such",
            "field-problems.commit.give-commit-files",
            "field-problems.commit.write-full-commit-id",
            "field-problems.path.write-folder-repository-such",
            "field-problems.tags.up-tags-lowercase-letters",
            "field-problems.github.write-git-hub-name",
            "field-problems.name.give-name-characters-most",
        ],
        ["Field::${problem}", "GalleryShareSheet::fieldProblems(typed)"],
    );
    b.add(
        f,
        "2131:59",
        "translated",
        "Field",
        "localized hint callers with valid examples",
        ["Field", "GalleryShareSheet"],
        [
            "gallery-share-sheet.hint.full-id-commit-files",
            "gallery-share-sheet.hint.only-files-not-top",
            "gallery-share-sheet.hint.few-words-people-search",
            "gallery-share-sheet.hint.dark-calm",
            "gallery-share-sheet.hint.usage-time",
        ],
        ["Field::${hint}"],
    );
    b.add(
        f,
        "2161:15",
        "translated",
        "GalleryShareSheet",
        "loader and raw error",
        ["GalleryShareSheet"],
        ["gallery-share-sheet.label.checking-it"],
        ["GalleryShareSheet::problem"],
    );
    b.add(
        f,
        "2161:61",
        "content-excluded",
        "GalleryShareSheet",
        "upstream API error",
        ["GalleryShareSheet"],
        [],
        ["GalleryShareSheet::problem"],
    );
    b.add(
        f,
        "2207:13",
        "already-wired",
        "GalleryShareSheet",
        "existing review labels and raw notes/problems",
        ["GalleryShareSheet"],
        ["gallery-share-sheet.strong.fix-these-first", "gallery-share-sheet.text.stands-own"],
        ["GalleryShareSheet::data.problems", "GalleryShareSheet::data.notes"],
    );
    b.add(
        f,
        "2211:29 2211:88",
        "content-excluded",
        "GalleryShareSheet",
        "upstream problems",
        ["GalleryShareSheet"],
        [],
        ["GalleryShareSheet::data.problems.map"],
    );
    b.add(
        f,
        "2221:19 2221:75",
        "content-excluded",
        "GalleryShareSheet",
        "upstream notes",
        ["GalleryShareSheet"],
        [],
        ["GalleryShareSheet::data.notes.map"],
    );
    b.add(
        f,
        "2230:19",
        "structural-reviewed",
        "GalleryShareSheet",
        "entry file rows",
        ["GalleryShareSheet"],
        [],
        ["GalleryShareSheet::data.entry.files.map"],
    );
    b.add(
        f,
        "2232:46",
        "identifier-excluded",
        "GalleryShareSheet",
        "author file path",
        ["GalleryShareSheet"],
        [],
        ["GalleryShareSheet::each.name"],
    );
    b.add(
        f,
        "2233:53",
        "identifier-excluded",
        "GalleryShareSheet",
        "formatted size",
        ["GalleryShareSheet"],
        [],
        ["GalleryShareSheet::formatBytes(each.size)"],
    );
    b.add(
        f,
        "2262:35",
        "translated",
        "GalleryShareSheet",
        "ASCII-valid path examples",
        ["GalleryShareSheet"],
        ["gallery-share-sheet.placeholder.theme", "gallery-share-sheet.placeholder.extension"],
    );
    b.add(
        f,
        "2271:35",
        "translated",
        "GalleryShareSheet",
        "ASCII-valid tag examples",
        ["GalleryShareSheet"],
        [
            "gallery-share-sheet.placeholder.dark-minimal",
            "gallery-share-sheet.placeholder.usage-limits",
        ],
    );
    b.add(
        f,
        "2311:17",
        "already-wired",
        "GalleryShareSheet",
        "existing external submission links",
        ["GalleryShareSheet"],
        [
            "gallery-share-sheet.text.open-a-pull-request",
            "gallery-share-sheet.button.open-a-pull-request",
            "gallery-share-sheet.text.how-to-submit",
        ],
    );
    b.add(
        f,
        "2325:11",
        "translated",
        "GalleryShareSheet",
        "blocked messages and existing index explanation",
        ["GalleryShareSheet"],
        [
            "gallery-share-sheet.blocked.fix-problems-above-first",
            "gallery-share-sheet.blocked.turn-once-declares-known",
            "gallery-share-sheet.p.entry-too-long-link",
            "gallery-share-sheet.p.index-not-say-where",
        ],
    );
    b.add(
        f,
        "2325:69",
        "translated",
        "GalleryShareSheet",
        "blocked producer",
        ["GalleryShareSheet"],
        [
            "gallery-share-sheet.blocked.fix-problems-above-first",
            "gallery-share-sheet.blocked.turn-once-declares-known",
        ],
        ["GalleryShareSheet::blocked"],
    );
    b.add(
        f,
        "2330:17",
        "translated",
        "GalleryShareSheet",
        "entry length notice",
        ["GalleryShareSheet"],
        ["gallery-share-sheet.p.entry-too-long-link"],
    );
}
