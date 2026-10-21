# Publishing to the gallery

The gallery lists drop-ins that other people wrote. This page tells how Pi Pocket installs them, and how to share your own. The rules for entries, and their review, are in [Gallery review](policies/gallery-review.md). The fields of an entry are in [the gallery entry reference](reference/gallery-entry.md), and their limits in [Limits](reference/limits.md#gallery).

## How the gallery works

Menu → **Extensions** opens a hub with **Discover**, **Installed**, and **Updates** tabs. **Discover** (also **Find extensions** in the launcher) lists drop-ins that other people wrote. Install from the list; select an entry to read its details beside the list on a wide screen, or in its place on a phone. **Updates** opens each update review directly, with the changes shown before you apply them. The list comes from an index of reviewed entries. By default, the index is the repository [TannerMidd/pi-pocket-extensions](https://github.com/TannerMidd/pi-pocket-extensions), whose `index.json` lists them.

- The owner can read another index instead, at the bottom of that list: a GitHub repository as `owner/name`, or the https address of an `index.json`.
- The gallery is the built-in module Extension gallery (`gallery.ts`, the extension `pocket-gallery`). Only the owner can use it. When it is off, it reads nothing.

Each entry gives the files of one drop-in, at one commit of a GitHub repository, with the size and the SHA-256 of each file, and what the module installs.

The index lists themes too, with `"kind": "theme"` ([Themes](themes.md#themes-in-the-gallery)). A theme installs into the data folder's `themes/`, after the same checks as every theme folder, and each person chooses it in Appearance. A Pi Pocket before 0.14.0 counts a theme's entry as one it cannot read, so it never installs one as an extension.

## What Pi Pocket checks

Pi Pocket trusts nothing in an entry. So it:

- **Reads it strictly** (`src/server/gallery/entry.ts`). It checks each field. Each field is one line of plain text, with no control, invisible, or direction characters. Names follow the rules of the drop-in folder. Sizes and lengths stay in the [limits](reference/limits.md#gallery): of the index, of the files, and of each field.
    - It leaves out an entry that it cannot read, and hides an entry for a newer Pi Pocket or extension API. The list says how many.
    - It shows all of an entry as text, and links only to the GitHub addresses that it makes itself.
- **Downloads files only over https**, from the entry's repository on `raw.githubusercontent.com`, at the entry's commit. When the size or the SHA-256 of one file is different from the entry's, it installs nothing at all, and the same when a code file (ending in `.ts`, `.mts`, `.cts`, `.js`, `.mjs`, `.cjs`, `.json`, or `.css`, in any case) is not plain UTF-8 text, or any text file holds characters that change the direction of text.
- **Installs it off**, as each drop-in starts, also under a name that was on before. Only the owner turns it on.
- **Keeps where it came from** beside it, in `<name>.gallery.json` in the drop-in folder: the entry as installed. Updates and removal use it. So **Uninstall** removes its files and nothing else, and the gallery says which of them were edited since.
- **Puts a version in place all or none.** It keeps what it replaces aside until each file is in place. When that fails, or the server stops in the middle, the version before comes back, at the next start, before extensions load.
- **Never updates by itself.** When the index has a newer commit, the gallery and the Extensions sheet say **update available**. The update shows what changes in what the module declares, and a diff of each file. The owner applies it.
    - A module that is on stays on, and its new version loads at once.
    - Other code files that it imports load at the next restart. The gallery then asks for one.
- **Warns about revoked versions.** The index can revoke a commit of an extension.
    - Where that commit is installed, the gallery and the Extensions sheet say so, with the reason, and offer to turn it off.
    - While extensions from the index are installed, the gallery looks again from time to time ([limits](reference/limits.md#gallery)). It tells the owner in a notice when a revoked version is on.
    - An entry whose own commit is revoked is withdrawn: the gallery does not offer it, and does not install it.

## Before you turn one on

Read the module. The gallery shows each file, and what its entry declares.

**Ask Pi to review** starts a session in the drop-in folder, in plan mode, that asks Pi to audit the code:

- what it reads and writes (`config.json`, Pi's sign-ins, other secrets),
- its network calls, and the processes that it starts,
- what its browser module does,
- and whether it does what it declares.

The button does not send while Plan mode is off in Menu → Extensions. The review is a session like any other: people who see all sessions see it too.

The index's checks are not a security review. They check the entry, and that the module loads. A maintainer reads the code before an entry goes in.

## Sharing yours

The files of an entry belong to its drop-in, and have its name, so they never meet the files of another drop-in:

- **`<name>.ts`**, the module. `<name>` has lowercase letters, digits, `-`, and `_` ([length](reference/limits.md#names)), and starts with a letter or a digit. It is not the name of a built-in module, and does not start with `pocket-`. Its extensions and tools follow the [name rules](reference/names.md).
- **`<name>.js` or `<name>.mjs`** beside it, or the folder **`<name>/`**, for its browser module: `web.client("<name>.js")`, or `web.client("<name>")`.
    - Helpers go in that folder too, for example `import { zones } from "./<name>/zones.ts"`. The folder serves no `.ts` files.
    - The folder has a depth limit ([limits](reference/limits.md#gallery)), no hidden files, and no `node_modules`.
- **Imports**: only those files, Node's own modules, and the packages that Pi Pocket has (`@earendil-works/pi-durable`, `@earendil-works/pi-ai`, and others). Nothing by its place on this machine, and no code from other places. An `import type` is allowed, for example from `./_pocket.d.ts`: Node removes it when the module runs.
- **Description**: the first paragraph of its `/** … */` comment is the entry's description.

## Publish it

1. Put the files in a public GitHub repository, with the same names as in your drop-in folder, at its top or in a folder. Commit them.
2. In Menu → Extensions → **Installed**, tap **Share…** on your drop-in. Pi Pocket checks that the drop-in stands on its own, and writes a draft of its entry. The draft has the description from its comment, and the size and SHA-256 of each file. While the drop-in is on, it also has what the drop-in declares. Pi Pocket makes no GitHub calls for this.
3. Fill in what only you know: the repository (`owner/name`), the full ID of the commit with these files, the folder (if not the top), the tags, and your GitHub name.
4. Tap **Open a pull request**. It shows when the entry would pass the index's checks. It opens GitHub's new-file page in the index repository, with the entry filled in as `entries/<name>.json`. The index's [CONTRIBUTING](https://github.com/TannerMidd/pi-pocket-extensions/blob/main/CONTRIBUTING.md) tells the rest.

## Update it

1. Commit the new files.
2. Send a pull request that changes `source.commit`, `version`, and the hashes of the files. **Share…** gives them again.

The people who have the drop-in see the update, with its diff, and choose if they apply it.
