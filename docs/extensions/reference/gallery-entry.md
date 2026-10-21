# Gallery entry

The extension gallery reads an index: one JSON file, the `index.json` that the index repository makes. The index has an entry for each extension and each theme. An entry names the files of one drop-in at a pinned commit of a GitHub repository, with the SHA-256 of each file. It also declares what the module installs. A theme's entry names the files of one theme folder in the same way ([A theme's entry](#a-themes-entry)). [Publishing to the gallery](../publishing.md) tells you how to share yours.

Pi Pocket reads the index strictly, because all of it comes from other people. The code is `src/server/gallery/entry.ts`. The index repository's checks use the same code, so Pi Pocket can read each entry that the checks let in.

- Each text field is one plain line, with no space at its ends. It has no control, invisible, or direction characters.
- A list has no item two times.
- A field that is not on this page makes the entry not valid.
- An entry that Pi Pocket cannot read is left out. An entry for a newer Pi Pocket, or for a newer extension API, is hidden. The gallery says how many it left out.

[Limits](limits.md#gallery) gives each length, count, and size.

## The index

### `format`

```ts
format: 1;
```

Since 0.14.0 · Stable

The format of the index. Pi Pocket reads format 1. For a newer format, it says that you must update Pi Pocket.

### `name`

```ts
name?: string;
```

Since 0.14.0 · Stable

The index's name.

### `repo`

```ts
repo?: string;
```

Since 0.14.0 · Stable

The address of the index's repository on GitHub, where people send entries: `https://github.com/owner/name`.

### `extensions`

```ts
extensions: Entry[];
```

Since 0.14.0 · Stable

The entries: extensions, and themes (`kind: "theme"`). Two entries cannot have the same `name`.

## An entry

### `name`

```ts
name: string;
```

Since 0.14.0 · Stable

The module's name: its file is `<name>.ts`. [Names](names.md#gallery-entries) gives the rules.

### `title`

```ts
title: string;
```

Since 0.14.0 · Stable

The title that the gallery shows.

### `description`

```ts
description: string;
```

Since 0.14.0 · Stable

What the extension does. **Share…** takes it from the first paragraph of the module's `/** … */` comment.

### `tags`

```ts
tags: string[];
```

Since 0.14.0 · Stable

Words that find the entry: lowercase letters, digits, and `-`, starting with a letter or digit.

### `author`

```ts
author: { name: string; github?: string };
```

Since 0.14.0 · Stable

Who wrote the extension: a name, and a GitHub user name.

### `version`

```ts
version: string;
```

Since 0.14.0 · Stable

The author's version, for people: letters, digits, `.`, `+`, and `-`. Pi Pocket goes by the commit, not by this version.

### `source`

```ts
source: { repo: string; commit: string; path?: string };
```

Since 0.14.0 · Stable

Where the files are.

- `repo`: a GitHub repository, as `owner/name`.
- `commit`: the full id of the commit with the files, 40 hexadecimal characters.
- `path`: the folder in the repository that has the files. Leave it out, or give `""`, for the top of the repository.

### `files`

```ts
files: {
    name: string;
    sha256: string;
    size: number;
}
[];
```

Since 0.14.0 · Stable

The extension's files.

- `name`: where the file goes in the drop-in folder, and where it is in the repository, under `source.path`. [Names](names.md#gallery-entries) gives the names that a file can have. The files must include `<name>.ts`. Two names cannot differ only in case. A file cannot also be a folder of another file.
- `sha256`: the file's SHA-256, in lowercase hexadecimal.
- `size`: the file's size, in bytes.

A file whose size or SHA-256 is not the same as in the entry installs nothing at all.

### `pocketApi`

```ts
pocketApi: number;
```

Since 0.14.0 · Stable

The version of the extension API that the extension needs, such as `1`. For a newer version than Pi Pocket's, the gallery hides the entry.

### `minPocket`

```ts
minPocket: string;
```

Since 0.14.0 · Stable

The oldest Pi Pocket that the extension works with, such as `0.14.0`. For an older Pi Pocket, the gallery hides the entry. A pre-release counts as its release: `0.14.0-beta.3` is `0.14.0`.

### `declares`

```ts
declares: Declares;
```

Since 0.14.0 · Stable

What the module installs. See [What an entry declares](#what-an-entry-declares).

### `revoked`

```ts
revoked?: { commit: string; reason: string }[];
```

Since 0.14.0 · Stable

Commits of the extension that people must not use, each with the reason. Where such a commit is installed, the gallery and the Extensions sheet say so, and offer to turn it off. When the entry's own `source.commit` is revoked, the gallery does not offer it. Pi Pocket reads `revoked` also from an entry that is otherwise not valid, or that is for a newer Pi Pocket.

## What an entry declares

These are the same lists that Menu → Extensions shows for a module that is on. The index's checks load the module in a test app and compare.

### `extensions`

```ts
extensions: string[];
```

Since 0.14.0 · Stable

The names of the extensions that the module installs. None can be a name that Pi Pocket keeps.

### `tools`

```ts
tools: string[];
```

Since 0.14.0 · Stable

The names of its tools. None can be the name of a built-in tool.

### `readOnlyTools`

```ts
readOnlyTools: string[];
```

Since 0.14.0 · Stable

The tools in `tools` that have `readOnlyHint`. Plan mode lets them run.

### `hooks`

```ts
hooks: string[];
```

Since 0.14.0 · Stable

The handlers of its hooks: `beforeTool`, `onYield`, and the others.

### `sections`

```ts
sections: string[];
```

Since 0.14.0 · Stable

Its prompt sections.

### `wraps`

```ts
wraps: string[];
```

Since 0.14.0 · Stable

The tools and sections that it wraps, as `tool bash` or `section memory`.

### `routes`

```ts
routes: string[];
```

Since 0.14.0 · Stable

Its routes, each as its method and path: `GET status`.

### `client`

```ts
client: "owner" | "steer" | "view" | null;
```

Since 0.14.0 · Stable

The `access` of its browser module, or `null` when it has none.

### `access`

```ts
access: "owner" | "steer" | "view";
```

Since 0.14.0 · Stable

The widest access of its routes and its browser module. It is `"owner"` when the module adds nothing to the app. It cannot be narrower than `client`.

### `commands`

```ts
commands?: string[];
```

Since 0.14.0 · Stable

Its commands, each as its scope and name, as a route has its method: `conversation clock-zone`, `global clock-reset`. None can be a name of the app's own commands. Leave the field out when the module has no commands: betas of 0.14.0 before beta.7 do not read an entry that has it.

## A theme's entry

A theme's entry has the fields of an extension's entry, with these differences. It has no `pocketApi` and no `declares`, because a theme runs no code. When Pi Pocket installs it, it checks the files as it checks every theme folder ([Themes](../themes.md#themes-in-the-gallery)). A Pi Pocket before 0.14.0, and its betas, cannot read a theme's entry: they leave it out, and never install it as an extension.

### `kind`

```ts
kind: "theme";
```

Since 0.14.0 · Stable

What the entry is. An entry with no `kind` is an extension.

### `name` (theme)

```ts
name: string;
```

Since 0.14.0 · Stable

The theme's id: the name of its folder in `themes/`. 2 to 48 characters: lowercase letters, digits, and `-`, starting with a letter or digit. It cannot be an id that Pi Pocket keeps: `desktop`, a theme that comes with Pi Pocket (`pocket`, `lantern`), or one of its palettes (`tokyo-night`, `gruvbox`, and the others in `web/themes.js`).

### `files` (theme)

```ts
files: {
    name: string;
    sha256: string;
    size: number;
}
[];
```

Since 0.14.0 · Stable

The theme folder's files, each as `<name>/<path>`. Pi Pocket installs them in `themes/<name>/`.

- `theme.json`, `colors.toml`, and `colors-light.toml`, at the top of the folder, 8 KB each at most.
- Stylesheets (`.css`), 256 KB together at most.
- Fonts (`.woff2`) and images (`.png`, `.jpg`, `.jpeg`, `.webp`, `.avif`, `.gif`, `.svg`), 4 MB each at most.
- Four folders deep at most, with no hidden files and no `node_modules`. 200 files at most, and 16 MB together at most.

The files must include `<name>/theme.css`, `<name>/colors.toml`, or `<name>/colors-light.toml`, and `<name>/theme.json` when they include `theme.css`. `sha256` and `size` are as for an extension.

### `themeApi`

```ts
themeApi: number;
```

Since 0.14.0 · Stable

The version of the theme surface (tokens, parts, and states) that the theme needs, such as `1`. For a newer version than Pi Pocket's, the gallery hides the entry.
