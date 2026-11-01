# Design mode: sections for the 0.26.0 release notes

These are the Design parts of the 0.26.0 notes. Merge them into the body of pull request 177 under the same headings, and follow [../release-notes.md](../release-notes.md). Add "Design mode" to the title. Update the checks at the end after the release swarm runs.

### Highlights

- **Design mode.** A canvas beside the chat where you point at a part of a design, comment, edit text, tweak it live, compare versions, and export. Pi checks its own work first.
- **Artifacts can carry files.** Images, fonts, styles, scripts, data, and more pages load in the viewer, in an inline card, in an artifact's own tab, and in a shared link.

### New

- **Design mode.** Pi's HTML designs (prototypes, screens, one-pagers, slide decks) open on a canvas beside the chat, at phone, tablet, and desktop sizes. Open it from the rail, the places, **Open in Design** in the artifact viewer, or `/design-open`.
    - **Comment:** tap an element, write a note, and it becomes a pin. Comments are shared with the session and last across restarts. **Send to Pi** puts them all in your message box.
    - **Edit text** in the page itself, and **Tweaks**: sliders, colors, and switches that change the design live, kept for each person. Pi writes the changes into a new version when you ask.
    - **Versions:** a timeline, side-by-side compare, and **Go back to this one**, which makes a new version without asking Pi.
- **Variations and decks.** Variations of one design show as a grid, and **Use this one** tells Pi which to carry on. A deck gets a slide strip and a full-screen present mode.
- **Pi checks its designs.** Before it replies, Pi renders a design at phone and desktop sizes in a private browser and fixes the errors it finds. The browser you watch stays out of it.
- **Export.** PNG, PDF, PowerPoint (for decks), and an HTML zip, saved in the session's `exports/` folder and downloaded from the canvas. PowerPoint slides are images, with the slide text as notes.
- **Project design systems.** Pi reads a codebase or brand files you point at, writes the rules to `.pi/design-system.md` in the session's folder, and follows them in later designs.
- **Bundles for artifacts.** An artifact version can hold up to 200 files, 5 MB each and 20 MB in all. A new version keeps the files of the last one. Pages can link to each other, and a shared link serves the files too. Old artifacts work as they did.

### Known limits

- The static preview of an inline card shows no bundle files until you tap **Run**.
- The inspector adds about 36 KB to each HTML artifact page.
- A second page inside the frame, or a page that navigates itself, has no bridge. Comments, edits, and tweaks go quiet there.
- Shadow DOM and nested iframes cannot be picked.
- A comment shows only on the version it was made on.
- There is no Canva export.

### For theme and extension authors

- **Artifact tools.** `artifact` and `artifact_inline` take `assets`, `removeAssets`, `group`, and `kind` (`page` or `deck`). `ArtifactVersion` has an optional `assets` map, and `ArtifactMeta` has optional `group` and `kind`. Assets are stored once for each content hash in the new `pocket.artifact-asset` documents. (experimental)
- **New built-in tools and module.** `design_preview`, `design_export`, and `design_system` belong to the `design` module. A drop-in cannot use these names.
- **New stored kind.** `pocket.design-comments` holds a design's comments, each person's tweaks, and the versions made by going back.
- **Routes.** `POST /api/x/design/c/:conversation/export` writes an export and answers `{ path, relative, name, size }`. The core route `GET /api/c/:id/download?path=<relative>` streams a file of the session folder as an attachment for the people that the file viewer lets read it. `/pub/<token>/<name>` serves a shared bundle's files, and `src/server/http/public.ts` is gone.
- **Asset addresses.** A private page reaches its assets through a signed address that lasts 12 hours. It permits only the version's files.
- **The bridge.** The app sends `pocket-inspect`, `pocket-edit-text`, `pocket-tweak-set`, `pocket-highlight`, and `pocket-goto` to the page. The page answers with `pocket-picked`, `pocket-text-edited`, `pocket-tweaks`, and `pocket-deck`, only from the inspector, and the app checks each one. `web/artifact-bridge.js` exports `useArtifactBridge`, `attachBridge`, `sendToFrame`, `checkPageMessage`, and `checkAppMessage`. (experimental)
- **Page markup.** `data-pid` names an element. `<script type="application/json" id="pocket-tweaks">` declares up to 40 knobs; a name that starts with `--` sets that CSS custom property, and any other name fires `pocket:tweak` on `window`. A deck is `<meta name="pocket-kind" content="deck">` with `<section class="slide">` slides at 1920×1080, or the size in `<meta name="pocket-slide-size" content="WxH">`. (experimental)

### Checks to add to "How this release was checked"

- Design was built in 4 parts, each with its own strong-model security review. The reviews found bugs, all fixed and checked again.
- A real Chromium loads bundle fonts, images, styles, and modules through the viewer, an inline card, an artifact's own tab, and a shared link.
- LibreOffice opened a generated PowerPoint file, and a Chromium PDF of a deck had one page for each slide.
- **Not tested:** PowerPoint and Keynote.
