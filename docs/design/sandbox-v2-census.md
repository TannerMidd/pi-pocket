# Sandbox v2: host file and process census

Generated for `docs/design/sandbox-v2.md` (section 4.2) at base `690ebd74`. It lists **every** file in `src/server/**` that imports `node:fs`, `node:fs/promises`, or `node:child_process` (77 files). The verdict column is hand-assigned and reviewed. PR 2 turns this table into `src/server/fs-census.json`, and `test/fs-census.test.ts` keeps it current (design section 4.2).

Regenerate the file list:

```sh
rg -l --glob 'src/server/**/*.ts' -e 'from "(node:)?(fs|fs/promises|child_process)"' | sort
```

The test also catches: dynamic `import()`, `require`, `createRequire` (`lancet.ts` uses it; `extension-document-imports.ts` too), `process.getBuiltinModule`, `process.binding`, packages that wrap fs or spawn, and any call into Pi's own loaders. The census test lists each hit with its verdict.

Verdicts: **own** stays on the allow-list, with only paths under Pocket's own data, install, config, or system locations. **wrapper** is a process launcher. It does not lose `child_process`: it becomes a **named spawn wrapper** in the one allow-listed spawn module, and its callers lose the import. **convert** touches a session folder, so all its file access moves onto `hostfs`, and it loses its direct import. **split** does both: the session-folder part moves onto `hostfs`, and the own part uses `hostfs.own(root)`. After PR 2 only `own` files import the primitives.

| File                                  | Primitives                     | Path source                                                       | Verdict |
| ------------------------------------- | ------------------------------ | ----------------------------------------------------------------- | ------- |
| `avatars.ts`                          | fs                             | avatar store in the data dir                                      | own     |
| `background.ts`                       | child_process, fs              | task records (own); process cwd and `/proc` (folder, work)        | split   |
| `branches.ts`                         | fs                             | `.git` of the session folder                                      | convert |
| `browser/cdp.ts`                      | child_process, fs              | browser binary and profile under the data dir                     | own     |
| `browser/discovery.ts`                | fs                             | system browser locations                                          | own     |
| `browser/local-servers.ts`            | fs                             | `/proc` listeners                                                 | own     |
| `build.ts`                            | fs                             | install folder                                                    | own     |
| `changes.ts`                          | fs, fs/promises                | session folder: status, undo, diffs                               | convert |
| `commands.ts`                         | fs                             | session folder, uploads, worktrees                                | split   |
| `config.ts`                           | fs                             | config file in the data dir                                       | own     |
| `custom-providers.ts`                 | fs                             | config in the data dir                                            | own     |
| `design/files.ts`                     | fs, fs/promises                | exports into the session folder                                   | convert |
| `design/render.ts`                    | fs/promises                    | artifact bundles in the data dir                                  | own     |
| `design/scan-fig-container.ts`        | fs                             | scans the session folder                                          | convert |
| `design/scan-files.ts`                | fs                             | scans the session folder                                          | convert |
| `design/scan-render-pages.ts`         | fs                             | scans the session folder                                          | convert |
| `design/scan.ts`                      | fs                             | `realpathSync(cwd)` of the session folder                         | convert |
| `design/system.ts`                    | fs                             | `.pi/design/` in the session folder                               | convert |
| `design/tokens-cache.ts`              | fs                             | `.pi/design/` in the session folder                               | convert |
| `design/tokens-io.ts`                 | fs                             | `.pi/design/` in the session folder                               | convert |
| `design/tokens.ts`                    | fs                             | `.pi/design/` in the session folder                               | convert |
| `dropin-config.ts`                    | fs                             | drop-in config in the data dir                                    | own     |
| `extension-web.ts`                    | fs                             | extension files                                                   | own     |
| `extensions/codemode.ts`              | fs/promises                    | script file in the data dir                                       | own     |
| `extensions/design/system-routes.ts`  | fs                             | design system of the session folder                               | convert |
| `extensions/pip.ts`                   | fs                             | `<data>/pip.md`                                                   | own     |
| `extensions/pocket-relay.ts`          | fs/promises                    | `folderOf(cwd)` for file fetch; relay folder (own)                | split   |
| `extensions/pocket-relay/files.ts`    | fs, fs/promises                | `realpath(cwd)` and writes into the session folder                | convert |
| `extensions/pocket-relay/recovery.ts` | fs                             | relay state in the data dir                                       | own     |
| `extensions/pocket-relay/runtime.ts`  | fs, fs/promises                | relay folder in the data dir                                      | own     |
| `extensions/prompt.ts`                | fs                             | `trust.json` in the agent dir                                     | own     |
| `file-policy.ts`                      | fs                             | `realpath` and `stat` of requested paths                          | convert |
| `files.ts`                            | child_process, fs, fs/promises | session folder; `git check-ignore`                                | convert |
| `gallery.ts`                          | fs/promises                    | gallery in the data dir                                           | own     |
| `gallery/files.ts`                    | fs/promises                    | gallery in the data dir                                           | own     |
| `gallery/reach.ts`                    | fs/promises                    | gallery in the data dir                                           | own     |
| `gallery/share.ts`                    | fs/promises                    | gallery in the data dir                                           | own     |
| `gallery/themes.ts`                   | fs/promises                    | gallery in the data dir                                           | own     |
| `git.ts`                              | child_process                  | becomes the named wrapper `runGit` (hardened Git runner)          | wrapper |
| `github.ts`                           | child_process                  | becomes `runGh`; `gh` runs Git itself, so it is hardened like Git | wrapper |
| `http.ts`                             | fs                             | web files and sockets                                             | own     |
| `http/api.ts`                         | fs                             | uploads and file routes                                           | split   |
| `http/assets.ts`                      | fs                             | web assets (own); artifact and session files (folder)             | split   |
| `http/conversation-routes.ts`         | fs/promises                    | file, image, and download routes                                  | convert |
| `http/io.ts`                          | fs                             | web files                                                         | own     |
| `icon-store.ts`                       | fs                             | icons in the data dir                                             | own     |
| `lancet.ts`                           | fs                             | guard model and settings                                          | own     |
| `limit-gate.ts`                       | fs                             | data dir                                                          | own     |
| `lock.ts`                             | child_process, fs              | data-dir lock; `ps`                                               | own     |
| `main.ts`                             | fs                             | data dir at start                                                 | own     |
| `managed-storage.ts`                  | fs                             | managed folders in the data dir                                   | own     |
| `memory.ts`                           | fs/promises                    | `realpath(cwd)` as the project key (identity only)                | convert |
| `model-images.ts`                     | fs/promises                    | image path given by a tool or message                             | convert |
| `no-follow.ts`                        | fs, fs/promises                | folds into `hostfs.ts`                                            | convert |
| `npm-install.ts`                      | child_process, fs, fs/promises | extension installs in the data dir                                | own     |
| `npm-update.ts`                       | child_process, fs/promises     | install folder                                                    | own     |
| `omarchy.ts`                          | fs/promises                    | desktop config                                                    | own     |
| `pi-sessions.ts`                      | fs, fs/promises                | Pi's session files in `~/.pi`                                     | own     |
| `pip.ts`                              | fs                             | PiP clones (own); a source folder                                 | split   |
| `processes.ts`                        | child_process, fs              | named wrapper `spawnIn(folderRef)` (folder, work); `/proc` (own)  | split   |
| `project-model.ts`                    | fs                             | `.pi/settings.json` of the session folder                         | convert |
| `prompts.ts`                          | fs                             | project prompts, `paths` against the folder                       | convert |
| `push.ts`                             | fs                             | push state in the data dir                                        | own     |
| `reload.ts`                           | fs                             | extension files                                                   | own     |
| `reveal.ts`                           | child_process, fs              | becomes the named wrapper `reveal(folderRef, name)`               | wrapper |
| `secrets.ts`                          | fs                             | `.env` files of the session folder (folder); other secrets (own)  | split   |
| `session-cleanup.ts`                  | fs, fs/promises                | data dir (own); worktree folders (managed)                        | split   |
| `skills.ts`                           | fs                             | project skills; `existsSync` and `realpathSync` of the folder     | convert |
| `socket-path.ts`                      | fs                             | socket path                                                       | own     |
| `themes.ts`                           | fs                             | themes                                                            | own     |
| `themes/reserved.ts`                  | fs                             | themes                                                            | own     |
| `update-state.ts`                     | child_process, fs              | update state                                                      | own     |
| `updates.ts`                          | child_process, fs, fs/promises | install folder                                                    | own     |
| `upload-references.ts`                | fs, fs/promises                | uploads in the data dir; hard links are made between own files    | own     |
| `versions.ts`                         | fs                             | install folder                                                    | own     |
| `workspace.ts`                        | fs                             | the session folder: files, git dir, `makeFolder`                  | convert |
| `worktrees.ts`                        | fs, fs/promises                | managed worktrees (own); source folder, `copyNewFiles`, Git       | split   |

**Indirect users** import none of these, and call helpers that do. The type change in PR 2 (helpers take a `FolderRef`, not a string) forces each of them to convert:

| File                                                      | Reaches the folder through                                                                                   | Verdict                                               |
| --------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------- |
| `design/guide.ts`                                         | `readDesignSystemText`, `loadDesignSystem` (reads the guest's `.pi/design/` into the prompt)                 | convert                                               |
| `heic.ts`, `heic-worker.ts`                               | `model-images.ts` paths                                                                                      | convert                                               |
| `repo-watches.ts`, `github.ts` callers                    | `gh` and `git` with the folder as cwd                                                                        | hardened runner                                       |
| `browser.ts`, `browser/*`                                 | page files and `file://` URLs of a folder                                                                    | convert (host browser is refused for sandboxed trees) |
| `extension-request.ts`, `extension-sessions.ts`           | `host` file APIs for extensions                                                                              | hostfs-backed                                         |
| `prompts.ts`, `skills.ts`, `extensions/prompt.ts` callers | Pi's own loaders (`loadProjectContextFiles`, `loadSkills`, `loadSkillsFromDir`), which read paths themselves | convert: snapshot (design 4.2)                        |
