/**
 * The extension gallery: find drop-ins and themes other people wrote in a reviewed index, install them (drop-ins off),
 * read their code, ask Pi to review it, update them with a diff, remove them, and share your own; it sends GitHub a
 * token for a private index, its GitHub token setting or, while that is empty, the GitHub CLI's (gh auth token). Its
 * routes are the owner's alone; the web app shows it in Menu → Extensions and as the launcher's Find extensions
 * (`gallery.ts` does the work). The token goes only to GitHub's hosts (`gallery/fetch.ts`).
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { defineExtension } from "@earendil-works/pi-durable";
import { HttpError } from "../errors.ts";
import type { ExtensionWeb, PocketHost, WebHandler, WebRequest } from "../host.ts";

/**
 * An extension's name in the index, as a route's `:name` (`NAME` in `gallery/entry.ts`). Kept here rather than imported:
 * this module also loads into a running server from before the gallery, until its restart, whose `reload.ts` lacks what
 * `entry.ts` imports.
 */
const NAME = /^[a-z0-9][a-z0-9_-]{1,63}$/;

/** A theme's id, as a route's `:id` (`THEME_ID` in `themes/format.ts`). */
const THEME_ID = /^[a-z0-9][a-z0-9-]{1,47}$/;
/** A drop-in's module file, as a route's `:file`. */
const FILE = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,99}\.ts$/;
/** How long the token that `gh auth token` gave is used before it is asked again. */
const GH_TOKEN_MS = 10 * 60 * 1000;
/** How long no token (no `gh`, no sign-in, no answer) stands before `gh` is asked again: a sign-in counts soon. */
const GH_MISS_MS = 30 * 1000;
const run = promisify(execFile);

/**
 * Ask the GitHub CLI for github.com's token: `--hostname` keeps `GH_HOST` (an Enterprise server) from giving that
 * server's token, which would then go to github.com. Its output, or undefined when it fails or takes over 5 seconds.
 */
const askGh = (): Promise<string | undefined> =>
    run("gh", ["auth", "token", "--hostname", "github.com"], {
        timeout: 5000,
        windowsHide: true,
        // As core's `runGh` (github.ts): nobody is there to answer a prompt.
        env: { ...process.env, GH_PROMPT_DISABLED: "1", GH_NO_UPDATE_NOTIFIER: "1" },
    }).then(
        ({ stdout }) => stdout,
        () => undefined,
    );

/**
 * The token of the GitHub CLI's account on github.com (`gh auth token --hostname github.com`), or undefined: no `gh`,
 * no sign-in, or no answer within 5 seconds. A token is kept for `GH_TOKEN_MS`, no token for `GH_MISS_MS` only; asked
 * once at a time, and never while the server starts. `found` hears each new token, to hide it.
 */
function ghToken(found: (token: string) => void): () => Promise<string | undefined> {
    let kept: { token: string | undefined; until: number } | undefined;
    let asking: Promise<string | undefined> | undefined;

    return () => {
        if (kept !== undefined && Date.now() < kept.until) {
            return Promise.resolve(kept.token);
        }

        asking ??= askGh()
            .then(
                (stdout) => /^[\w-]{20,255}$/.exec(stdout?.trim() ?? "")?.[0],
                () => undefined,
            )
            .then((token) => {
                if (token !== undefined && token !== kept?.token) {
                    found(token);
                }

                kept = {
                    token,
                    until: Date.now() + (token === undefined ? GH_MISS_MS : GH_TOKEN_MS),
                };
                asking = undefined;

                return token;
            });

        return asking;
    };
}

/** How often the index is read again while extensions from it are installed, so a revoked one is told soon. */
const CHECK_MS = 12 * 60 * 60 * 1000;

export default function createGallery(host: PocketHost, web: ExtensionWeb) {
    const gallery = (host as Partial<PocketHost>).gallery;

    if (gallery === undefined) {
        // A server from before the gallery: its next start has it.
        web.route("GET", "index", () => {
            throw web.error(503, "Restart the server (menu → Restart server) to use the gallery");
        });

        return defineExtension({ name: "pocket-gallery" });
    }

    // A GitHub token, for a private index and private extension repositories. A secret: it stays on the server, and
    // goes only to GitHub's hosts (`gallery/fetch.ts`). A server from before it reads public ones only.
    if (typeof gallery.useGithubToken === "function") {
        web.settings([
            {
                name: "githubToken",
                label: "GitHub token",
                description:
                    "Only for a private index or private extension repositories: a fine-grained token that reads their contents is enough. Empty: the GitHub CLI's token (gh auth token), when gh is signed in. It goes only to GitHub.",
                type: "text",
                secret: true,
                default: "",
            },
        ]);
        // gh's token is no setting, so core does not hide it: hide each one, for as long as the module runs.
        const hidden: (() => void)[] = [];
        const fromGh = ghToken((token) => {
            if (typeof host.hide === "function") {
                hidden.push(host.hide({ value: token, label: "GitHub token from gh" }));
            }
        });

        web.onDispose(() => hidden.splice(0).forEach((stop) => stop()));

        // The setting first; else the GitHub CLI's.
        web.onDispose(
            gallery.useGithubToken(
                async () => String(web.setting("githubToken") ?? "").trim() || (await fromGh()),
            ),
        );
    }

    /** The gallery's errors as they are, to the owner: they say what went wrong, and name nothing secret. */
    const handle =
        (run: (request: WebRequest) => unknown): WebHandler =>
        async (request) => {
            try {
                return await run(request);
            } catch (error) {
                if (error instanceof HttpError) {
                    throw web.error(error.status, error.message);
                }

                throw error;
            }
        };

    const name = (request: WebRequest) => {
        const value = request.params.name ?? "";

        if (!NAME.test(value)) {
            throw web.error(400, "That is not the name of an extension in the gallery");
        }

        return value;
    };

    web.route(
        "GET",
        "index",
        handle(({ query }) => gallery.listing(query.get("refresh") === "1")),
    );
    web.route(
        "GET",
        "installed",
        handle(() => gallery.installed()),
    );
    web.route(
        "GET",
        "reach",
        handle(() => {
            if ((gallery as Partial<typeof gallery>).reach === undefined) {
                throw web.error(
                    503,
                    "Restart the server (menu → Restart server) to see what extensions reach",
                );
            }

            return gallery.reach();
        }),
    );
    web.route(
        "GET",
        "source/:name",
        handle((request) => gallery.source(name(request), request.signal)),
    );
    web.route(
        "POST",
        "install/:name",
        handle((request) => gallery.install(name(request), request.body.pin, request.signal)),
    );
    web.route(
        "GET",
        "update/:name",
        handle((request) => gallery.updatePreview(name(request), request.signal)),
    );
    web.route(
        "POST",
        "update/:name",
        handle((request) =>
            gallery.update(name(request), request.body.pin, request.body.enabled, request.signal),
        ),
    );
    web.route(
        "POST",
        "uninstall/:name",
        handle((request) => gallery.uninstall(request.user, name(request))),
    );
    web.route(
        "GET",
        "review/:name",
        handle((request) => gallery.review(name(request))),
    );
    web.route(
        "GET",
        "share/:file",
        handle((request) => {
            const file = request.params.file ?? "";

            if (!FILE.test(file)) {
                throw web.error(400, "That is not a drop-in's module file");
            }

            return gallery.share(file);
        }),
    );
    web.route(
        "GET",
        "share-theme/:id",
        handle((request) => {
            const id = request.params.id ?? "";

            if (!THEME_ID.test(id)) {
                throw web.error(400, "That is not a theme's id");
            }

            return gallery.shareTheme(id);
        }),
    );
    web.route(
        "GET",
        "settings",
        handle(() => gallery.settings()),
    );
    web.route(
        "POST",
        "settings",
        handle(({ body }) => gallery.setIndex(body.index)),
    );

    // Revoked versions: look again a minute after the start, then twice a day. Nothing is read with none installed.
    const look = () => void gallery.check().catch(() => {});
    const first = setTimeout(look, 60_000);
    const every = setInterval(look, CHECK_MS);

    first.unref();
    every.unref();
    web.onDispose(() => {
        clearTimeout(first);
        clearInterval(every);
    });

    return defineExtension({ name: "pocket-gallery" });
}
