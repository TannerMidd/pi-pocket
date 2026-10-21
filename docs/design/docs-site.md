# Design: a documentation site for extensions

Status: **built**, on branch `pocket/docs-site` for 0.14.0: `docs-site/`, the two workflows, the split guides, the reference (`docs-reference`), and the policies (`extension-guidelines`). This page is the design as the owner approved it; where the build differs, a note says so. `docs-site/README.md` tells how the site works now.

Built differently, after the security and quality reviews:

- A run of `pages.yml` by hand publishes `main` only, and both workflows install with `npm ci --ignore-scripts`. The owner adds required reviewers to the `github-pages` environment.
- Each limit is written once, in `reference/limits.md`; the guides link to it. There is no check of the limits against the guides.
- The root `npm run check` also checks the reference against `types/pocket.d.ts`.
- The docs build fails on a symbolic link in `docs/`.
- Pi Pocket shows no deprecation warnings until the first release that deprecates a member.
- Theming ships in 0.14.0, with its own guide and reference page.

## The decisions

1. **Starlight (Astro) with Pagefind search**, in a new folder `docs-site/` with its own `package.json` and lock. It renders `docs/**/*.md` and `SECURITY.md` where they are, with no copies: the repository's Markdown stays the one source for Pi, GitHub, and the site.
2. **Split `docs/extensions.md`** (61 KB) into one page per task under `docs/extensions/`. `docs/extensions.md` keeps its path and becomes a short index: what an extension is, the module's shape, the rules that are easy to break, and which page to read for which task. Pi reads it whole, then only the pages its task needs.
3. **A reference with one heading per member**: its signature, a line `Since 0.14.0 · Stable`, and a short description. This reads well on GitHub and for Pi; the site shows the line as two tags. Today's wide tables do not work on a phone (screenshot 06).
4. **A public types file, `types/pocket.d.ts`**, for authors' editors and for Pi. A compile-only check in `npm run check` proves that the real host, `web`, and command context fit it. The reference is hand-written; the docs build checks that it names the same members, with the same versions, as the types file. No TypeDoc.
5. **GitHub Pages from Actions**: one workflow publishes `site/` at `/pi-pocket/` and the docs at `/pi-pocket/docs/` on each push to `main`. It replaces `npm run site:publish` (`git subtree push`). The `gh-pages` branch stays as it is, for rollback.
6. **The site shows the latest release only**, with "Since" marks. Each install keeps its own version's docs in `docs/`, and that is what its Pi reads.

## The sidebar

A page's address is its path: `docs/extensions/tools.md` is `/pi-pocket/docs/extensions/tools/`. Only the home page belongs to the site (`docs-site/src/pages/index.astro`).

```text
Home ................................ site only: a hero, four cards, links in
Getting started
  Overview .......................... docs/extensions.md (cut down to the index; adds "Where to read next")
  Your first extension .............. docs/extensions/first-extension.md (new, from "A module" and examples/clock.ts)
  Changes without code .............. docs/customizing.md (as it is)
Guides
  Modules, loading, and errors ...... extensions/modules.md ← "A module" (the file's rules), "Loading, reloading, and errors"
  Tools ............................. extensions/tools.md ← "Tools"
  Prompt sections ................... extensions/prompt-sections.md ← "Prompt sections"
  Hooks ............................. extensions/hooks.md ← "Hooks"
  Using the host .................... extensions/host.md ← "The host" (the prose: checks for new members, typing)
  Starting and messaging sessions ... extensions/linked-sessions.md ← same section
  Adding to the app ................. extensions/app.md ← "Adding to the app" (the three parts)
  Routes ............................ extensions/routes.md ← "Routes", "Who may use it"
  Browser modules ................... extensions/browser-modules.md ← "The browser module": setup, pieces, styles,
                                      redraw rules, failing alone, safe mode
  Slash commands .................... extensions/commands.md ← "Commands"
  How tool calls show ............... extensions/tool-calls.md ← the toolCall part of "The browser module"
  Events ............................ extensions/events.md ← "Events"
  Cleanups .......................... extensions/cleanups.md ← "Cleanups"
  Testing ........................... extensions/testing.md ← "Testing", with more steps
  Publishing to the gallery ......... extensions/publishing.md ← "The gallery", "Sharing yours"
  Themes ............................ extensions/themes.md (new, from the theming work of 0.14.0)
  Making it built in ................ extensions/built-in.md ← "A built-in extension"
Reference
  Types for your editor ............. extensions/reference/types.md (new) and types/pocket.d.ts
  host .............................. extensions/reference/host.md ← the host table, host.ts comments
  web ............................... extensions/reference/web.md ← the web table, request, access values
  pocket ............................ extensions/reference/pocket.md ← the pocket table, the fields of rail, menu,
                                      launcher, page, sheet, toolCall, the pieces, the CSS names Pi Pocket keeps
  Command context ................... extensions/reference/command-context.md ← ctx, results, scopes
  Gallery entry ..................... extensions/reference/gallery-entry.md ← "What an entry declares", every
                                      field of src/server/gallery/entry.ts
  Names ............................. extensions/reference/names.md ← "Names", and the name rules now spread over
                                      routes, ids, commands, and files
  Limits ............................ extensions/reference/limits.md (new: every number, each linked to its guide)
  API versions ...................... extensions/reference/api-versions.md ← "Versions" (pocketApi, web.api)
  Glossary .......................... extensions/reference/glossary.md (new: one word for each thing)
Policies (written by the extension-guidelines subagent)
  Core or extension ................. extensions/policies/core-or-extension.md
  API stability and deprecation ..... extensions/policies/stability.md
  Security for authors .............. extensions/policies/security.md
  Gallery review rules .............. extensions/policies/gallery-review.md
  Security model .................... SECURITY.md (as it is)
Pi Pocket's own code (closed by default)
  Documentation map ................. docs/index.md
  Changing the code ................. docs/self-editing.md
  Project map, Architecture, Features docs/map.md, architecture.md, features.md
```

Text moves first and is rewritten second, in separate commits, so a review can see that nothing was lost. A limit's number is in its guide and in the limits table, nowhere else. `docs/examples/` stays, so `test/docs-examples.test.ts` does not change. `docs/design/` is not on the site. If the policies land at other paths, phase 2 moves them. The repository has no `CONTRIBUTING.md` yet; if one comes, it goes in the last group.

## What changes for Pi

Pi finds the docs through the `docs()` section of `src/server/extensions/prompt.ts`, and through the root `AGENTS.md`.

- The prompt keeps its files, and `docs/extensions.md` stays the extension entry. Two edits: add "exact types in types/pocket.d.ts", and change "Read a doc completely, and follow its links" to "Read a doc completely before you change anything. index.md and extensions.md list the other pages: follow the links your task needs." Without that, Pi would read all 30 pages for each task. `prompt.ts` reloads without a restart.
- `AGENTS.md` links `docs/extensions.md#adding-to-the-app`; it becomes `docs/extensions/app.md`. `index.md`, `customizing.md`, `features.md`, `map.md`, and `self-editing.md` link to anchors that move. The docs build finds each one.
- What Pi reads for an extension task: today, all of the 61 KB page (about 15,000 tokens). After: the index (about 12 KB) and one to three pages of 3 to 10 KB, or the types file (about 12 KB) for exact shapes.
- Rejected: one dense page for Pi, split by heading for people at build time. With a tutorial, about 70 reference members, and the policies, that page would pass 100 KB, too much to read whole. And GitHub and the site would then have different pages and anchors.

## Tooling and the proof of concept

The proof of concept is in `/tmp/docs-site-poc` (Astro 7.4, Starlight 0.42.6, and Sätteri, Astro's default Markdown pipeline). It builds today's docs of this worktree as they are, and a mock of the split (a short index, two guides, a tutorial, a reference page). Screenshots: `/tmp/docs-site-poc-shots/`.

The custom part is about 150 lines (`src/repo-docs.mjs`):

- **A loader**: Astro's glob loader on the repository root (`docs/**/*.md`, `SECURITY.md`, not `docs/design/**`). The pages have no front matter, so the title comes from the `# H1`, the description from the first paragraph, and the edit link goes to the file on `main`.
- **A Sätteri plugin** removes the H1 (Starlight shows the title) and rewrites relative links. A link to a page goes to the page on the site; a link to anything else (code, an example, a folder) goes to GitHub at the built commit. It checks each relative link and anchor, and fails the build on a broken one. It shows `Since X · Stable` as two tags.

The result:

- All nine pages of today render unchanged: tables, code, lists, anchors. All 60 links between pages resolve on the site, anchors included; 23 links to code go to GitHub. The site makes anchors with GitHub's slugger, so one anchor works in both places.
- The check works: it stopped the build on an anchor it could not find (a bug in my first slug code), and on two links to files that the mock lacked.
- Search finds words in a section and links to that section (screenshot 04).
- The dev server reloads a page when a file in `docs/` changes, outside the site's folder.
- The product site stays as it is beside the docs (screenshot 05).

What needed care:

- Starlight's usual link checker (starlight-links-validator) assumes pages in `src/content/docs/` and rejected every link. Our check replaces it, and checks links as GitHub shows them too.
- Starlight adds heading links and asides only in its own content folder; its option `markdown.processedDirs` fixes that.
- Wide two-column tables scroll sideways on a phone (screenshot 06), hence one heading per member (screenshots 07, 09).
- Smart punctuation turns `'` into `’` on the site (not in anchors). GitHub-only syntax such as `> [!NOTE]` shows as a plain quote; the docs do not use it, and the style rules will say so.
- GitHub Pages uses one 404 page for the whole site, so Starlight's is not used.

`docs-site/` holds `package.json` (`pi-pocket-docs`, private), its lock, `astro.config.mjs`, the loader and plugin, the home page, and a stylesheet with the product site's colors and `site/fonts/`. The root `npm run lint` and `npm run format` cover its sources with the same rules, and ignore `docs-site/dist/` and `docs-site/.astro/`. Prettier skips the one `.astro` file, laid out by hand. The root `tsconfig.json` and the Nix package leave the folder out, so the app ships without it.

## Deploy

Today, `gh-pages` is `git subtree split --prefix site`, pushed by hand (`npm run site:publish`), and Pages builds it in legacy mode. The repository has no workflows. A docs commit in `gh-pages` would stop the next subtree push (not a fast-forward), and a forced push would delete the docs.

|                 | A: a workflow commits into `gh-pages`                                                         | B: Pages from Actions (recommended)                   |
| --------------- | --------------------------------------------------------------------------------------------- | ----------------------------------------------------- |
| How             | Checks out `gh-pages`, copies `site/` to its root except `docs/`, builds into `docs/`, pushes | Puts `site/` and the docs build in one artifact       |
| Subtree push    | Must stop                                                                                     | Must stop                                             |
| GitHub settings | None                                                                                          | Settings → Pages → Source: GitHub Actions, once       |
| Token           | `contents: write`                                                                             | `pages: write`, `id-token: write`                     |
| History         | A generated commit per deploy                                                                 | None                                                  |
| Rollback        | Revert a commit                                                                               | Set the source back to `gh-pages`, which is unchanged |

The recommended workflow, `.github/workflows/pages.yml`:

- Runs on a push to `main` that changes `site/`, `docs/`, `docs-site/`, `types/`, or `SECURITY.md`. `main` only gets releases and site changes, so the docs show the latest release; pre-releases never reach it.
- Runs by hand (`gh workflow run pages.yml`). _Built differently:_ a run by hand publishes `main` only, as the security review asked; a site change goes out after its merge. The owner adds required reviewers to the `github-pages` environment.
- Checks out the ref, builds `docs-site/` (`npm ci`, `npm run build`, with the commit for code links), copies `site/` to `_site/` and the build to `_site/docs/`, uploads, and deploys. Actions pinned by SHA; no secrets.
- The first run is by hand, and its `_site/` (without `docs/`) is compared with `gh-pages` before the source is switched.

A second, read-only workflow builds the docs on pull requests that change those paths, so a broken link fails the PR, not the deploy.

## The types file

- `types/pocket.d.ts` has only the public surface: `Host`, `Web` (with requests, access, and commands), `CommandContext`, `Pocket` (with the specs of rail, menu, launcher, page, sheet, and toolCall), and `Module`. Each member has `@since`, and `@experimental` where it applies. It imports Pi Durable's and Pi AI's types by package name, which drop-ins resolve.
- Members only built-ins use (`pip`, `pipCompaction`, `gallery`, `watches`, `repoWatches`, `approvals`, `guard`, `schedules`, `goals`, `browsers`, `memory`) stay out; the host reference lists them as internal, to change in any release.
- Authors get it by (1) its absolute path, as docs say now for `host.ts`; (2) a link `_pocket.d.ts` that Pi Pocket makes in the drop-in folder beside `node_modules` (a leading `_` is never loaded), so `import type { Host, Web } from "./_pocket.d.ts"` works on any machine, and in a browser module through JSDoc. It must be `import type`: the gallery's check reads `import { type … }` as an import that runs; (3) a copy at `/pi-pocket/docs/pocket.d.ts`. An npm package can come later, if gallery authors ask.
- In step: `test/public-types.ts`, compile-only, in `npm run check`, assigns the real `PocketHost`, `ExtensionWeb`, and `CommandContext` to the public types, and the public `Module` to the loader's type; an error names the member that differs. A prototype passes on today's `host.ts`, and fails when the public file adds a member or changes a signature. For `pocket`, which has no types, one assertion in the existing `test/extension-ui.test.ts` compares `Object.keys(pocket)` with `Pocket`'s members. The docs build compares the reference with the types file.
- "Since" values for today's members come once from history (`git log -S`, `git tag --contains`). After that, a new member gets `@since` in its own change.

## Versions and style

Old versions get no site docs: each install has its own `docs/`, and GitHub shows any tag. A page header names the version. A beta preview at `/docs/next/` is possible later.

Public pages follow ASD-STE100 at about 80%: one instruction to a sentence, at most 20 words in a step and 25 in a description, active voice, and one word for one thing. The glossary fixes those words, for example "session" where the code says `conversationId`; the policies use it too.

## Effort, in phases

Each phase is one pull request, useful alone.

1. **Site and deploy** (about 1 day): `docs-site/` from the proof of concept, today's docs unchanged, the two workflows, a "Docs" link in `site/index.html`. The owner switches the Pages source.
2. **The split** (1 to 2 days): the index and guides from today's text, links fixed, `prompt.ts`, `AGENTS.md`, and `index.md` updated. Then a live check: Pi writes an extension, and we see which pages it reads.
3. **Types and reference** (about 2 days): the types file, its checks, the reference pages. Optional: the `_pocket.d.ts` link.
4. **New content** (2 to 3 days): tutorial, testing, limits, glossary, API versions; the policies placed; an STE pass over every public page; themes with the theming work of 0.14.0.
5. **Later, if wanted**: an npm package for the types, `/docs/next/`, `llms.txt` for other agents, an STE linter (Vale).

## Risks

- **Pi reads worse** (more files, a link not followed). The index keeps its path; phase 2's live check compares before and after.
- **Links from outside break.** GitHub has no redirects; old anchors (the gallery index's CONTRIBUTING, issues) land at the index's top, which links on. Phase 2 checks the gallery index repository.
- **Astro and Starlight change fast** (Starlight is before 1.0; Sätteri is new). The lock pins versions; the custom part is small, on public APIs, and fits a remark plugin on Astro's `unified()` pipeline too.
- **The switch breaks the product site.** First deploy by hand, compared with `gh-pages`; rollback is one setting.
- **Types or reference drift.** The checks above fail first.
- **The split loses precision.** Text moves before it is rewritten.
- **A duplicate heading.** Without the H1, the site counts one fewer heading than GitHub; an H2 that repeats the H1 would get another anchor. None does today; the check can refuse one.

## Open questions

1. **Pages from Actions (B), or commits into `gh-pages` (A)?** Recommended: B. Both retire `npm run site:publish`.
2. **Which host members are public?** Recommended: those listed above; built-in-only members are internal and stay out of the types. To agree with the stability policy.
3. **Site docs for old versions?** Recommended: no; the latest release, with "Since" marks.
4. **Beta docs at `/docs/next/`?** Recommended: not now.
5. **Folder name: `docs-site/` or `site/docs/`?** Recommended: `docs-site/`; in `site/`, its sources would mix with the published files.
6. **A read-only docs check on pull requests**, the repository's first CI? Recommended: yes, for those paths only.
7. **The `_pocket.d.ts` link** (a small change to Pi Pocket's code)? Recommended: yes, in phase 3.
8. **Map, architecture, self-editing, and features on the site?** Recommended: yes, in a closed group: they cost nothing, and search covers them.
9. **Title: "Pi Pocket docs" or "Pi Pocket extensions"?** Recommended: "Pi Pocket docs", with "Extend Pi Pocket" on the home page, as the site also has the pages for changes without code.
10. **A "How to write one" link from Menu → Extensions to the site?** Recommended: yes, in phase 4.
