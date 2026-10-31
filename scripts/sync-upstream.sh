#!/usr/bin/env bash
#
# Bring the upstream commits into this fork, on a branch of their own.
#
# The steps, in this order:
#   1. Add the remote `upstream` if it is missing, and fetch it with `--prune`.
#   2. Print the divergence: how many commits `main` is behind and ahead of
#      `upstream/main`, and the subjects of the incoming commits.
#   3. Stop if the working tree has local changes.
#   4. Create the branch `sync/upstream-<date>` at `main`, and switch to it.
#   5. Merge `upstream/main` into that branch.
#   6. Stop on a merge conflict with a clear message.
#
# This script does not push, and it does not change `main`.
# `main` only gets the work when a person merges the pull request.
#
# The project's checks, to run in branch `sync/upstream-<date>` after a merge
# (from package.json and AGENTS.md):
#   npm install          (only when package.json or package-lock.json changed)
#   npm run check
#   npm run lint
#   npm test
#
# Usage:
#   scripts/sync-upstream.sh              fetch, report, branch, and merge
#   scripts/sync-upstream.sh --report-only
#                                         fetch and report only: no branch, no merge
#
# Settings, as environment values:
#   UPSTREAM_REMOTE   the remote name (default: upstream)
#   UPSTREAM_URL      the URL to add if the remote is missing
#                     (default: https://github.com/TannerMidd/pi-pocket.git)
#   UPSTREAM_BRANCH   the branch to merge (default: main)
#   BASE_BRANCH       the branch to start from (default: main)
#   MAX_SUBJECTS      how many incoming subjects to list (default: 20, 0 = all)

set -euo pipefail

UPSTREAM_REMOTE=${UPSTREAM_REMOTE:-upstream}
UPSTREAM_URL=${UPSTREAM_URL:-https://github.com/TannerMidd/pi-pocket.git}
UPSTREAM_BRANCH=${UPSTREAM_BRANCH:-main}
BASE_BRANCH=${BASE_BRANCH:-main}
MAX_SUBJECTS=${MAX_SUBJECTS:-20}

REPORT_ONLY=0
for arg in "$@"; do
    case "$arg" in
        --report-only) REPORT_ONLY=1 ;;
        -h | --help)
            sed -n '2,30p' "$0" | sed 's/^# \{0,1\}//'
            exit 0
            ;;
        *)
            echo "sync-upstream: unknown argument: $arg" >&2
            echo "sync-upstream: use --report-only, or --help" >&2
            exit 2
            ;;
    esac
done

# Work from the top of this checkout, wherever the script is started.
ROOT=$(git -C "$(dirname "$0")" rev-parse --show-toplevel)
cd "$ROOT"

START_BRANCH=$(git rev-parse --abbrev-ref HEAD)

say() {
    printf '%s\n' "$*"
}

fail() {
    printf 'sync-upstream: %s\n' "$*" >&2
    exit 1
}

# 1. Add the remote if it is missing, then fetch it.
if ! git remote get-url "$UPSTREAM_REMOTE" >/dev/null 2>&1; then
    say "Adding remote $UPSTREAM_REMOTE -> $UPSTREAM_URL"
    git remote add "$UPSTREAM_REMOTE" "$UPSTREAM_URL"
fi

say "Fetching $UPSTREAM_REMOTE ($(git remote get-url "$UPSTREAM_REMOTE")) ..."
git fetch "$UPSTREAM_REMOTE" --prune

git rev-parse --verify --quiet "refs/remotes/$UPSTREAM_REMOTE/$UPSTREAM_BRANCH" >/dev/null ||
    fail "the remote $UPSTREAM_REMOTE has no branch $UPSTREAM_BRANCH"
git rev-parse --verify --quiet "refs/heads/$BASE_BRANCH" >/dev/null ||
    fail "this checkout has no local branch $BASE_BRANCH"

INCOMING="$UPSTREAM_REMOTE/$UPSTREAM_BRANCH"
BEHIND=$(git rev-list --count "$BASE_BRANCH..$INCOMING")
AHEAD=$(git rev-list --count "$INCOMING..$BASE_BRANCH")

# 3. Stop if the working tree has local changes.
if [ "$REPORT_ONLY" -eq 0 ]; then
    if [ -n "$(git status --porcelain)" ]; then
        say ""
        say "sync-upstream: stopped. The working tree has local changes:"
        git status --short >&2
        say "" >&2
        say "Commit them, stash them (git stash push), or discard them, then run the script again." >&2
        exit 1
    fi

    if [ -f "$(git rev-parse --git-dir)/MERGE_HEAD" ]; then
        fail "a merge is already in progress. Finish it with 'git commit', or stop it with 'git merge --abort'."
    fi
fi

# 2. Report the divergence.
say ""
say "Divergence: $BASE_BRANCH vs $INCOMING"
say "  behind: $BEHIND commit(s) to bring in"
say "  ahead:  $AHEAD commit(s) that $INCOMING does not have"
say ""

if [ "$BEHIND" -eq 0 ]; then
    say "Nothing to bring in: $BASE_BRANCH already has every commit of $INCOMING."

    if [ "$REPORT_ONLY" -eq 0 ]; then
        say "No branch and no merge were made."
    fi

    exit 0
fi

say "Incoming commits (newest first), $BEHIND in all:"

if [ "$MAX_SUBJECTS" -eq 0 ] || [ "$MAX_SUBJECTS" -ge "$BEHIND" ]; then
    git log --format='  %h %s' "$BASE_BRANCH..$INCOMING"
else
    git log --max-count="$MAX_SUBJECTS" --format='  %h %s' "$BASE_BRANCH..$INCOMING"
    say "  ... and $((BEHIND - MAX_SUBJECTS)) more (set MAX_SUBJECTS=0 to list them all)"
fi

if [ "$REPORT_ONLY" -eq 1 ]; then
    say ""
    say "Report only: no branch was made, nothing was merged."
    exit 0
fi

# 4. Create the sync branch at the base branch, and switch to it.
BRANCH="sync/upstream-$(date +%Y-%m-%d)"
say ""

if git rev-parse --verify --quiet "refs/heads/$BRANCH" >/dev/null; then
    fail "branch $BRANCH already exists. Delete it (git branch -D $BRANCH), or use it as it is, then run the script again."
fi

git switch --no-track --create "$BRANCH" "$BASE_BRANCH"
say "On branch $BRANCH (started at $BASE_BRANCH, which did not change)."

# 5. Merge upstream into the new branch. 6. Stop on a conflict.
say ""
say "Merging $INCOMING into $BRANCH ..."

if ! git merge --no-ff --no-edit "$INCOMING"; then
    CONFLICTED=$(git diff --name-only --diff-filter=U)

    say "" >&2

    if [ -n "$CONFLICTED" ]; then
        say "sync-upstream: stopped on a merge conflict." >&2
        say "" >&2
        say "These files have both sides:" >&2
        printf '  %s\n' "$CONFLICTED" >&2
        say "" >&2
        say "To resolve them:" >&2
        say "  1. Open each file and keep both sides where they belong." >&2
        say "  2. Run: git add <file>" >&2
        say "  3. Run the checks: npm run check, npm run lint, npm test" >&2
        say "  4. Run: git commit --no-edit" >&2
        say "" >&2
        say "To give up: git merge --abort, then git switch $START_BRANCH" >&2
        say "Nothing was pushed. $BASE_BRANCH did not change." >&2
    else
        say "sync-upstream: the merge did not finish, and no file has a conflict." >&2
        say "Read the message above. To give up: git merge --abort" >&2
        say "Then: git switch $START_BRANCH" >&2
        say "Nothing was pushed. $BASE_BRANCH did not change." >&2
    fi

    exit 1
fi

say ""
say "The merge finished with no conflict. Branch $BRANCH is ready."
say ""
say "Next steps (see docs/upstream-sync.md):"
say "  1. Run the checks: npm run check, npm run lint, npm test"
say "  2. Push the branch yourself, by hand: git push -u origin $BRANCH"
say "  3. Open a pull request from $BRANCH into main."
say ""
say "Nothing was pushed. $BASE_BRANCH did not change."
say "Was on branch $START_BRANCH before this run."
