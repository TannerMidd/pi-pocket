# Design mode (0.26.0)

Status: built. The four streams (A to D) are merged into `feat/design`, off `release/0.26.0`. This page is the plan, corrected where the build differs from it. Each place that changed says "Built:". The words for the release are in `release-notes-design.md`.

Design mode gives Pi Pocket what Claude Design has: a big canvas beside the chat, where Pi makes interactive designs (prototypes, screens, one-pagers, slide decks), and people point at them, comment, tweak, edit text, compare versions and variations, export, and hand off to code.

It builds on artifacts. A design is an HTML artifact. Everything that works for artifacts today (versions, the sandbox, the bridge, saved state, share links, inline cards) keeps working.

## The parts, and who builds them

| Stream | Branch             | Owns (only these files, plus new tests)                                                                                                                                                                                                                                                |
| ------ | ------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A      | `design/bundles`   | `src/server/extensions/artifacts.ts`, `src/server/http/artifacts.ts` (serving only, not the bridge script), new `src/server/http/artifact-assets.ts`, `src/server/app.ts` (`artifactBody` and new bundle readers), the artifact kinds in `src/server/docs.ts`, new `src/server/zip.ts` |
| B      | `design/bridge`    | `web/artifact-bridge.js`, the bridge script in `src/server/http/artifacts.ts` (`ARTIFACT_BRIDGE` and what it calls), new `src/server/http/artifact-inspect.ts`                                                                                                                         |
| C      | `design/workspace` | new `src/server/extensions/design.ts`, new `src/server/extensions/design/` (browser module folder), `src/server/reload.ts`, a new kind at the end of `src/server/docs.ts`, `web/sheets/viewers.js` (an "Open in Design" button only)                                                   |
| D      | `design/agent`     | new `src/server/design/` (tools, prompt guide, preview, export, PPTX), nothing else                                                                                                                                                                                                    |

Rules for every stream:

- Work only in your own worktree (`/mnt/games/Development/pi-pocket-design-<a|b|c|d>`). Never edit `/mnt/games/Development/pi-pocket` (the live server: a file saved there loads for everyone at once).
- Touch only the files your stream owns. When you need a change in another stream's file, write it in your notes file and keep going with a small local stub.
- Do not edit `docs/features.md`, `docs/map.md`, `docs/release-notes.md`, `README.md`, or `CHANGELOG`. Write what they must say in `docs/design/notes-<a|b|c|d>.md`. The integrator merges them.
- Document kinds are stored data. Add new kinds and new optional fields. Never rename a kind, or change its scope, history, or fork settings.
- Keep to the house style (AGENTS.md): erasable TypeScript, `.ts` imports, Prettier and ESLint, `npm run format`, `npm run check`, `npm run lint`, `npm test`.
- No new npm dependencies. Node and the browser have what this needs (zlib for zip, CDP for Chromium).
- Check by hand on a throwaway copy: `node test/serve.ts <port> 127.0.0.2` with your port (A 8901, B 8902, C 8903, D 8904). The `browser` tool is one Chromium that all streams and the people watching share: navigate, check, and leave. If a page changes under you, another stream uses it: navigate again.

## A. Artifact bundles (assets, groups)

A design needs images, fonts, data files, and more than one page. Today an artifact is one UTF-8 file.

- The `artifact` and `artifact_inline` tools get `assets`: up to 200 entries of `{ name, path }` (copy a file from the session's machine, binary allowed) or `{ name, content }` (UTF-8 text). `name` is a relative path: segments of `[A-Za-z0-9._-]`, joined by `/`, no `.` or `..` segment, no leading `/`, up to 200 characters.
- A new version keeps the assets of the version before. `removeAssets: string[]` drops some. An entry with an existing name replaces it.
- Limits: 5 MB for one asset, 20 MB for all the assets of one version, as constants beside `MAX_BYTES`.
- Storage: assets are stored once for each content hash (sha256) in a new document kind, `pocket.artifact-asset`, keyed by the hash, with the bytes in base64. `ArtifactVersion` gets an optional `assets?: Record<string, { hash: string; size: number; type: string }>`. A replayed call must find what it wrote, as the body does.
- Serving: an asset is at `/a/:conversation/:artifact/:version/<name>`, and for a published link at `/pub/:token/<name>` (built: `src/server/http.ts` calls `publicArtifactBundle` in `src/server/http/artifact-assets.ts`, and `src/server/http/public.ts` is deleted), with the same sandbox CSP as the page, `X-Content-Type-Options: nosniff`, and a content type from its extension (an unknown extension is `application/octet-stream`, never HTML). A relative URL in the page (`assets/logo.png`, `about.html`) must resolve, in the viewer, the inline card, its own tab, and a published link. Inject a `<base href>` when the page has assets, or serve the page at a URL that ends in `/`: choose and say which. Built: an absolute `<base href>` is injected. A sandboxed page sends no cookie, so a private page gets a signed, version-scoped asset address that lasts 12 hours and permits only the version's manifest assets.
- A second HTML file in the bundle is a page of the design (`about.html`). It gets the bridge as the main page does.
- `group?: string` (a slug) on the tools puts the artifact in a group: variations of one design. Store it in `ArtifactMeta`. The workspace shows a group as a grid.
- `kind?: "page" | "deck"` on the tools, stored in `ArtifactMeta`. A deck is a slide deck (see D).
- Bundle reader on `PocketApp`: `artifactBundle(id, artifact, version?) => Promise<{ meta, version, content, assets: { name, type, bytes: Buffer }[] }>`. Built: the Design tools and routes do not use it. `designTools(host)` and `designRoutes(web, host)` take no bundle reader; `src/server/design/bundle.ts` reads the artifact documents with `snapshot`, the assets by hash.
- `src/server/zip.ts`: `zip(entries: { name: string; bytes: Buffer }[]) => Buffer`, deflate with `node:zlib`, no dependency. D uses it for PPTX and the HTML export (built: `design/export.ts` and `design/pptx.ts` import it).

## B. The bridge: inspect, edit, tweaks

New messages over the existing port. App → page messages come only from the app. Page → app messages are untrusted data: the app checks their shape and length, and uses them only as data in a person's own comment or edit.

App → page:

- `{ type: "pocket-inspect", on: boolean }`: inspect mode. The page outlines the element under the pointer (or finger), and a click or tap picks it (the page's own handler does not run). It sends `pocket-picked`.
- `{ type: "pocket-edit-text", on: boolean }`: text edit mode. Text elements become `contenteditable`. When one loses focus with a change, the page sends `pocket-text-edited`.
- `{ type: "pocket-tweak-set", values: Record<string, string | number | boolean> }`: for a name that starts with `--`, set that CSS custom property on `:root`; for any name, dispatch `pocket:tweak` on `window` with `{ detail: { name, value } }`.
- `{ type: "pocket-highlight", targets: Target[] }`: show numbered pins on these elements (the comments). An empty list clears them.
- `{ type: "pocket-goto", slide: number }`: in a deck, show this slide.

Page → app:

- `{ type: "pocket-picked", target: Target }`.
- `{ type: "pocket-text-edited", target: Target, before: string, after: string }` (each up to 2,000 characters).
- `{ type: "pocket-tweaks", knobs: Knob[] }`: once at start, from the page's manifest (below), and again if it changes.
- `{ type: "pocket-deck", slides: number, current: number }`: at start in a deck, and when the slide changes.

`Target` is `{ pid?: string, selector: string, tag: string, text: string (up to 200), html: string (up to 1,000), rect: { x, y, width, height }, styles: Record<string, string> (color, background-color, font-family, font-size, font-weight, line-height, padding, margin, border-radius, gap) }`. `pid` is the element's nearest `data-pid`. `selector` is a short unique CSS selector the bridge computes.

The tweaks manifest is in the page: `<script type="application/json" id="pocket-tweaks">[ … ]</script>`. A `Knob` is `{ name, label?, type: "range" | "color" | "select" | "toggle" | "text", value, min?, max?, step?, unit?, options? }`, at most 40.

A deck is a page with `<meta name="pocket-kind" content="deck">` and its slides as `<section class="slide">`, 16:9. The bridge shows one slide at a time, scaled to fit, with arrow keys and swipes, and handles `pocket-goto`. Built: slides are 1920×1080 by default, or the size in `<meta name="pocket-slide-size" content="WxH">`, in the canvas and in the PNG, PDF, and PPTX exports. Slide numbers in `pocket-goto` and `pocket-deck` start at 0; the `slide` of `design_preview` starts at 1.

The inspector lives in `src/server/http/artifact-inspect.ts` as a script string that the bridge script includes. It must not change the page until a mode turns on, and must clean up fully when it turns off.

The existing follow-up and saved-state messages stay as they are.

## C. The workspace

A built-in module, `design` (title "Design", on by default), with a browser module folder `src/server/extensions/design/`.

- A wide panel beside the conversation (`pocket.panel({ wide: true })`): chat on the left, canvas on the right. On a phone, the panel covers the chat, with a button back to the chat that keeps the canvas state.
- Opened from a rail button, the places, an "Open in Design" button in the artifact viewer, and `/design-open [artifact]`. Built: the command is `/design-open`, because a command's name must have a dash.
- The canvas: a picker of the session's HTML artifacts (newest first, groups together), the page in the artifact sandbox frame (the same frame and bridge as the viewer), device sizes (phone 390×844, tablet 820×1180, desktop 1280×800, custom), zoom and fit, and a light or dark backdrop.
- Versions: a timeline of the artifact's versions, side-by-side compare of two, and "Go back to this one" (asks Pi for a new version with that content, or writes one directly if C can do that safely through a durable call; say which). Built: the route writes a copy of the old version as a new one, assets included, in one commit. It never asks Pi.
- Comment mode: tap an element, write a note, and it becomes a pin. Comments are shared with everyone in the session, stored in a new kind at the end of `docs.ts` (`pocket.design-comments`, per conversation, keyed by artifact), with the version, the `Target`, the author, the text, and resolved or not. "Send to Pi" puts one message with all open comments (each with its target as JSON) in the message box, for the person to send.
- Edit mode: text edits gather into a list; "Apply" sends them to Pi as one message (Pi makes the new version with `edits`).
- Tweaks: a panel of the page's knobs (from `pocket-tweaks`), live on the canvas, kept for each person and artifact (in the module's own storage or the new kind). "Keep these" sends the values to Pi to write into the design.
- Variations: a group shows as a grid of live thumbnails; "Use this one" sends a message to Pi.
- Decks: a slide strip, and a full-screen present mode.
- Export: buttons for PNG, PDF, PPTX (decks), and HTML zip, through D's route, wired in `design.ts`. Built: the buttons `POST /api/x/design/export`, which writes the file in the session's `exports/` folder and answers `{ path, relative, name, size }`. The browser then downloads it through the core route `GET /api/c/<conversation>/download?path=<relative>`, which streams a file of the session folder as an attachment for the people that the file viewer lets read it, and does not follow a link at the file. The Design module has no download route of its own.
- Share: the existing Share, as in the viewer.
- `design.ts` registers D's tools and prompt section: `import { designTools, designGuide, designRoutes } from "../design/index.ts"` (see D). Until D lands, stub them.
- Register the module in `reload.ts`: `ORDER`, `TITLES`, and the names of D's tools in `BUILT_IN_TOOLS`.
- Viewers (people who cannot steer) see the canvas, versions, and comments, but cannot comment, edit, tweak, or send.

## D. The agent side

`src/server/design/index.ts` exports:

- `designTools(host): ToolRegistration[]`, the tools:
    - `design_preview({ id, version?, viewports?: ("mobile" | "tablet" | "desktop")[], fullPage?: boolean, slide?: number })`: render the artifact in a headless Chromium page of its own (not the shared browser people watch) and return the screenshots as images, plus console errors and failed requests. Pi uses it to check its own work before it replies.
    - `design_export({ id, version?, format: "png" | "pdf" | "pptx" | "html", viewport?, path? })`: write the file in the session's folder (default `exports/<id>-v<version>.<ext>`) and return the path. PNG and PDF through Chromium (CDP `Page.captureScreenshot`, `Page.printToPDF`). Built: the tool and the export route share `saveDesignExport` in `src/server/design/export.ts`. PPTX for a deck: one slide for each `section.slide`, as an image, 16:9, with the slide's text in the notes, written with `zip.ts`. HTML: the bundle as a zip.
    - `design_system({ action: "read" | "write", content? })`: the project's design system, a Markdown file at `<session folder>/.pi/design-system.md` (tokens as a fenced JSON block, then components and rules). Pi writes it after it reads a codebase or brand files the person points at.
- `designGuide(host)`: the prompt section for sessions with the module on. It tells Pi how to make designs: one HTML artifact for each design, `data-pid` on meaningful elements, a tweaks manifest of 3 to 8 useful knobs as CSS custom properties, the deck format, assets for images and fonts, the design system when one exists, variations as a `group` of 2 to 4 artifacts made in parallel (subagents or codemode), `design_preview` at two sizes before it replies, and handoff to code (export `html` into the project, then a linked session with the `team` tool).
- `designRoutes(web, host)`: the export route for the workspace (same formats, steer access). Built: `POST export` answers `{ path, relative, name, size }`. It does not stream the file: the core download route does (see C).

Headless rendering: use the same Chromium discovery as `src/server/browser/` (`discovery.ts`, `cdp.ts`), in a separate, headless browser or a separate target and context, closed after use, with a time limit. It loads the artifact from the server's own address (`/a/...`) and so needs the person's session cookie or a short-lived internal token: say which you chose and why it is safe. Built: neither. Each render serves the bundle from a temporary server on `127.0.0.1`, under a random 256-bit path, and Chromium gets no cookie, token, or app address, so a page's scripts hold no app credential. Other requests go through `host.fetchPublic`.

Canva export is out of scope and is not in 0.26.0: it needs an app approved by Canva and OAuth for each person.

## Integration

The integrator merged A and B into `feat/design` first, then C and D. The notes are now in `docs/features.md`, `docs/map.md`, and `docs/design/release-notes-design.md`. The release swarm runs again on `release/0.26.0` with `feat/design` merged.
