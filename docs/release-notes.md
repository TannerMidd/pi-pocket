# Release notes

How to write the notes of a Pi Pocket release. They go in the release pull request's description and, unchanged, in the GitHub release.

The notes are for people who run Pi Pocket, and some of them read on a phone. Each release answers these questions in this order:

1. Must I do anything before or after I update?
2. What is new or better for me?
3. What changed for my theme or extension?
4. Who made it, and how was it checked?

## The rules

- **Lead with what people get, not with how it works.** "Runs wait out rate limits instead of failing", not "A limit gate wraps `streamSimple`".
- **One idea per bullet, one sentence after a bold name.** Keep the sentence under about 30 words. If people need more, add at most 3 sub-bullets, or link the docs.
- **No internal names outside "For theme and extension authors".** File names, functions, classes, and settings keys belong there or in the docs.
- **Credit at the end of the bullet**, in parentheses: `(#139, by @vitalNohj)`. For an issue that a person reported: `(#131, reported by @vitalNohj)`. Use "Fixes #N" where the release pull request should close the issue.
- **Leave out empty sections.** A small release can be a few bullets and the update steps.
- **Put anything one-way or risky in a `[!WARNING]` alert** at the top. Put needed steps (`npm install`, a restart) in a `[!IMPORTANT]` alert.
- **The app reads the warning.** Menu → Update Pi Pocket asks the owner to confirm a release whose notes have a `[!WARNING]` or `[!CAUTION]` alert, never installs it by itself, and does not go back from it by itself. So put every step that a person must do by hand, or that cannot be undone, in that alert. Updates run `npm ci` (a git checkout) or `npm install -g` (a global npm install) and restart by themselves. A release must be on the npm registry's `latest` tag for an npm install to take it (a beta is on `beta`, for people who turn on beta updates), and the notes come from the GitHub release of the same version. [releases.md](releases.md) tells when releases and betas come out.
- **Keep the review story short and folded** in a `<details>` block. Always say what was not tested.

## The template

```markdown
<One or two sentences: what this release is about.>

> [!IMPORTANT]
> **To update:** <the steps, in one line>. Details under [Updating](#updating).

> [!WARNING]
> <Only for a one-way or risky step: what happens, and what to do first.>

### Highlights

- **<Name>.** <What it does for you.> (<credit>)

### New

- **<Name>.** <One sentence.> (<credit>)

### Improved

### Fixed

### Security

### For theme and extension authors

- **<API or surface name>.** <What changed, and what to do.> (experimental)

### Updating

1. <Step.>
2. <Step.>

<details>
<summary>How this release was checked</summary>

- <At most 5 bullets: reviews, tests, live use.>
- **Not tested:** <what was not checked.>

</details>

**Thanks** to <names, with what each one did>.

**Full changes:** https://github.com/TannerMidd/pi-pocket/compare/vX.Y.Z...vA.B.C
```

### Sections

| Section                         | What goes in it                                                                                                         |
| ------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| Highlights                      | The 2 to 5 changes most people notice. They can repeat items from the sections below, in fewer words.                   |
| New                             | Features that did not exist.                                                                                            |
| Improved                        | Faster, clearer, or easier things that people already had. Give a number when there is one ("about 40% less work").     |
| Fixed                           | Bugs that people met. Say what went wrong, not what the code did.                                                       |
| Security                        | Fixes that protect people's data, sign-ins, or machine, and dependency updates for advisories.                          |
| For theme and extension authors | API changes, new extension points, renamed classes or parts, and what an author must change. Mark experimental members. |
| Updating                        | Numbered steps. Say when a restart or `npm install` is needed, and what is one-way.                                     |

### The title

`Pi Pocket A.B.C: <2 to 4 headline changes, in plain words>`, under about 80 characters.
