# Releases

Pi Pocket ships a stable release every Friday. Between two Fridays, the next release comes out as betas that people can choose to run.

## The week

| When                    | What happens                                                                                                                                                                                       |
| ----------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Friday, after a release | The branch of the next release opens: `release/X.Y.0`, from `main`.                                                                                                                                |
| Saturday to Thursday    | Ready pull requests merge into the release branch. A beta comes out when something worth trying lands.                                                                                             |
| Thursday, end of day    | Code freeze: from now on, only fixes go into the release branch. The last beta comes out.                                                                                                          |
| Friday                  | The review and live-test rounds run on the release branch, and their fixes go in. Then the release pull request merges into `main`, and the tag `vX.Y.0` and the GitHub release publish it to npm. |

A week with nothing to ship has no release. A change that is not ready by the freeze waits for the next week.

## Versions

- **A weekly release is a minor version**: 0.26.0, then 0.27.0. Pi Pocket is before 1.0, so a minor version can also change behavior. The notes say so.
- **A beta is the next release with a number**: `0.27.0-beta.1`, `0.27.0-beta.2`. Its commit is "Version 0.27.0-beta.N", and only `package.json` and `package-lock.json` change in it.
- **A fix that cannot wait for Friday is a patch release** (0.27.1), from the last release's tag, on any day. It goes into the open release branch too.

## Pull requests

- Open pull requests against `main`. A maintainer merges a ready one into the open release branch, with a merge commit that names the pull request and its author: `Merge PR #186: … (@Haichiu)`. Your commits keep your name.
- A maintainer's follow-up commits on a pull request name it too: "Follow-up to PR #186 by @Haichiu".
- GitHub marks the pull request merged when the release branch merges into `main`.

## Publishing a beta

1. On the release branch, set the version: `npm version 0.27.0-beta.1 --no-git-tag-version`, then commit "Version 0.27.0-beta.1".
2. Run `npm run check`, `npm run lint`, and `npm test`.
3. Push the branch and the tag `v0.27.0-beta.1`.
4. Make a GitHub release from the tag and mark it as a pre-release. Its notes are short: what is new since the last beta, with credits, written as [release-notes.md](release-notes.md) says.
5. Publishing the release runs `.github/workflows/publish.yml`. A version with a pre-release part goes to npm's `beta` dist-tag, never to `latest`.

A pre-release on GitHub is not the repository's latest release, and the version tag of a beta is not a release tag for updates. So people who do not choose betas never get one.

## Running betas

- **From the app**: turn on **Beta updates** in Menu → Extensions → Installed → Pi Pocket updates (since 0.27.0). Menu → Update Pi Pocket then offers betas too, marked **Beta**. Turn it off to wait for the next stable release: the app never offers an older version. With **Install new versions by themselves** on too, betas install by themselves.
- **A global npm install**: `npm install -g pi-pocket@beta`. Go back with `npm install -g pi-pocket@latest`.
- **A git checkout**: `git checkout v0.27.0-beta.1`, then `npm install`.

A beta is tested less than a release. Back up `~/.pi-pocket` before you run one: a beta can change stored data one way, and then the version before it cannot read the data.
