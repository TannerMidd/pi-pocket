# Bring upstream changes into this fork

This checkout is a fork of [TannerMidd/pi-pocket](https://github.com/TannerMidd/pi-pocket). The remote `origin` is the fork (`git@github.com:gh-PonyM/pi-pocket.git`). The remote `upstream` is the original repository (`https://github.com/TannerMidd/pi-pocket.git`).

The script `scripts/sync-upstream.sh` brings the upstream commits into the fork on a branch of their own. It does not push, and it does not change `main`. A person merges the work into `main` through a pull request.

## The 6 steps

1. **Run the script.** From the top of the checkout:

    ```bash
    scripts/sync-upstream.sh
    ```

    The script adds the remote `upstream` if it is missing, and runs `git fetch upstream --prune`. It prints how many commits `main` is behind and ahead of `upstream/main`, and the subjects of the incoming commits. It stops if the working tree has local changes. Then it makes the branch `sync/upstream-<date>` at `main`, switches to it, and merges `upstream/main`. To see the report only, run `scripts/sync-upstream.sh --report-only`: this makes no branch and does no merge.

2. **Resolve the conflicts.** If the merge has conflicts, the script stops and names the files. Open each file and keep both sides where they belong. Then run `git add <file>` and `git commit --no-edit`. To give up, run `git merge --abort` and then `git switch main`.

3. **Run the project checks.** In branch `sync/upstream-<date>`, run these commands (from `package.json` and `AGENTS.md`):

    ```bash
    npm run check
    npm run lint
    npm test
    ```

    Run `npm install` first if `package.json` or `package-lock.json` came from upstream. Fix what the checks report, and commit the fixes on the branch.

4. **Open a pull request.** Push the branch, and open a pull request into `main`:

    ```bash
    git push -u origin sync/upstream-<date>
    gh pr create --base main --head sync/upstream-<date>
    ```

5. **Review.** Read the diff of the pull request. Look for the fork's own changes that upstream changed too: the `docker/` files, the entrypoint, the watches and GitLab tools, and the models. Check that the checks are green.

6. **Merge.** Merge the pull request into `main`. Delete the branch `sync/upstream-<date>` after the merge.

## What the script does, in its order

1. Adds the remote `upstream` if it is missing.
2. Runs `git fetch upstream --prune`.
3. Stops if the working tree has local changes.
4. Makes the branch `sync/upstream-<date>` at `main`, and switches to it.
5. Merges `upstream/main` into the branch.
6. Stops on a merge conflict, names the files, and says how to resolve them or stop the merge.

Settings for the script, as environment values: `UPSTREAM_REMOTE` (default `upstream`), `UPSTREAM_URL`, `UPSTREAM_BRANCH` (default `main`), `BASE_BRANCH` (default `main`), and `MAX_SUBJECTS` (default 20; 0 lists every incoming subject).

## Scheduled sync

A scheduled run does steps 1 to 4 for a person, without a person at the keyboard. It uses the main checkout, `/home/node/Repos/pi-pocket`, on branch `main`, and it does not use a worktree.

The scheduled agent does these steps:

1. Runs `scripts/sync-upstream.sh` in the main checkout. The checkout must have no local changes: the script stops if it has changes, and it stops if Git has no `user.name` and `user.email`.
2. Resolves the conflicts that the merge reports in branch `sync/upstream-<date>`. It runs `git add <file>` and `git commit --no-edit`.
3. Runs the checks: `npm run check`, `npm run lint`, and `npm test`. It commits the fixes on the branch.
4. Pushes the branch to `origin`, and opens a pull request into `main` with `gh pr create`.

A person merges the pull request. The scheduled run never merges into `main`, and it never pushes `main`.
