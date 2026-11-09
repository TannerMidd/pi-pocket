---
status: draft
issue:
---

# GitLab repository watches

## Problem Statement

People on this fork keep their repositories on GitLab, not on GitHub. `repo_watch` watches
only GitHub: every look runs `gh`, every repository name is read as GitHub writes it, and every
timestamp comes from GitHub's JSON. Given a GitLab repository, PiP either refuses the watch or
asks the wrong service.

`docker/tools.dockerfile` has no `glab`, so even a GitLab-aware watch could not run in the
container.

The person's request: GitLab support in `repo_watch`, and `glab` installed in the tools image,
with `GITLAB_TOKEN` and `GITLAB_HOST` from the environment. No `glab auth login`.

## Solution

A watch keeps its repository as a remote-shaped name (`host/owner/name`, or `owner/name` for a
host's default). On every look, the watch reads the host from that name and runs the command
for that host:

- a GitLab host runs `glab`, with `GITLAB_TOKEN` and `GITLAB_HOST` from the environment; and
- any other host runs `gh`, as now.

The person signs in only through the environment. Nothing is stored that names a provider: a
watch set up on a GitLab remote stays a GitLab watch through restarts, because its stored name
still says where it lives.

`docker/tools.dockerfile` installs `glab` in the image, so the watch works in a container.

## Tasks, in order

1. **The image first.** `docker/tools.dockerfile` installs `glab`, so a rebuilt container has it before any code
   needs it.
2. Then the provider split: the name decides the command.
3. Then the GitLab readings, the merge request names, and the tests.

## User Stories

1. As a person on GitLab, I want PiP to watch my repository, so that I hear of new issues, merge
   requests, failed pipelines, releases, and `@pi` mentions.
2. As a person, I want each watch to use the command for its repository's host, so that one
   server can watch GitHub and GitLab repositories at the same time.
3. As the owner, I want to set `GITLAB_TOKEN` and `GITLAB_HOST` once in the environment, so that
   no session has to sign in on my behalf.
4. As the owner, I want `glab` in the tools image, so that a container needs no extra install.
5. As a person, I want a GitLab merge request named the way GitLab writes it, so that I can give
   a watch an address I copy from the browser.
6. As a person, I want the same filters on GitLab as on GitHub, so that I learn one set of rules:
   a label, assigned to me, a branch for pipelines, and from writers only by default.
7. As a person whose watch fails, I want to see why in words I can act on, so that a missing token
   is not a silent stop.

## Implementation Decisions

### The provider comes from where the command runs

A session works in a folder. That folder's `origin` remote says which service holds the
repository, and both commands read it themselves when they run in that folder: `gh pr view` and
`glab mr view` find the project of the directory they run in.

So the rule is: **run the command in the project root and let it resolve the remote.**

- `git remote get-url origin` in the session's folder gives the host. Only `origin` counts; any
  other remote is ignored, because `origin` is what `git push` uses and what the person works
  against.
- A GitLab host runs `glab`, in that same folder.
- Any other host runs `gh`, as now.
- Nothing is parsed out of a name to decide this, and no provider is stored.

A pull request watch needs no name parsing at all: the folder is the session's own, and the
command that runs there resolves the project.

`repo_watch` runs on a timer with nobody there, so it cannot ask a folder each time. It resolves
the repository once, when it is set up, and stores the result as `host/owner/name`. A watch on a
repository the session does not work in needs a name that carries its host
(`gl.mycorp.com/group/project`), because no folder can answer for it.

`GITLAB_HOST`, when set, names the GitLab instance the environment is signed in to. It does not
override the remote: it tells the GitLab side which host its token belongs to.

### What a name that cannot be found says

When `origin` points at a host and that host does not have the repository, the message names the
host the remote gave:

- `acme/api` is not tracked on github.com.
- `acme/api` is not tracked on gl.mycorp.com.

The host comes from the remote, so the sentence is true and not a guess. This replaces the
current "GitHub has no repository …" wording, which assumes GitHub.

### One command runner, two commands

`github.ts` has `runGh`. A new `gitlab.ts` gives the GitLab side, and a small `remote.ts` decides
which one to use for a folder:

- `providerOf(folder)` reads `git remote get-url origin`, compares its host with `GITLAB_HOST`
  (or `gitlab.com`), and returns `"gitlab"` or `"github"`.
- The GitLab runner calls `glab` with `GITLAB_TOKEN` and `GITLAB_HOST` from the environment, with
  prompts disabled, and with the folder as its working directory.
- Both providers answer the same internal shapes (`Item`, the fields `#fetch` builds), so
  `repo-watches.ts` keeps its loop, its deduplication, its limits, and its message format.

### What a GitLab look asks

| Event | GitHub now | GitLab |
|---|---|---|
| issues | `repos/:repo/issues?state=open` | project issues, opened, newest first |
| pulls | `repos/:repo/pulls?state=open` | opened merge requests |
| ci | `actions/runs?branch=…&status=completed` | pipelines for the branch, failed only |
| releases | `releases?per_page=10` | releases, published |
| mentions | `issues/comments`, `pulls/comments` | issue notes and merge request notes |

A failed pipeline's log is reached with `glab ci trace`, which replaces `gh run view
--log-failed` in the line Pi reads.

### Who counts as a writer

GitHub gives an `author_association` and a collaborator permission. GitLab gives each note and
issue an author, and a project has members with roles. The GitLab side asks the project for the
author's access level, and counts a role that can push (Developer and above). Reporting access
through the API is cached for ten minutes, exactly as on the GitHub side, and an answer that
cannot be read counts as no access.

### Merge request names

`parseRepo` gains GitLab addresses (`https://gitlab.example.com/group/project/-/issues/3`,
`…/-/merge_requests/7`). `parsePr` keeps `owner/name#12` and adds a merge request's address,
which ends `/-/merge_requests/12`. `prUrl` writes the GitLab address for a GitLab host.

`session_watch_pr` needs the same split: a merge request's checks come from its pipeline, its
conflicts from its merge status, and its reviews from its notes.

### Environment

`GITLAB_TOKEN` and `GITLAB_HOST` are read from the process environment at each call, never
stored in a document. A missing token fails the look with a message that names the variable,
exactly as a missing `gh` sign-in does now.

`glab` writes a config folder under `$HOME/.config` before it does anything, even when the token
and host come from the environment. The server can run as a user that does not own `$HOME`, as
it does in this container, and then `glab` refuses to start. The runner sets `GLAB_CONFIG_DIR` to
a folder inside Pi Pocket's own data folder, which the server always owns, and creates it when it
is missing. A look therefore never depends on the home folder.

### The image, and this container first

`docker/tools.dockerfile` gets `glab` in the stage it ends with. The file says its leading stages
must stay line for line identical to `docker/Dockerfile`, so `glab` goes into the tools stage
after that copied header, not into the copied lines. The stock image stays as it is.

The install downloads the release binary for the image's architecture, checks it runs with
`glab --version`, and pins the version in an `ARG`, as `CLOUDFLARED_VERSION` and `UV_VERSION`
already are. The release is `v1.124.0`; `glab_<version>_linux_<arch>.tar.gz` holds the binary.

**This container gets `glab` before the image is rebuilt.** The image build is long, and the work
after this step needs a `glab` to run against. So the same pinned version is put into
`/usr/local/bin/glab` here first. A rebuild then replaces this container, and the image's own
copy takes over.

## Testing Decisions

Tests assert what a person sees, not which function was called.

- **The name decides the command.** A table of names (GitHub, `gitlab.com`, the host in
  `GITLAB_HOST`, a subgroup path) maps to the command it must run.
- **A GitLab watch tells what happened, once.** The existing fake-`gh` harness gets a fake
  `glab` beside it, and the GitHub test is repeated with GitLab-shaped answers: a merge request, a
  failed pipeline on a branch, a release, and an `@pi` note. The message must carry the same
  fenced shape and the same instructions.
- **Strangers stay out.** Notes and merge requests from people without a push-capable role do
  not reach PiP, unless the watch says anyone.
- **No token says so.** A look with no `GITLAB_TOKEN` sets a note that names the variable, and
  the watch keeps looking later.
- **A mixed pair coexists.** One GitHub watch and one GitLab watch run side by side, and each
  asks only its own command.

Prior art is `test/repo-watches.test.ts`, which already fakes `gh` through `app.watches.gh` and
scripts PiP with a faux model.

## Out of Scope

- A new tool or a new parameter that names a provider. The name decides.
- `glab auth login`, token storage, or a settings sheet for GitLab credentials. The environment
  is the only configuration.
- GitLab webhooks. This changes repository watches only.
- `glab` in the stock `docker/Dockerfile`. The stock image stays GitHub-only, as its own comment
  says.
- GitLab subgroups deeper than the API reads, custom `GITLAB_URI` subfolders, and project
  transfer between hosts: each is a later change if a person needs it.

## Further Notes

- `glab` is not signed in and does not need to be: `GITLAB_TOKEN` alone authenticates every call.
  `GITLAB_HOST` has priority over the remotes in a working directory, so a look run from any
  folder reaches the intended instance.
- This container now has `glab 1.124.0` in `/opt/uv-bin`, put there by hand because the server user
  cannot write `/usr/local/bin`. The image puts its own copy in `/usr/local/bin` on a rebuild. The
  hand-installed copy and the image's are the same version.
- The existing `anyone` rule stays the person's choice on both providers, and PiP still cannot
  set it.
- `docs.ts` documents `RepoWatch` as a GitHub record. That comment must change, because the
  stored kind and its fields do not: only the words that describe them.
- Only `origin` decides the provider. A second remote, such as a fork's `upstream`, is ignored on
  purpose: it would make the answer depend on which remote was read.
