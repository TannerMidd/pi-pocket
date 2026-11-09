/**
 * Which service holds the repository of a folder: GitLab or GitHub. The folder's `origin` remote
 * says so, and only `origin` counts: it is what `git push` uses, so a second remote (a fork's
 * `upstream`, a mirror) stays out of the answer. GitLab hosts are `gitlab.com` and the one
 * `GITLAB_HOST` names; every other host is GitHub.
 *
 * Commands run in the folder after this, so they resolve the rest themselves: `glab` uses the
 * project of its working directory, and `gh` uses the remote there.
 */
import { repoArgs } from "./github.ts";
import { originRepo } from "./github.ts";

export type Provider = "github" | "gitlab";

/** The GitLab host this environment is signed in to: `GITLAB_HOST`, or gitlab.com. */
export function gitlabHost(): string {
    return (process.env.GITLAB_HOST ?? "").trim().toLowerCase() || "gitlab.com";
}

/** Whether `host` is a GitLab host: gitlab.com, or the one `GITLAB_HOST` names. */
export function isGitlabHost(host: string | undefined): boolean {
    return (host ?? "").trim().toLowerCase() === gitlabHost();
}

/** The provider of a repository named `host/owner/name`, or `owner/name` for github.com. */
export function providerOfRepo(repo: string): Provider {
    return isGitlabHost(repoArgs(repo).host) ? "gitlab" : "github";
}

/** The provider of a folder's repository, from its `origin` remote; undefined outside a repository. */
export async function providerOfFolder(folder: string): Promise<Provider | undefined> {
    const repo = await originRepo(folder);

    return repo === undefined ? undefined : providerOfRepo(repo);
}

/** Whether a name or an address names a GitLab host. */
export function looksGitlab(text: string): boolean {
    const host = /^(?:https?|ssh):\/\/(?:[^@/\s]+@)?([^:/\s]+)/i.exec(text.trim())?.[1];

    return isGitlabHost(host);
}
